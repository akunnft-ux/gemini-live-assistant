/* =============================================================================
 * ui.js — Seluruh manipulasi DOM: status, transkrip, visualizer, modal pengaturan
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});
  var Util = GLA.Util;
  var BAR_COUNT = 28;

  var el = {};
  var live = { user: null, ai: null };
  /* bubble terakhir yang sudah di-commit per role — anchor untuk kartu sumber,
   * karena groundingMetadata sering datang setelah turnComplete. */
  var lastBubble = { user: null, ai: null };
  var rafId = null;

  function $(id) {
    return document.getElementById(id);
  }

  /* Rata-rata sekelompok bin spektrum, dikelompokkan logaritmik agar bentuk
   * visualnya enak dilihat (frekuensi rendah tidak memakan semua bar). */
  function bandLevel(spec, i, count) {
    if (!spec || !spec.length) return 0;
    var from = Math.floor(Math.pow(i / count, 1.7) * spec.length);
    var to = Math.max(from + 1, Math.floor(Math.pow((i + 1) / count, 1.7) * spec.length));
    var sum = 0;
    var n = 0;
    for (var b = from; b < to && b < spec.length; b++) {
      sum += spec[b];
      n++;
    }
    return n ? sum / n / 255 : 0;
  }

  var UI = {
    init: function () {
      $('fWebSearch').addEventListener('change', function () {
        UI.syncSearchControls();
      });
      $('fModel').addEventListener('change', function () {
        UI.syncSearchControls();
      });
      $('fModel').addEventListener('input', function () {
        UI.syncSearchControls();
      });

      el.status = $('statusPill');
      el.statusText = $('statusText');
      el.timer = $('sessionTimer');
      el.orb = $('orb');
      el.stateLabel = $('stateLabel');
      el.micBtn = $('micBtn');
      el.transcript = $('transcript');
      el.emptyState = $('transcriptEmpty');
      el.toasts = $('toasts');
      el.bars = $('bars');
      el.modal = $('settingsModal');
      el.form = $('settingsForm');
      el.engine = $('engineBadge');

      for (var i = 0; i < BAR_COUNT; i++) {
        var b = document.createElement('span');
        b.className = 'bar';
        el.bars.appendChild(b);
      }
      this.barEls = el.bars.children;
    },

    /* ------------------------------------------------------------ status -- */

    setStatus: function (kind, text) {
      el.status.className = 'pill pill--' + kind;
      el.statusText.textContent = text;
    },

    setStateLabel: function (text) {
      el.stateLabel.textContent = text;
    },

    setTimer: function (ms) {
      if (ms == null) {
        el.timer.textContent = '';
        el.timer.removeAttribute('title');
        return;
      }
      el.timer.textContent = Util.formatDuration(ms);
      el.timer.title = 'Durasi sesi berjalan';
    },

    setEngineBadge: function (text) {
      if (!el.engine) return;
      el.engine.textContent = text;
      el.engine.hidden = !text;
    },

    setMicMode: function (mode) {
      /* mode: 'idle' | 'loading' | 'live' | 'ending' */
      el.micBtn.className = 'mic mic--' + mode;
      el.micBtn.setAttribute('aria-busy', mode === 'loading' ? 'true' : 'false');
      el.micBtn.disabled = mode === 'loading' || mode === 'ending';
    },

    setSpeaking: function (who) {
      /* who: '' | 'user' | 'ai' */
      el.orb.setAttribute('data-speaking', who);
      el.transcript.setAttribute('data-active', who);
    },

    /* ------------------------------------------------------------ toasts -- */

    toast: function (message, kind, ms) {
      kind = kind || 'info';
      ms = ms || 5200;
      var box = document.createElement('div');
      box.className = 'toast toast--' + kind;
      box.textContent = message;
      el.toasts.appendChild(box);
      while (el.toasts.children.length > 3) el.toasts.removeChild(el.toasts.firstChild);
      setTimeout(function () {
        box.classList.add('toast--out');
        setTimeout(function () {
          if (box.parentNode) box.parentNode.removeChild(box);
        }, 320);
      }, ms);
    },

    /* --------------------------------------------------------- transkrip -- */

    _scroll: function () {
      var t = el.transcript;
      var nearBottom = t.scrollHeight - t.scrollTop - t.clientHeight < 140;
      if (nearBottom) t.scrollTop = t.scrollHeight;
    },

    _hideEmpty: function () {
      if (el.emptyState) el.emptyState.hidden = true;
    },

    _showEmpty: function () {
      if (el.emptyState) el.emptyState.hidden = false;
    },

    _createBubble: function (role) {
      var wrap = document.createElement('article');
      wrap.className = 'msg msg--' + role;
      var head = document.createElement('div');
      head.className = 'msg__head';
      var who = document.createElement('span');
      who.className = 'msg__who';
      who.textContent = role === 'user' ? 'Kamu' : GLA.settingsValue('assistantName', 'Asisten');
      var time = document.createElement('time');
      time.className = 'msg__time';
      var d = new Date();
      time.textContent =
        (d.getHours() < 10 ? '0' : '') + d.getHours() + ':' + (d.getMinutes() < 10 ? '0' : '') + d.getMinutes();
      head.appendChild(who);
      head.appendChild(time);
      var body = document.createElement('div');
      body.className = 'msg__body';
      wrap.appendChild(head);
      wrap.appendChild(body);
      el.transcript.appendChild(wrap);
      this._hideEmpty();
      this._scroll();
      return wrap;
    },

    /* text utuh (bukan streaming) */
    addMessage: function (role, text) {
      if (!text || !text.trim()) return null;
      this.commitPartial(role);
      var wrap = this._createBubble(role);
      wrap.querySelector('.msg__body').textContent = text;
      this._scroll();
      return wrap;
    },

    /* teks parsial yang masih mengalir */
    setPartial: function (role, text) {
      if (!text) return;
      if (!live[role]) live[role] = this._createBubble(role);
      live[role].classList.add('msg--live');
      live[role].querySelector('.msg__body').textContent = text;
      this._scroll();
    },

    /* Kartu sumber web di bawah bubble assistant. Dipanggil dari live-client
     * setiap ada groundingMetadata; sumber yang sama tidak diulang.
     * Sumber selalu milik jawaban model, jadi role diabaikan dan kartu
     * tidak pernah menempel ke bubble pengguna. */
    addSources: function (role, sources, queries) {
      if (!sources || !sources.length) return;
      var wrap = live.ai || lastBubble.ai;
      if (!wrap) return;

      var card = wrap.querySelector('.msg__sources');
      if (!card) {
        card = document.createElement('div');
        card.className = 'msg__sources';
        var head = document.createElement('span');
        head.className = 'msg__sources-head';
        head.textContent = 'Sumber web';
        card.appendChild(head);
        wrap.appendChild(card);
      }
      if (queries && queries.length && !card.dataset.queries) {
        card.dataset.queries = '1';
        var q = document.createElement('span');
        q.className = 'msg__sources-q';
        q.textContent = 'pencarian: ' + queries.join(' · ');
        card.appendChild(q);
      }

      for (var i = 0; i < sources.length; i++) {
        var url = sources[i].uri;
        if (card.querySelector('a[href="' + url + '"]')) continue;
        var a = document.createElement('a');
        a.className = 'msg__source';
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = sources[i].title;
        a.title = url;
        card.appendChild(a);
      }
      this._scroll();
    },

    commitPartial: function (role, suffix) {
      var wrap = live[role];
      if (!wrap) return;
      var body = wrap.querySelector('.msg__body');
      live[role] = null;
      lastBubble[role] = wrap;
      wrap.classList.remove('msg--live');
      if (suffix) {
        var tag = document.createElement('span');
        tag.className = 'msg__tag';
        tag.textContent = suffix;
        wrap.appendChild(tag);
      }
      if (!body.textContent.trim()) {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap);
        this._showEmptyIfEmpty();
      }
      this._scroll();
    },

    _showEmptyIfEmpty: function () {
      if (!el.transcript.querySelector('.msg')) this._showEmpty();
    },

    clearTranscript: function () {
      live.user = live.ai = null;
      lastBubble.user = lastBubble.ai = null;
      while (el.transcript.firstChild) el.transcript.removeChild(el.transcript.firstChild);
      /* kembalikan node empty-state — kalau ikut terhapus, ikon "kosong" hilang
       * permanen setelah pertama kali transkrip dibersihkan. */
      if (el.emptyState) el.transcript.appendChild(el.emptyState);
      this._showEmpty();
    },

    transcriptText: function () {
      var lines = [];
      var nodes = el.transcript.querySelectorAll('.msg');
      for (var i = 0; i < nodes.length; i++) {
        var role = nodes[i].className.indexOf('msg--user') > -1 ? 'Kamu' : 'Asisten';
        var body = nodes[i].querySelector('.msg__body');
        var tag = nodes[i].querySelector('.msg__tag');
        if (body && body.textContent.trim()) {
          lines.push(role + ': ' + body.textContent.trim() + (tag ? ' ' + tag.textContent : ''));
        }
        var src = nodes[i].querySelectorAll('.msg__source');
        if (src.length) {
          var urls = [];
          for (var s = 0; s < src.length; s++) urls.push(src[s].getAttribute('href'));
          lines.push('  sumber: ' + urls.join(', '));
        }
      }
      return lines.join('\n');
    },

    /* -------------------------------------------------------- visualizer -- */

    startVisualizer: function (getFrame) {
      var smooth = new Float32Array(BAR_COUNT);

      function draw() {
        rafId = requestAnimationFrame(draw);
        var frame = getFrame();
        el.orb.style.setProperty('--level', (frame.level || 0).toFixed(3));

        for (var i = 0; i < BAR_COUNT; i++) {
          var v = bandLevel(frame.mic, i, BAR_COUNT);
          v = Math.max(v, bandLevel(frame.play, i, BAR_COUNT));
          if (frame.ai) {
            /* AI bicara tapi level reda (jeda pendek) → gelombang tetap bergerak */
            v = Math.max(v, 0.1 + 0.09 * Math.sin(i * 0.7 + performance.now() / 260));
          }
          smooth[i] += (v - smooth[i]) * (v > smooth[i] ? 0.55 : 0.16);
          UI.barEls[i].style.transform = 'scaleY(' + (0.04 + smooth[i] * 0.96).toFixed(3) + ')';
        }
      }
      draw();
    },

    stopVisualizer: function () {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
    },

    /* --------------------------------------------------------- pengaturan -- */

    fillSettings: function (s) {
      $('fApiKey').value = s.apiKey || '';
      $('fModel').value = s.model || GLA.DEFAULT_SETTINGS.model;
      $('fName').value = s.assistantName || '';
      $('fLang').value = s.language || 'auto';
      $('fVoice').value = s.voice || '';
      $('fUserName').value = s.userName || '';
      $('fMuteWhileSpeaking').checked = !!s.muteMicWhileSpeaking;
      $('fVad').value = s.vadSensitivity || 'normal';
      $('fWebSearch').checked = !!GLA.searchEnabled(s.searchMode);
      $('fSearchMode').value = s.searchMode === 'always' ? 'always' : 'auto';
      this.syncSearchControls();
      $('storageWarning').hidden = GLA.Storage.isPersistent;
    },

    readSettings: function () {
      return {
        apiKey: $('fApiKey').value.trim(),
        model: $('fModel').value.trim() || GLA.DEFAULT_SETTINGS.model,
        assistantName: $('fName').value.trim() || GLA.DEFAULT_SETTINGS.assistantName,
        language: $('fLang').value,
        voice: $('fVoice').value,
        userName: $('fUserName').value.trim(),
        muteMicWhileSpeaking: $('fMuteWhileSpeaking').checked,
        vadSensitivity: $('fVad').value,
        webSearch: $('fWebSearch').checked,
        searchMode: $('fWebSearch').checked ? $('fSearchMode').value : 'off'
      };
    },

    /* Kolom "cara memakai search" cuma relevan saat checkbox-nya aktif. */
    syncSearchControls: function () {
      var on = $('fWebSearch').checked;
      $('fSearchMode').disabled = !on;
      $('fSearchMode').style.opacity = on ? '' : '0.45';
      var model = $('fModel').value.trim() || GLA.DEFAULT_SETTINGS.model;
      var supported = GLA.modelSupportsSearch(model);
      var hint = $('searchHint');
      hint.hidden = !on || supported;
      if (!hint.hidden) {
        hint.textContent =
          'Model "' +
          model +
          '" tidak mendukung web search. Pilih model Live lain atau matikan fitur ini.';
      }
    },

    openSettings: function () {
      el.modal.hidden = false;
      el.modal.setAttribute('aria-hidden', 'false');
      document.body.classList.add('modal-open');
      setTimeout(function () {
        $('fApiKey').focus();
      }, 30);
    },

    /* klik pada area gelap di luar kartu modal → tutup */
    onBackdropClick: function (handler) {
      el.modal.addEventListener('click', function (e) {
        if (e.target === el.modal) handler();
      });
    },

    closeSettings: function () {
      el.modal.hidden = true;
      el.modal.setAttribute('aria-hidden', 'true');
      document.body.classList.remove('modal-open');
    },

    isSettingsOpen: function () {
      return !el.modal.hidden;
    },

    populateSelects: function () {
      var langs = $('fLang');
      GLA.LANGUAGES.forEach(function (l) {
        var o = document.createElement('option');
        o.value = l.code;
        o.textContent = l.label;
        langs.appendChild(o);
      });
      var voices = $('fVoice');
      GLA.VOICES.forEach(function (v) {
        var o = document.createElement('option');
        o.value = v.id;
        o.textContent = v.label;
        voices.appendChild(o);
      });
      var list = $('modelList');
      GLA.MODELS.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        o.label = m.label;
        list.appendChild(o);
      });
    }
  };

  GLA.UI = UI;
  GLA.settingsValue = function (key, fallback) {
    return GLA._currentSettings && GLA._currentSettings[key]
      ? GLA._currentSettings[key]
      : fallback;
  };
})(typeof window !== 'undefined' ? window : globalThis);
