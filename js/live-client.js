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
  }

  LiveClient.prototype._emit = function (name, arg1, arg2) {
    if (typeof this.h[name] === 'function') this.h[name](arg1, arg2);
  };

  /* ------------------------------------------------------------- connect -- */

  LiveClient.prototype.connect = function (settings) {
    var self = this;
    if (this.ws) this.close(1000, 'connect ulang');

    this.settings = settings;
    this.state = STATE.CONNECTING;
    this._emit('state', this.state);

    var url = GLA.wsUrl(settings.apiKey);
    var ws;
    try {
      ws = new global.WebSocket(url);
    } catch (e) {
      this.state = STATE.FAILED;
      this._emit('state', this.state);
      this._emit(
        'error',
        new Error(
          'Tidak bisa membuka koneksi WebSocket. Jika aplikasi dibuka langsung dari file (file://), buka lewat server lokal atau GitHub Pages.'
        )
      );
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
      if (self.state === STATE.CONNECTING) {
        timedOut = true;
        try {
          ws.close();
        } catch (e) {}
      }
    }, 30000);

    ws.onopen = function () {
      self._send(setupMessage(settings));
    };

    ws.onmessage = function (ev) {
      self._onFrame(ev.data);
    };

    ws.onerror = function () {
      /* detail selalu datang lewat onclose atau frame {error} */
    };

    ws.onclose = function (ev) {
      clearTimeout(failTimer);
      var wasReady = self.state === STATE.READY;
      self.ws = null;
      if (self.state === STATE.CLOSING || (ev.code === 1000 && !timedOut)) {
        self.state = STATE.CLOSED;
      } else {
        self.state = STATE.FAILED;
      }
      self._emit('state', self.state);
      if (self.state === STATE.FAILED) {
        self._emit('error', describeClose(ev, wasReady), ev);
      }
      self._emit('close', ev, wasReady);
    };
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

  function setupMessage(s) {
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
      outputAudioTranscription: {}
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
      this._emit('ready');
      return;
    }

    if (msg.error) {
      this._emit('error', describeApiError(msg.error), null);
      return;
    }

    if (msg.goAway) {
      this._emit('goAway', msg.goAway.timeLeft || 'sebentar');
      return;
    }

    if (msg.sessionResumptionUpdate) {
      this._emit('resumable', msg.sessionResumptionUpdate);
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

  /* --------------------------------------------------------------- errors - */

  function describeApiError(err) {
    var msg = (err && err.message) || 'Kesalahan tidak diketahui dari server.';
    var status = (err && err.status) || '';
    var code = err && err.code;

    if (code === 401 || status.indexOf('UNAUTHENTICATED') === 0) {
      return new Error('API key ditolak. Periksa kembali key di pengaturan.');
    }
    if (code === 403 || status.indexOf('PERMISSION_DENIED') === 0) {
      return new Error(
        'API key tidak punya izin. Pastikan Generative Language API aktif di project key tersebut.'
      );
    }
    if (code === 429 || status.indexOf('RESOURCE_EXHAUSTED') === 0) {
      return new Error('Kuota atau rate limit habis. Tunggu sebentar lalu coba lagi.');
    }
    if (code === 404) {
      return new Error(
        'Model "' +
          (currentModelLabel(msg) || 'yang dipilih') +
          '" tidak tersedia untuk API key ini. Coba model lain di pengaturan.'
      );
    }
    if (code === 400 || status.indexOf('INVALID_ARGUMENT') === 0) {
      if (/voice/i.test(msg)) {
        return new Error(
          'Suara yang dipilih tidak didukung model ini. Buka pengaturan lalu pilih "Otomatis".'
        );
      }
      if (/tool|google_?search|grounding/i.test(msg)) {
        return new Error(
          'Model yang dipilih tidak menerima tool pencarian web. Matikan "Web search" di pengaturan, atau pilih model Live lain.'
        );
      }
      return new Error('Permintaan ditolak server: ' + msg);
    }
    return new Error('Server Live API: ' + msg);
  }

  function currentModelLabel(msg) {
    var m = /models\/([\w.\-]+)/.exec(msg || '');
    return m ? m[1] : '';
  }

  function describeClose(ev, wasReady) {
    var reason = (ev && ev.reason) || '';
    if (!wasReady) {
      if (reason) return new Error('Koneksi ditolak: ' + reason);
      return new Error(
        'Koneksi ke Live API gagal sebelum sesi siap. Periksa API key, koneksi internet, dan apakah akses WebSocket diblokir jaringan.'
      );
    }
    if (reason) return new Error('Sesi terputus: ' + reason);
    return new Error(
      'Sesi terputus (kode ' + (ev ? ev.code : '?') + '). Mulai ulang untuk melanjutkan.'
    );
  }

  GLA.LiveClient = LiveClient;
  GLA.LIVE_STATE = STATE;
})(typeof window !== 'undefined' ? window : globalThis);
