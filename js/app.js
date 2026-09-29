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
    close: onClose
  });

  /* ---------------------------------------------------------------- state - */

  var session = 'idle'; /* idle | loading | live | stopping */
  var userBuf = '';
  var aiBuf = '';
  var startedAt = 0;
  var tickTimer = null;
  var warnedLimit = false;
  var mutedByAi = false;
  var unmuteTimer = null;
  var endedByUser = false;

  /* ------------------------------------------------------------- handlers - */

  function onStateChange(state) {
    if (state === GLA.LIVE_STATE.CONNECTING) {
      UI.setStatus('busy', 'Menghubungkan');
      UI.setStateLabel('Menyambungkan ke Gemini…');
    } else if (state === GLA.LIVE_STATE.CLOSING) {
      UI.setStatus('busy', 'Mengakhiri');
    } else if (state === GLA.LIVE_STATE.CLOSED) {
      if (session !== 'idle') teardownUi();
    } else if (state === GLA.LIVE_STATE.FAILED) {
      if (session !== 'idle') teardownUi();
    }
  }

  function onReady() {
    session = 'live';
    startedAt = Date.now();
    warnedLimit = false;
    UI.setStatus('live', 'Live');
    UI.setStateLabel('Ngobrol bebas — spoke saja, assistant akan menjawab.');
    UI.setMicMode('live');
    UI.setTimer(0);
    tickTimer = setInterval(tick, 1000);
    UI.toast('Sesi live dimulai. Bicara apa saja — maksimal 15 menit.', 'ok', 4200);
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
    UI.toast(
      'Sesi akan ditutup server dalam ' + timeLeft + '. Selesaikan percakapan, lalu tekan Mikrofon lagi.',
      'warn',
      9000
    );
  }

  function onError(err) {
    UI.toast(err.message, 'error', 9000);
    UI.setStatus('error', 'Gagal');
    UI.setStateLabel('Terjadi kesalahan. Buka Pengaturan atau coba lagi.');
  }

  function onClose(ev, wasReady) {
    if (session === 'live' && wasReady && ev && ev.code === 1000 && endedByUser) {
      UI.toast('Sesi selesai.', 'ok', 2500);
    }
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
    var elapsed = Date.now() - startedAt;
    UI.setTimer(elapsed);
    var limit = GLA.AUDIO.sessionLimitMs;
    if (!warnedLimit && elapsed > limit - GLA.AUDIO.warnBeforeMs) {
      warnedLimit = true;
      UI.toast('Sesi akan mencapai batas 15 menit. Bersiap menyimpan transkrip.', 'warn', 8000);
    }
    if (elapsed >= limit) {
      endedByUser = false;
      stopSession('Sesi mencapai batas 15 menit dari server Live API.');
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
    endedByUser = false;
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
        client.connect(settings);
      })
      .catch(function (err) {
        session = 'idle';
        UI.setMicMode('idle');
        UI.setStatus('error', 'Gagal');
        UI.setStateLabel('Tidak bisa memulai sesi.');
        UI.toast(err.message, 'error', 10000);
      });
  }

  function stopSession(reason) {
    if (session === 'idle' || session === 'stopping') return;
    session = 'stopping';
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
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
    if (unmuteTimer) {
      clearTimeout(unmuteTimer);
      unmuteTimer = null;
    }
    mutedByAi = false;
    userBuf = aiBuf = '';
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
