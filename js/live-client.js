/* =============================================================================
 * live-client.js — Klien protokol Gemini Live API (BidiGenerateContent, WSS)
 * -----------------------------------------------------------------------------
 * Protokol (raw WebSocket, tanpa SDK):
 *   client → server : { setup: {... } } lalu { realtimeInput: { audio|text } }
 *   server → client : { setupComplete } | { serverContent } | { goAway }
 *                     | { toolCall } | { sessionResumptionUpdate } | { error }
 *
 * Audio: masuk = PCM16 LE mono 16 kHz (base64), keluar = PCM16 LE mono 24 kHz.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});

  var STATE = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    READY: 'ready',
    CLOSING: 'closing',
    CLOSED: 'closed',
    FAILED: 'failed'
  };

  function LiveClient(handlers) {
    this.h = handlers || {};
    this.ws = null;
    this.state = STATE.IDLE;
    this.settings = null;
    this.droppedChunks = 0;

    /* Handle resumption dari server (lihat _route). Dipakai lagi di setup
     * sambungan berikutnya supaya konteks percakapan tidak hilang. */
    this.resumeHandle = null;
    this.resumeAt = 0;
    /* Nomor generasi koneksi. Event dari socket lama (yang onclose-nya datang
     * async) diabaikan supaya tidak merusak state koneksi yang baru. */
    this._gen = 0;
    this.intentionalClose = false;
    this.sawGoAway = false;
    this.lastClose = null;
    this._resumed = false;
  }

  LiveClient.prototype._emit = function (name, arg1, arg2, arg3) {
    if (typeof this.h[name] === 'function') this.h[name](arg1, arg2, arg3);
  };

  /* ------------------------------------------------------------- connect -- */

  /* opts.fresh : buang handle resumption → sesi benar-benar baru.
   *              Default (tanpa opts) = lanjutkan sesi pakai handle yang
   *              tersimpan; itulah yang dipakai saat sambung ulang. */
  LiveClient.prototype.connect = function (settings, opts) {
    var self = this;
    opts = opts || {};

    if (opts.fresh) this.resetResume();
    else this._pruneResume();

    /* Pindah koneksi: naikkan nomor generasi DAN lepas socket lama SEBELUM
     * apa pun yang bisa memicu callback. Urutan ini penting — kalau socket
     * lama ditutup lebih dulu, onclose-nya masih lolos guard dan
     * memancarkan state CLOSED, yang membuat orkestrator menganggur sesi
     * (lalu membuang handle resumption tepat sebelum setup baru dikirim →
     * konteks percakapan hilang). Dengan nomor generasi dinaikkan lebih dulu,
     * semua event socket lama diabaikan begitu saja. */
    var gen = ++this._gen;
    var prev = this.ws;
    this.ws = null;
    if (prev) {
      try {
        prev.close(1000, 'ganti koneksi');
      } catch (e) {}
    }

    this.settings = settings;
    this._searchRetried = false;
    this.sawGoAway = false;
    this.intentionalClose = false;
    this._resumed = !!this.resumeHandle;
    this.state = STATE.CONNECTING;
    this._emit('state', this.state);

    var url = GLA.wsUrl(settings.apiKey);
    var ws;
    try {
      ws = new global.WebSocket(url);
    } catch (e) {
      /* URL rusak / WebSocket diblokir total. Tetap pancarkan event 'close'
       * dengan lastClose yang lengkap — kalau tidak, orkestrator tidak tahu
       * harus mengembalikan UI ke idle dan tombol mikrofon macet di
       * "Menyiapkan". */
      this.state = STATE.FAILED;
      this.lastClose = {
        code: 0,
        reason: (e && e.message) || '',
        wasReady: false,
        intentional: false,
        timedOut: false,
        goAway: false,
        retryable: false
      };
      this._emit('state', this.state);
      this._emit(
        'error',
        fail(
          'Tidak bisa membuka koneksi WebSocket. Jika aplikasi dibuka langsung dari file (file://), buka lewat server lokal atau GitHub Pages.',
          false
        ),
        null
      );
      this._emit('close', { code: 0, reason: '' }, false, this.lastClose);
      return;
    }
    this.ws = ws;

    /* Server Gemini Live mengirim frame sebagai BINARY, bukan teks. Kalau
     * binaryType dibiarkan "blob", ev.data jadi Blob dan JSON.parse()
     * selalu gagal → semua pesan server terbuang diam-diam. */
    try {
      ws.binaryType = 'arraybuffer';
    } catch (e) {}

    var timedOut = false;
    var failTimer = setTimeout(function () {
      if (self._gen === gen && self.state === STATE.CONNECTING) {
        timedOut = true;
        try {
          ws.close();
        } catch (e) {}
      }
    }, 30000);

    ws.onopen = function () {
      if (self._gen !== gen) return;
      self._send(setupMessage(settings, self.resumeHandle));
    };

    ws.onmessage = function (ev) {
      if (self._gen !== gen) return;
      self._onFrame(ev.data);
    };

    ws.onerror = function () {
      /* detail selalu datang lewat onclose atau frame {error} */
    };

    ws.onclose = function (ev) {
      clearTimeout(failTimer);
      /* Socket lama: jangan sentuh state koneksi yang sedang berjalan. */
      if (self._gen !== gen) return;

      var wasReady = self.state === STATE.READY;
      var intentional = self.intentionalClose;
      self.ws = null;

      /* 429 + web search aktif + belum pernah dicoba tanpa search → coba sekali
       * lagi tanpa tool pencarian. Kuota googleSearch grounding di Live API
       * terpisah dari kuota model (tidak selalu terlihat di dashboard), jadi
       * koneksi berhak gagal meski kuota utama masih lega. Kalau retry sukses,
       * berarti benar batas "Google Search grounding" yang kena, dan sesi tetap
       * jalan (search dimatikan untuk sesi ini saja, bukan setting permanen). */
      var reason = (ev && ev.reason) || '';
      var quotaRejected = !wasReady && !intentional && isQuotaReason(reason);
      if (
        quotaRejected &&
        self.settings &&
        GLA.searchEnabled(self.settings.searchMode) &&
        !self._searchRetried
      ) {
        self._searchRetried = true;
        var revised = cloneSettings(self.settings);
        revised.searchMode = 'off';
        /* Sesi tanpa search tidak bisa mewarisi sesi yang memakai tool
         * search → jangan pakai handle resumption di sini. */
        self.resetResume();
        self._emit('searchFallback');
        self.connect(revised);
        return;
      }

      /* CLOSED hanya untuk penutupan yang benar-benar diminta. Socket yang
       * ditutup server (goAway, rotasi, atau masalah jaringan) juga kode 1000
       * dan itu HARUS diperlakukan sebagai kegagalan supaya orkestrator
       * menyambung ulang — inilah penyebab sesi hilang sebelum 15 menit. */
      if (intentional) {
        self.state = STATE.CLOSED;
      } else {
        self.state = STATE.FAILED;
      }

      self.lastClose = {
        code: ev ? ev.code : 0,
        reason: reason,
        wasReady: wasReady,
        intentional: intentional,
        timedOut: timedOut,
        goAway: self.sawGoAway
      };

      self._emit('state', self.state);
      if (self.state === STATE.FAILED) {
        var err = describeClose(ev, wasReady, self.settings, timedOut, self.sawGoAway);
        /* retryable = layak disambung ulang. Dipakai app.js supaya sesi yang
         * kehabisan handle / gagal connect tidak ikut mencoba terus-menerus. */
        self.lastClose.retryable = err.retryable === true;
        self._emit('error', err, ev);
      }
      self._emit('close', ev, wasReady, self.lastClose);
    };
  };

  function cloneSettings(s) {
    var out = {};
    for (var k in s) {
      if (Object.prototype.hasOwnProperty.call(s, k)) out[k] = s[k];
    }
    return out;
  }

  /* Buang handle kalau sudah basi supaya server tidak ditolak dengan
   * handle yang sudah kedaluwarsa (Server: token valid 2 jam). */
  LiveClient.prototype._pruneResume = function () {
    if (this.resumeHandle && Date.now() - this.resumeAt > GLA.RECONNECT.resumptionTtlMs) {
      this.resetResume();
    }
  };

  LiveClient.prototype.resetResume = function () {
    this.resumeHandle = null;
    this.resumeAt = 0;
  };

  /* Terima frame teks maupun binary (server memakai keduanya). */
  LiveClient.prototype._onFrame = function (data) {
    var self = this;

    function handleText(text) {
      if (!text) return;
      var msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        return; /* frame binary yang bukan JSON: abaikan */
      }
      self._route(msg);
    }

    if (typeof data === 'string') return handleText(data);
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      return handleText(new TextDecoder('utf-8').decode(data));
    }
    if (data && typeof data.text === 'function') {
      /* fallback: binaryType tidak didukung browser ini → Blob */
      data.text().then(handleText, function () {});
    }
  };

  /* --------------------------------------------------------------- setup -- */

  function setupMessage(s, resumeHandle) {
    var vad = {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity: GLA.VAD.automaticActivityDetection.startOfSpeechSensitivity,
        prefixPaddingMs: GLA.VAD.automaticActivityDetection.prefixPaddingMs,
        silenceDurationMs:
          s.vadSensitivity === 'responsive' ? 350 : GLA.VAD.automaticActivityDetection.silenceDurationMs
      },
      activityHandling: GLA.VAD.activityHandling
    };

    var generationConfig = { responseModalities: ['AUDIO'] };
    if (s.voice) {
      generationConfig.speechConfig = {
        voiceConfig: { prebuiltVoiceConfig: { voiceName: s.voice } }
      };
    }

    var setup = {
      model: 'models/' + s.model,
      generationConfig: generationConfig,
      systemInstruction: {
        parts: [{ text: GLA.buildSystemInstruction(s) }]
      },
      realtimeInputConfig: vad,
      inputAudioTranscription: {},
      outputAudioTranscription: {},

      /* WAJIB ada, bahkan pada sambungan pertama. Field ini yang menyuruh
       * server mengirim `sessionResumptionUpdate{newHandle,resumable}` secara
       * berkala. Tanpa field ini server TIDAK PERNAH mengirim handle, dan saat
       * socket ditutup (batas durasi per koneksi, rotasi, atau drop jaringan)
       * konteks percakapan hilang permanen — itulah penyebab sesi terputus
       * sebelum 15 menit. Isi `handle` hanya pada sambungan lanjutan supaya
       * konteks sebelumnya diteruskan; kosong = sesi baru yang tetap resummable. */
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {}
    };

    /* Grounding with Google Search. Penanganannya sepenuhnya di server:
     * model mencari sendiri, kita tidak perlu menjalankan tool apa pun.
     * Field `tools` berada di level setup, BUKAN di dalam generationConfig. */
    if (GLA.searchEnabled(s.searchMode)) {
      setup.tools = [{ googleSearch: {} }];
    }

    return { setup: setup };
  }

  /* -------------------------------------------------------------- routing - */

  LiveClient.prototype._route = function (msg) {
    if (msg.setupComplete) {
      this.state = STATE.READY;
      this._emit('state', this.state);
      /* argumen: true bila sambungan ini melanjutkan sesi sebelumnya. */
      this._emit('ready', this._resumed === true);
      return;
    }

    if (msg.error) {
      this._emit('error', describeApiError(msg.error, this.settings), null);
      return;
    }

    if (msg.goAway) {
      /* Peringatan server: socket akan ditutup. Jangan tunggu — pindahkan
       * koneksi lebih dulu (dengan resumption) supaya konteks aman. */
      this.sawGoAway = true;
      this._emit('goAway', msg.goAway.timeLeft || 'sebentar');
      return;
    }

    if (msg.sessionResumptionUpdate) {
      var up = msg.sessionResumptionUpdate;
      /* Hanya adopsi handle yang ditandai resumable. Server juga mengirim
       * checkpoint sementara dengan resumable=false / newHandle kosong —
       * memakai yang itu akan me-resume ke state yang tidak valid. */
      if (up && up.resumable === true && up.newHandle) {
        this.resumeHandle = up.newHandle;
        this.resumeAt = Date.now();
      }
      this._emit('resumable', up);
      return;
    }

    if (msg.toolCall || msg.toolCallCancellation) {
      /* Tidak ada function declaration yang terdaftar, jadi toolCall hanya
       * mungkin muncul dari googleSearch yang dieksekusi server. Abaikan saja
       * supaya tidak memblokir routing serverContent di frame yang sama. */
      this._emit('debug', JSON.stringify(msg).slice(0, 300));
    }

    /* Metadata hasil pencarian web (grounding). Struktur field-nya mengikuti
     * Grounding with Google Search: webSearchQueries + groundingChunks[].web
     * (uri + title). Datanya hanya informatif; jawaban tetap diucapkan model. */
    var grounding = (msg.groundingMetadata || (msg.serverContent || {}).groundingMetadata);
    if (grounding) {
      var sources = readSources(grounding);
      if (sources.length) this._emit('sources', sources, grounding.webSearchQueries || []);
    }

    var sc = msg.serverContent;
    if (!sc) return;

    if (sc.inputTranscription && sc.inputTranscription.text) {
      this._emit('userText', sc.inputTranscription.text);
    }

    if (sc.outputTranscription && sc.outputTranscription.text) {
      this._emit('modelText', sc.outputTranscription.text);
    }

    if (sc.modelTurn && sc.modelTurn.parts) {
      var parts = sc.modelTurn.parts;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        if (p.thought) continue;
        var inline = p.inlineData || p.inline_data;
        if (inline && inline.data) {
          this._emit('modelAudio', b64ToInt16(inline.data));
        }
      }
    }

    if (sc.interrupted) this._emit('interrupted');
    if (sc.turnComplete) this._emit('turnComplete');
  };

  /* Ambil daftar sumber dari groundingMetadata; buang yang tanpa uri dan
   * dedup supaya kartu sumber tidak berduplikat. */
  function readSources(g) {
    var out = [];
    var seen = {};
    var chunks = g.groundingChunks || g.grounding_chunks || [];
    for (var i = 0; i < chunks.length; i++) {
      var web = chunks[i] && (chunks[i].web || chunks[i].retrievedContext);
      if (!web) continue;
      var uri = web.uri || web.url || '';
      if (!uri || seen[uri]) continue;
      seen[uri] = true;
      out.push({ uri: uri, title: web.title || uri });
      if (out.length >= 8) break;
    }
    return out;
  }

  function b64ToInt16(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Int16Array(bytes.buffer);
  }

  /* ----------------------------------------------------------------- send - */

  LiveClient.prototype._send = function (obj) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      return false;
    }
  };

  /* Dipanggil ~5×/detik dari audio engine. Backpressure: jangan menumpuk
   * buffer WebSocket, lebih baik dropping frame daripada adds latency.
   * Wait: baru kirim setelah server menyalin setup (state READY). Audio yang
   * dikirim sebelum setupComplete ditolak server sehingga awal bicara user
   * bisa hilang. */
  LiveClient.prototype.sendAudio = function (int16) {
    if (!this.ws || this.ws.readyState !== 1) return false;
    if (this.state !== STATE.READY) {
      this.droppedChunks++;
      return false;
    }
    if (this.ws.bufferedAmount > GLA.AUDIO.input.maxBufferedBytes) {
      this.droppedChunks++;
      return false;
    }
    return this._send({
      realtimeInput: {
        audio: { data: GLA.DSP.toBase64(int16), mimeType: GLA.AUDIO.input.mimeType }
      }
    });
  };

  LiveClient.prototype.sendText = function (text) {
    if (this.state !== STATE.READY) return false;
    return this._send({ realtimeInput: { text: text } });
  };

  /* ---------------------------------------------------------------- close - */

  LiveClient.prototype.close = function (code, reason) {
    this.intentionalClose = true;
    if (!this.ws) {
      this.state = STATE.CLOSED;
      this._emit('state', this.state);
      return;
    }
    this.state = STATE.CLOSING;
    this._emit('state', this.state);
    try {
      this.ws.close(code || 1000, reason || 'user');
    } catch (e) {
      this.ws = null;
      this.state = STATE.CLOSED;
      this._emit('state', this.state);
    }
  };

  /* Tutup socket sekarang agar orchestrator menyambung ulang dengan
   * resumption — dipakai saat batas durasi per koneksi tercapai. Berbeda dari
   * close(): ini BUKAN akhir sesi, jadi tidak ditandai intentional dan state
   * tidak diubah (orkestrator yang menyambung lagi). */
  LiveClient.prototype.rotate = function (reason) {
    if (!this.ws) return false;
    this.intentionalClose = false;
    this.sawGoAway = true;
    try {
      this.ws.close(1000, reason || 'rotasi');
    } catch (e) {
      return false;
    }
    return true;
  };

  /* --------------------------------------------------------------- errors - */

  /* Error dengan penanda `retryable`: orkestrator (app.js) hanya menyambung
   * ulang untuk error yang layak dicoba lagi. Key salah / kuota habis bukan
   * masalah sesaat, jadi mencoba lagi hanya membuang kuota dan membuat loop. */
  function fail(message, retryable) {
    var e = new Error(message);
    e.retryable = !!retryable;
    return e;
  }

  function describeApiError(err, settings) {
    var msg = (err && err.message) || 'Kesalahan tidak diketahui dari server.';
    var status = (err && err.status) || '';
    var code = err && err.code;

    if (code === 401 || status.indexOf('UNAUTHENTICATED') === 0) {
      return fail('API key ditolak. Periksa kembali key di pengaturan.', false);
    }
    if (code === 403 || status.indexOf('PERMISSION_DENIED') === 0) {
      return fail(
        'API key tidak punya izin. Pastikan Generative Language API aktif di project key tersebut.',
        false
      );
    }
    if (code === 429 || status.indexOf('RESOURCE_EXHAUSTED') === 0) {
      return quotaExceededError(msg, settings);
    }
    if (code === 404) {
      return fail(
        'Model "' +
          (currentModelLabel(msg) || 'yang dipilih') +
          '" tidak tersedia untuk API key ini. Coba model lain di pengaturan.',
        false
      );
    }
    if (code === 400 || status.indexOf('INVALID_ARGUMENT') === 0) {
      if (/voice/i.test(msg)) {
        return fail(
          'Suara yang dipilih tidak didukung model ini. Buka pengaturan lalu pilih "Otomatis".',
          false
        );
      }
      if (/tool|google_?search|grounding/i.test(msg)) {
        return fail(
          'Model yang dipilih tidak menerima tool pencarian web. Matikan "Web search" di pengaturan, atau pilih model Live lain.',
          false
        );
      }
      return fail('Permintaan ditolak server: ' + msg, false);
    }
    /* Error di tengah sesi (server internal / overloaded) sering ikut menutup
     * socket; resumption biasanya memulihkannya. */
    return fail('Server Live API: ' + msg, true);
  }

  function currentModelLabel(msg) {
    var m = /models\/([\w.\-]+)/.exec(msg || '');
    return m ? m[1] : '';
  }

  /* Pesan 429/RESOURCE_EXHAUSTED. Pengalaman Kubernetes nyata (lihat catatan
   * di editor): error ini kerap BUKAN kuota token model yang habis, tapi batas
   * terpisah dari Google Search grounding (search tool), yang tidak selalu
   * tampil di dashboard kuota utama. Beri user langkah konkret, bukan pesan
   * generik. */
  function quotaExceededError(msg, settings) {
    var searchOn = !!settings && GLA.searchEnabled(settings.searchMode);
    var lines = [
      'Server menolak koneksi karena kuota (429).',
      '',
      'Pesan server: ' + msg
    ];
    if (searchOn) {
      lines.push(
        '',
        'Web search (Google Search grounding) aktif. 429 di sini sering bukan ' +
          'kuota token model yang habis, melainkan batas kuota pencarian web yang ' +
          'terpisah dan tidak selalu terlihat di dashboard kuota utama.'
      );
    }
    lines.push(
      '',
      'Coba:',
      '1. Tunggu beberapa saat lalu sambungkan lagi (rate limit biasanya pulih dalam menit).',
      searchOn
        ? '2. Matikan "Web search" dulu di pengaturan lalu coba sambung — kalau koneksi berhasil, berarti batas pencarian web yang kena.'
        : '2. Jika kuota di dashboard masih lega, periksa model yang dipilih dan tier billing project.',
      '3. Cek kuota & billing project di aistudio.google.com → Usage / Rate limits.'
    );
    return fail(lines.join('\n'), false);
  }

  function isQuotaReason(reason) {
    return /quota/i.test(reason) || /RESOURCE_EXHAUSTED/i.test(reason);
  }

  /* Retryable hanya untuk kegagalan sesaat:
   *   - timeout handshake  → jaringan lambat
   *   - socket belum siap  → jaringan/WSS diblokir, sering sementara
   *   - sesi sudah jalan lalu putus / goAway → resumption + backoff
   * Key salah, kuota habis, dan parameter setup salah TIDAK retryable. */  function describeClose(ev, wasReady, settings, timedOut, sawGoAway) {
    var reason = (ev && ev.reason) || '';
    if (timedOut) {
      return fail(
        'Server tidak menjawab dalam 30 detik. Periksa koneksi internet, lalu coba lagi.',
        true
      );
    }
    if (!wasReady) {
      if (isQuotaReason(reason)) {
        return quotaExceededError(reason, settings);
      }
      if (reason) return fail('Koneksi ditolak: ' + reason, false);
      return fail(
        'Koneksi ke Live API gagal sebelum sesi siap. Periksa API key, koneksi internet, dan apakah akses WebSocket diblokir jaringan.',
        true
      );
    }
    if (sawGoAway) {
      return fail(
        'Server menutup sesi karena batas durasi koneksi' +
          (reason ? ' (' + reason + ')' : '') +
          '. Menyambung ulang dan melanjutkan percakapan…',
        true
      );
    }
    if (reason) return fail('Sesi terputus: ' + reason + '. Menyambung ulang…', true);
    return fail('Sesi terputus (kode ' + (ev ? ev.code : '?') + '). Menyambung ulang…', true);
  }

  GLA.LiveClient = LiveClient;
  GLA.LIVE_STATE = STATE;
})(typeof window !== 'undefined' ? window : globalThis);
