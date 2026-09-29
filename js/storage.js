/* =============================================================================
 * storage.js — Penyimpanan lokal (localStorage) + util kecil
 * API key TIDAK PERNAH ditulis ke file mana pun; hanya di localStorage browser.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});

  /* LocalStorage bisa throw (Safari private mode, file:// di beberapa browser,
   * atau storage dinonaktifkan). Semua akses dibungkus try/catch dan jatuh
   * ke memory store supaya app tetap jalan.                                */

  var memoryStore = {};
  var storageOK = (function () {
    try {
      var probe = '__gla_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  function readRaw(key) {
    try {
      return storageOK
        ? global.localStorage.getItem(key)
        : Object.prototype.hasOwnProperty.call(memoryStore, key)
          ? memoryStore[key]
          : null;
    } catch (e) {
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      if (storageOK) global.localStorage.setItem(key, value);
      else memoryStore[key] = value;
      return true;
    } catch (e) {
      memoryStore[key] = value;
      return false;
    }
  }

  function removeRaw(key) {
    try {
      if (storageOK) global.localStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
    delete memoryStore[key];
  }

  var Storage = {
    /* localStorage tidak bisa dipakai (mis. file:// di browser tertentu) */
    isPersistent: storageOK,

    load: function () {
      var out = {};
      var defaults = GLA.DEFAULT_SETTINGS;
      var key = GLA.STORAGE_KEY;

      Object.keys(defaults).forEach(function (k) {
        out[k] = defaults[k];
      });

      var raw = readRaw(key);
      if (raw) {
        try {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            Object.keys(defaults).forEach(function (k) {
              if (typeof parsed[k] === typeof defaults[k]) out[k] = parsed[k];
            });
          }
        } catch (e) {
          /* data rusak → pakai default */
        }
      }
      return out;
    },

    save: function (settings) {
      return writeRaw(GLA.STORAGE_KEY, JSON.stringify(settings));
    },

    clearKey: function () {
      removeRaw(GLA.STORAGE_KEY);
    }
  };

  /* ------------------------------------------------------------- UTIL ---- */

  var Util = {
    /* pemformatan durasi mm:ss */
    formatDuration: function (ms) {
      var total = Math.max(0, Math.floor(ms / 1000));
      var m = Math.floor(total / 60);
      var s = total % 60;
      return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    },

    /* salin ke clipboard, dengan fallback untuk konteks non-secure (file://) */
    copyText: function (text) {
      if (global.navigator && navigator.clipboard && global.isSecureContext) {
        return navigator.clipboard.writeText(text);
      }
      return new Promise(function (resolve, reject) {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand('copy');
          document.body.removeChild(ta);
          ok ? resolve() : reject(new Error('execCommand gagal'));
        } catch (e) {
          reject(e);
        }
      });
    },

    escapeHtml: function (str) {
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }
  };

  GLA.Storage = Storage;
  GLA.Util = Util;
})(typeof window !== 'undefined' ? window : globalThis);
