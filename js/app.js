/* =============================================================================
 * app.js — Orkestrasi: pengaturan → sesi → transkrip → putuskan sesi
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = global.GLA;
  var UI = GLA.UI;
  var Util = GLA.Util;

  var settings = GLA.Storage.load();
  GLA._currentSettings = settings;

  var audio = new GLA.AudioEngine({
    onAudioChunk: function (int16) {
      client.sendAudio(int16);
    },
    onPlaybackLevel: function (level) {
      onAiSpeakingLevel(level);
    }
  });

  var client = new GLA.LiveClient({
    state: onStateChange,
    ready: onReady,
    userText: onUserText,
    modelText: onModelText,
    modelAudio: onModelAudio,
    sources: onSources,
    interrupted: onInterrupted,
    turnComplete: onTurnComplete,
    goAway: onGoAway,
    error: onError,
    close: onClose,
    searchFallback: function () {
      UI.toast(
        'Server menolak web search (kuota grounding). Sesi dilanjutkan tanpa Web search.',
        'warn',
        8000
      );
    }
  });

  /* ---------------------------------------------------------------- state - */

  /* Sesi live TIDAK melekat pada satu koneksi WebSocket: server menutup socket
   * secara berkala (batas durasi per koneksi, rotasi, atau drop jaringan) —
   * sering kali jauh sebelum 15 menit. Karena itu `session` punya status
   * 'reconnecting' dan sambungan boleh berganti di tengah 'live' tanpa mereset
   * transkrip:
   *   idle | loading | live | reconnecting | stopping                        */
  var session = 'idle';
  var userBuf = '';
  var aiBuf = '';
  var startedAt = 0; /* epoch awal sesi — durasi kumulatif lintas sambung ulang */
  var connStartedAt = 0; /* epoch sambungan aktif → batas 15 menit per koneksi */
  var tickTimer = null;
  var warnedLimit = false;
  var mutedByAi = false;
  var unmuteTimer = null;
  var endedByUser = false;

  /* orkestrasi sambung ulang */
  var reconnectTimer = null;
  var reconnectAttempt = 0;
  var totalReconnects = 0;
  /* True selama user masih ingin sesi hidup — mencegah event yang datang
   * terlambat (onclose dari socket lama) membangkitkan sesi lagi. */
  var wantSession = false;

  /* ------------------------------------------------------------- handlers - */

  function onStateChange(state) {
    if (state === GLA.LIVE_STATE.CONNECTING) {
      if (session !== 'reconnecting') {
        UI.setStatus('busy', 'Menghubungkan');
        UI.setStateLabel('Menyambungkan ke Gemini…');
      }
    } else if (state === GLA.LIVE_STATE.CLOSING) {
      UI.setStatus('busy', 'Mengakhiri');
    } else if (state === GLA.LIVE_STATE.CLOSED) {
      /* CLOSED di tengah reconnect = socket lama sedang dilepas, bukan akhir
       * sesi. Jangan ikut menganggur di sini atau handle resumption ikut
       * terhapus sebelum setup koneksi baru dikirim. */
      if (session !== 'idle' && session !== 'reconnecting') teardownUi();
    } else if (state === GLA.LIVE_STATE.FAILED) {
      /* Biarkan onClose yang memutuskan: error sesaat akan disambung ulang. */
    }
  }

  function onReady(isResume) {
    var fresh = !startedAt;
    session = 'live';
    connStartedAt = Date.now();
    if (fresh) startedAt = connStartedAt;
    warnedLimit = false;
    clearReconnect();

    UI.setStatus('live', 'Live');
    UI.setStateLabel(
      isResume
        ? 'Sesi dilanjutkan — assistant ingat sebelumnya. Lanjut ngobrol.'
        : 'Ngobrol bebas — spoke saja, assistant akan menjawab.'
    );
    UI.setMicMode('live');
    UI.setTimer(Date.now() - startedAt);
    /* WAJIB: timer lama dibuang dulu. Tanpa ini setiap sambung ulang
     * menambah interval baru → timer berjalan beberapa kali lipat cepat. */
    startTicker();

    if (isResume) {
      totalReconnects++;
      UI.toast(
        'Koneksi server diputus — sesi dilanjutkan tanpa kehilangan konteks.',
        'ok',
        4000
      );
    } else if (fresh) {
      UI.toast('Sesi live dimulai. Bicara apa saja.', 'ok', 4200);
    }
  }

  function onUserText(text) {
    userBuf += text;
    UI.setPartial('user', userBuf);
  }

  function onModelText(text) {
    aiBuf += text;
    UI.setPartial('ai', aiBuf);
  }

  function onModelAudio(int16) {
    /* model sudah bicara → transkrip user selesai */
    commitUser();
    audio.enqueueOutput(int16);
  }

  function onSources(sources, queries) {
    /* commitPartial dulu supaya kartu sumber menempel ke bubble yang benar:
     * groundingMetadata sering tiba setelah turnComplete. */
    commitAi();
    UI.addSources('ai', sources, queries);
    if (session === 'live' && sources.length) {
      UI.toast('Assistant memakai ' + sources.length + ' sumber web.', 'info', 3200);
    }
  }

  function onInterrupted() {
    audio.clearOutput();
    commitUser();
    commitAi('(terpotong)');
    UI.setStateLabel('Kamu menyela — assistant berhenti bicara.');
  }

  function onTurnComplete() {
    commitUser();
    commitAi();
    if (session === 'live') {
      UI.setStateLabel('Giliran kamu — spoke lagi kapan saja.');
    }
  }

  function onGoAway(timeLeft) {
    /* Server memberi tahu socket akan ditutup dalam `timeLeft`. Jangan tunggu
     * ditutup paksa — pindah koneksi sekarang dengan resumption supaya
     * konteks aman dan jeda tetap pendek. */
    UI.toast(
      'Server akan menutup koneksi dalam ' +
        timeLeft +
        '. Melanjutkan sesi di koneksi baru…',
      'warn',
      9000
    );
    scheduleReconnect(GLA.RECONNECT.goAwayDelayMs, 'Server akan menutup koneksi.');
  }

  function onError(err) {
    /* Error selama sesi berjalan hampir selalu berarti socket diputus server.
     * Kalau layak dicoba lagi, onClose yang akan menyambung ulang — cukup
     * toast peringatan, jangan kunci UI di status error. */
    var duringSession =
      session === 'live' || session === 'loading' || session === 'reconnecting';
    UI.toast(err.message, err.retryable === true ? 'warn' : 'error', 9000);
    if (duringSession) return;
    UI.setStatus('error', 'Gagal');
    UI.setStateLabel('Terjadi kesalahan. Buka Pengaturan atau coba lagi.');
  }

  function onClose(ev, wasReady, info) {
    if (!info) info = {};
    if (info.intentional) {
      if (session === 'live' && ev && ev.code === 1000 && endedByUser) {
        UI.toast('Sesi selesai.', 'ok', 2500);
      }
      return;
    }

    if (!wantSession || session === 'stopping' || session === 'idle') return;

    /* Sambung ulang hanya untuk kegagalan sesaat. Key salah / kuota habis /
     * setup ditolak sudah ditandai retryable=false oleh live-client — mencoba
     * lagi hanya membuang kuota. Untuk kasus itu kembalikan UI ke idle agar
     * tidak macet di "Menyiapkan"/"Menyambung ulang". */
    if (info.retryable !== true) {
      wantSession = false;
      session = 'idle';
      teardownUi();
      if (!wasReady) {
        UI.setStateLabel('Tidak bisa menyambung. Periksa API key & pengaturan, lalu coba lagi.');
      } else {
        UI.setStateLabel('Sesi dihentikan server. Tekan mikrofon untuk mulai lagi.');
      }
      return;
    }

    /* Kalau sesi belum pernah benar-benar hidup (connect gagal), coba sedikit
     * saja supaya user tidak menunggu lama pada koneksi yang memang salah. */
    var budget = wasReady ? GLA.RECONNECT.backoffMs.length : 2;
    if (reconnectAttempt >= budget) {
      wantSession = false;
      session = 'idle';
      teardownUi();
      UI.toast(
        'Koneksi Live API terputus dan tidak berhasil disambung ulang. Tekan mikrofon untuk coba lagi.',
        'error',
        10000
      );
      return;
    }

    scheduleReconnect();
  }

  /* ------------------------------------------------- sambung ulang (reconnect) */

  function scheduleReconnect(delayMs, reason) {
    if (!wantSession || session === 'stopping') return;
    clearReconnect();

    var i = reconnectAttempt;
    var delay = delayMs != null ? delayMs : GLA.RECONNECT.backoffMs[Math.min(i, GLA.RECONNECT.backoffMs.length - 1)];
    reconnectAttempt++;

    session = 'reconnecting';
    /* Simpan partial supaya tidak ada kalimat yang menggantung di bubble
     * "live" ketika sambungan baru mulai. */
    commitUser();
    commitAi();
    audio.clearOutput();

    UI.setStatus('busy', 'Menyambung ulang');
    UI.setMicMode('reconnecting');
    UI.setStateLabel(
      'Koneksi terputus — menyambung ulang' +
        (delay > 1500 ? ' dalam ' + Math.round(delay / 1000) + ' dtk' : '') +
        '…'
    );

    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      if (!wantSession) return;
      /* handle resumption (kalau ada) ikut di setup → konteks diteruskan. */
      client.connect(settings);
    }, delay);
  }

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, 1000);
  }

  function commitUser() {
    if (!userBuf.trim()) return;
    UI.setPartial('user', userBuf);
    UI.commitPartial('user');
    userBuf = '';
  }

  function commitAi(suffix) {
    if (!aiBuf.trim()) return;
    UI.setPartial('ai', aiBuf);
    UI.commitPartial('ai', suffix);
    aiBuf = '';
  }

  /* ---------------------------------------------------------------- timer - */

  function tick() {
    if (session !== 'live' && session !== 'reconnecting') return;
    var now = Date.now();
    /* Timer menampilkan durasi kumulatif (termasuk waktu reconnect) supaya
     * user melihat total waktu ngobrol. */
    UI.setTimer(now - startedAt);

    /* Batas 15 menit itu per KONEKSI, bukan per sesi. Jadi jangan tutup sesi:
     * pindah koneksi (resumption) dan jam server mulai dari nol lagi. */
    var connElapsed = now - connStartedAt;
    var limit = GLA.AUDIO.sessionLimitMs;
    if (!warnedLimit && connElapsed > limit - GLA.AUDIO.warnBeforeMs) {
      warnedLimit = true;
      UI.toast('Batas 15 menit per koneksi hampir habis. Sesi akan disambung otomatis.', 'warn', 8000);
    }
    if (connElapsed >= limit) {
      warnedLimit = false;
      UI.toast('Batas durasi koneksi tercapai — pindah koneksi, sesi tetap lanjut.', 'info', 6000);
      /* rotate() menutup socket tanpa menandai "permintaan user", sehingga
       * onClose menjadwalkan sambung ulang dengan resumption. */
      if (!client.rotate('batas durasi koneksi')) scheduleReconnect(0, 'rotasi');
    }
  }

  /* ----------------------------------------------------- mute saat AI bicara */

  function onAiSpeakingLevel(level) {
    var ai = level > 0;
    UI.setSpeaking(ai ? 'ai' : audio.micLevel > 0.06 ? 'user' : '');

    if (!settings.muteMicWhileSpeaking) return;
    if (ai) {
      if (unmuteTimer) {
        clearTimeout(unmuteTimer);
        unmuteTimer = null;
      }
      if (!mutedByAi) {
        mutedByAi = true;
        audio.setMuted(true);
      }
    } else if (mutedByAi) {
      if (unmuteTimer) clearTimeout(unmuteTimer);
      unmuteTimer = setTimeout(function () {
        unmuteTimer = null;
        mutedByAi = false;
        audio.setMuted(false);
      }, 400);
    }
  }

  /* ------------------------------------------------------------- lifecycle - */

  function startSession() {
    if (session !== 'idle') return;
    if (!settings.apiKey) {
      UI.openSettings();
      UI.toast('Isi API key dulu di pengaturan.', 'warn');
      return;
    }
    if (UI.isSettingsOpen()) return;

    session = 'loading';
    wantSession = true;
    endedByUser = false;
    reconnectAttempt = 0;
    totalReconnects = 0;
    startedAt = 0;
    connStartedAt = 0;
    userBuf = aiBuf = '';
    UI.setMicMode('loading');
    UI.setStatus('busy', 'Menyiapkan');
    UI.setStateLabel('Menyiapkan mikrofon…');
    UI.commitPartial('user');
    UI.commitPartial('ai');

    audio
      .prime()
      .then(function () {
        return audio.start();
      })
      .then(function (engine) {
        var badges = [engine === 'worklet' ? 'AudioWorklet' : 'ScriptProcessor (cadangan)'];
        if (GLA.searchEnabled(settings.searchMode)) badges.push('Web search');
        UI.setEngineBadge(badges.join(' · '));
        /* fresh: sesi baru → jangan pakai handle resumption sesi lama. */
        client.connect(settings, { fresh: true });
      })
      .catch(function (err) {
        session = 'idle';
        wantSession = false;
        audio.stop();
        UI.setMicMode('idle');
        UI.setStatus('error', 'Gagal');
        UI.setStateLabel('Tidak bisa memulai sesi.');
        UI.toast(err.message, 'error', 10000);
      });
  }

  function stopSession(reason) {
    if (session === 'idle' || session === 'stopping') return;
    session = 'stopping';
    /* Cancel semua percobaan sambung ulang lebih dulu, kalau tidak timer
     * reconnect yang sudah terjadwal akan membangunkan sesi lagi. */
    wantSession = false;
    clearReconnect();
    endedByUser = true;
    UI.setMicMode('ending');
    UI.setStateLabel('Mengakhiri sesi…');
    commitUser();
    commitAi();
    audio.clearOutput();
    if (reason) UI.toast(reason, 'info', 6000);
    client.close(1000, 'user');
    audio.stop();
    setTimeout(function () {
      if (session === 'stopping') {
        session = 'idle';
        teardownUi();
      }
    }, 900);
  }

  function teardownUi() {
    session = 'idle';
    wantSession = false;
    clearReconnect();
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (unmuteTimer) {
      clearTimeout(unmuteTimer);
      unmuteTimer = null;
    }
    mutedByAi = false;
    /* PENTING: audio engine mungkin masih dalam keadaan mute (dari
     * muteMicWhileSpeaking). Kalau tidak di-unmute di sini, sesi BERIKUTNYA
     * mulai dengan mikrofon mati permanen karena setMuted(true) pernah
     * dipanggil dan tidak pernah dilawan. */
    audio.setMuted(false);
    userBuf = aiBuf = '';
    startedAt = 0;
    connStartedAt = 0;
    reconnectAttempt = 0;
    client.resetResume();
    UI.setTimer(null);
    UI.setMicMode('idle');
    UI.setSpeaking('');
    UI.setStatus('idle', 'Siap');
    UI.setStateLabel('Tekan mikrofon untuk mulai ngobrol.');
  }

  /* --------------------------------------------------------------- wiring - */

  function wire() {
    UI.populateSelects();
    UI.init();
    UI.fillSettings(settings);

    document.getElementById('micBtn').addEventListener('click', function () {
      if (session === 'idle') startSession();
      else stopSession();
    });

    document.getElementById('settingsBtn').addEventListener('click', function () {
      if (session !== 'idle') stopSession();
      UI.fillSettings(settings);
      UI.openSettings();
    });

    document.getElementById('settingsCancel').addEventListener('click', function () {
      UI.closeSettings();
    });

    document.getElementById('settingsClose').addEventListener('click', function () {
      UI.closeSettings();
    });

    /* Enter di kolom mana pun tidak boleh me-reload halaman */
    document.getElementById('settingsForm').addEventListener('submit', function (e) {
      e.preventDefault();
    });

    document.getElementById('settingsSave').addEventListener('click', function () {
      var next = UI.readSettings();
      if (!next.apiKey) {
        UI.toast('API key wajib diisi.', 'warn');
        return;
      }
      settings = next;
      GLA._currentSettings = settings;
      GLA.Storage.save(settings);
      UI.closeSettings();
      UI.toast('Pengaturan disimpan.', 'ok', 2200);
    });

    document.getElementById('settingsForget').addEventListener('click', function () {
      GLA.Storage.clearKey();
      settings = GLA.Storage.load();
      GLA._currentSettings = settings;
      UI.fillSettings(settings);
      UI.toast('API key dihapus dari penyimpanan browser.', 'ok');
    });

    document.getElementById('copyBtn').addEventListener('click', function () {
      var text = UI.transcriptText();
      if (!text) {
        UI.toast('Transkrip masih kosong.', 'info');
        return;
      }
      Util.copyText(text).then(
        function () {
          UI.toast('Transkrip disalin ke clipboard.', 'ok');
        },
        function () {
          UI.toast('Gagal menyalin. Select teks transkrip secara manual.', 'warn');
        }
      );
    });

    document.getElementById('clearBtn').addEventListener('click', function () {
      UI.clearTranscript();
      userBuf = aiBuf = '';
    });

    UI.onBackdropClick(function () {
      UI.closeSettings();
    });

    document.addEventListener('keydown', function (e) {
      var tag = (e.target && e.target.tagName) || '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (e.key === 'Escape' && UI.isSettingsOpen()) {
        UI.closeSettings();
        return;
      }
      if (typing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (UI.isSettingsOpen()) return;
        if (session === 'idle') startSession();
        else stopSession();
      }
    });

    /* hentikan sebelum halaman ditutup */
    global.addEventListener('beforeunload', function () {
      if (session !== 'idle') {
        endedByUser = false;
        client.close(1000, 'bye');
        audio.stop();
      }
    });

    UI.startVisualizer(function () {
      return {
        mic: audio.running ? audio.spectrum('mic') : null,
        play: audio.running ? audio.spectrum('play') : null,
        level: audio.running ? Math.max(audio.micLevel, audio.playLevel) : 0,
        ai: audio.playLevel > 0
      };
    });

    teardownUi();

    if (!settings.apiKey) {
      UI.setStateLabel('Mulai dengan memasukkan API key Google AI Studio.');
      UI.openSettings();
    } else {
      UI.setStateLabel('Tekan mikrofon untuk mulai ngobrol.');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})(typeof window !== 'undefined' ? window : globalThis);
