/* =============================================================================
 * memory.js — Memori antar sesi, disimpan di browser
 * -----------------------------------------------------------------------------
 * Isinya transkrip percakapan dari sesi-sesi sebelumnya. Tujuannya satu:
 * ketika user membuka Lumi lagi besok, assistant masih ingat tadi ngobrol apa —
 * tanpa history itu, tiap sesi benar-benar baru dan Live API juga membuang
 * konteks lama sendiri saat slidingWindow aktif.
 *
 * Kenapa localStorage, bukan IndexedDB (meski README lama menyarankan itu):
 *   Chrome memblokir IndexedDB pada origin `file://` (opaque origin). Kalau
 *   memorinya di sana, fitur ini mati tepat di use-case "klik dua kali
 *   index.html" yang jadi selling point aplikasi ini. localStorage + fallback
 *   ke memori (lihat storage.js) selalu bisa dipakai. Kapasitas ~5 MB; untuk
 *   12 turn kita cuma butuh belasan kilobyte.
 *
 * Format tiap turn: { role: 'user'|'model', text: string, ts: epoch }
 * Dipangkas dari belakang (turn paling lama dibuang) saat melewati batas.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});
  var C = GLA.MEMORY;

  var KEY = 'gla.memory.v1';

  /* -------------------------------------------------------------- storage - */

  /* localStorage bisa throw (Safari private mode, storage dimatikan, atau
   * origin file:// di beberapa browser). Semua akses dibungkus try/catch dan
   * jatuh ke memory store — sama seperti storage.js — supaya aplikasi tetap
   * jalan, hanya memorinya yang tidak bertahan setelah reload. */
  var memoryStore = {};

  /* localStorage "terlihat" dipakai: probe setItem berhasil. */
  var storageOK = (function () {
    try {
      var probe = '__gla_mem_probe__';
      global.localStorage.setItem(probe, '1');
      global.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      return false;
    }
  })();

  /* Terpakai setelah storageOK=true tapi penulisan tetap gagal (mis. kuota
   * localStorage penuh). Setelah itu memori hanya hidup sebatas tab ini, jadi
   * UI harus diberi tahu — kalau tidak, hint tetap menjanjikan "Tersimpan di
   * browser ini" padahal tidak. */
  var storageDegraded = false;

  function readRaw(key) {
    /* memoryStore hanya diisi oleh writeRaw KETIKA localStorage menulis gagal,
     * jadi kalau ia punya key itu berarti isinya lebih baru daripada yang ada
     * di localStorage. Harus dicek DULUAN — kalau hanya dipakai sebagai
     * cadangan saat storageOK===false, fallback itu jadi sia-sia: data ditulis
     * ke tempat yang tidak pernah dibaca lagi dan hilang diam-diam. */
    try {
      if (Object.prototype.hasOwnProperty.call(memoryStore, key)) return memoryStore[key];
    } catch (e) {
      /* abaikan, lanjut ke localStorage */
    }
    try {
      if (storageOK) return global.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
    return null;
  }

  function writeRaw(key, value) {
    if (!storageOK) {
      memoryStore[key] = value;
      return true;
    }
    try {
      global.localStorage.setItem(key, value);
      /* Tulis berhasil → memoryStore tidak boleh bayanganin nilai basi. */
      delete memoryStore[key];
      return true;
    } catch (e) {
      memoryStore[key] = value;
      storageDegraded = true;
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

  /* ----------------------------------------------------------- sanitizing - */
  /* PENTING: teks yang kita kirim balik ke model adalah output model itu
   * sendiri (transkrip assistant) dan hasil transkripsi suara user. Kalau
   * teks itu ikut masuk ke system instruction tanpa penjaga, siapa pun yang
   * sempat membuat model mengulang "abaikan semua instruksi sebelumnya" akan
   * menyimpan payload itu di localStorage user dan memetakannya lagi di sesi
   * berikutnya — persistent prompt injection.
   *
   * Ini defence-in-depth, BUKAN pengganti penjaga di system instruction.
   * Kenapa bukan penyaring utama: menyaring frasa bisa dilewati dengan variasi
   * ejaan, jadi pengaman yang andal tetap di config.js (blok RECALL yang
   * menyatakan blok itu rekaman, bukan instruksi). Fungsi ini hanya membuat
   * payload yang jelas-jelas berbahaya gagal diam-diam. */

  var THREAT_RE = new RegExp(
    [
      'ignore\\s+(all\\s+)?previous\\s+instructions?',
      'ignore\\s+(all\\s+)?the\\s+above',
      'disregard\\s+(the\\s+)?(above|previous|earlier)',
      'forget\\s+(everything|all\\s+previous)',
      'you\\s+are\\s+now\\s+(a|an|in\\s+developer\\s+mode)',
      'new\\s+system\\s+(prompt|instruction)s?',
      'system\\s+prompt\\s*:',
      'override\\s+(your|all)\\s+(rules?|instructions?)',
      '(reveal|print|repeat|show)\\s+(me\\s+)?(your|the)\\s+(system\\s+)?(prompt|instructions?)'
    ].join('|'),
    /* 'g' itu wajib: pola ini sengaja dibuat alternatif (satu giliran bisa
     * memuat beberapa percobaan injeksi), dan String.replace tanpa 'g' hanya
     * menukar yang pertama. Sisanya akan lolos apa adanya. */
    'gi'
  );

  /* Ganti frasa berbahaya dengan placeholder netral, bukan hapus — supaya
   * kalimatnya tetap terbaca sebagai percakapan biasa dan tidak menyisakan
   * lubang yang membuat model ikut bingung. */
  function sanitize(text) {
    if (!text) return '';
    return String(text)
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      .replace(THREAT_RE, '[disembunyikan demi keamanan]');
  }

  /* --------------------------------------------------------------- limits - */

  /* Satu turn yang cuma "ok" atau "hmm" tidak menyumbang informasi apa pun tapi
   * memakan kuota context. Pangkas supaya yang tersimpan adalah bagian yang
   * benar-benar berisi isi percakapan. */
  var MIN_TURN_CHARS = 2;

  function normalizeRole(role) {
    return role === 'model' || role === 'ai' ? 'model' : 'user';
  }

  /* Pangkas dari belakang sampai jumlah turn DAN total karakter masuk batas.
   * Dipotong dari belakang (bukan depan) supaya giliran terakhir — yang paling
   * relevan untuk melanjutkan percakapan — selalu utuh. */
  function trim(turns) {
    var out = turns.slice(-C.turnsMax);
    var total = 0;
    for (var i = out.length - 1; i >= 0; i--) {
      total += out[i].text.length;
      if (total > C.charsMax) {
        out = out.slice(i + 1);
        break;
      }
    }
    /* Satu turn pun yang lebih besar dari budget harus tetap lolos (dipotong
     * seperlunya) — lebih baik satu giliran terpotong daripada memori kosong
     * total.
     *
     * Perhatikan: ini harus dicek SEBELUM clamp di bawah. Kalau giliran
     * terbaru saja sudah melebihi budget, loop di atas membuang semuanya dan
     * `out` jadi kosong — dan clamp yang bergantung pada `out.length` tidak akan
     * pernah jalan. Itu membuat memori kosong total, bukan sekadar terpotong.
     * Karena itu giliran terbaru dipaksa kembali dulu. */
    if (!out.length && turns.length) {
      out = [turns[turns.length - 1]];
    }
    if (out.length && out[0].text.length > C.charsMax) {
      out[0] = {
        role: out[0].role,
        text: out[0].text.slice(-C.charsMax),
        ts: out[0].ts
      };
    }
    return out;
  }

  /* ------------------------------------------------------------------ API - */

  var Memory = {
    /* localStorage tidak bisa dipakai, ATAU penulisan ke sana gagal terus
     * (mis. kuota penuh) → memori hanya bertahan selama tab terbuka. UI
     * menampilkan catatan ini ke user. */
    isPersistent: storageOK && !storageDegraded,

    /* BACA HARUS DISANITASI, bukan cuma tulis.
     *
     * addTurn() sanitize sebelum menyimpan, tapi itu tidak cukup: sanitize
     * pada waktu tulis hanya membersihkan nilai yang masuk lewat API. Payload
     * yang sudah ada di localStorage — ditulis versi app lain, diedit manual,
     * atau berasal dari mesin lain — akan dibaca apa adanya oleh load() lalu
     * diteruskan ke system instruction. Yang lebih buruk: addTurn() memanggil
     * load() lalu save(), jadi payload yang tidak disanitasi itu ikut tersalin
     * ulang setiap giliran dan tidak pernah hilang dengan sendirinya.
     *
     * Idempoten, jadi sanitize di sini tidak merusak data yang sudah bersih. */
    load: function () {
      var raw = readRaw(KEY);
      if (!raw) return [];
      var parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (e) {
        return []; /* data rusak → mulai dari kosong, jangan lumpuh total */
      }
      if (!parsed || !parsed.length) return [];
      var out = [];
      for (var i = 0; i < parsed.length; i++) {
        var t = parsed[i];
        if (!t || typeof t.text !== 'string' || !t.text.trim()) continue;
        var text = sanitize(t.text.trim());
        if (text.length < MIN_TURN_CHARS) continue;
        out.push({
          role: normalizeRole(t.role),
          text: text,
          ts: typeof t.ts === 'number' ? t.ts : 0
        });
      }
      return trim(out);
    },

    save: function (turns) {
      return writeRaw(KEY, JSON.stringify(trim(turns || [])));
    },

    /* Panggil sekali tiap giliran SELESAI (dari app.js).
     *
     * Catatan penting soal ini fungsi: TIDAK ada lagi logika penggabung
     * "prefix" di sini. Dulu ada, dengan asumsi transkrip live datang
     * terpecah jadi banyak potongan untuk satu kalimat. Tapi app.js sudah
     * mengumpulkan potongan-potongan itu sendiri (aiBuf += text) dan memanggil
     * fungsi ini tepat SEKALI per giliran lengkap — makanya tiap panggilan
     * sudah berisi satu giliran utuh, bukan fragmen.
     *
     * Asumsi yang salah itu justru jadi merusak: dua giliran assistant yang
     * sama-sama diawali kata yang sama (mis. "Oke" lalu "Oke, berarti kamu
     * mau…") ternyata dianggap continuation, sehingga giliran pertama DITIMPA
     * dan hilang permanen dari memori. Karena kedua-duanya satu giliran utuh,
     * menggabungkan tidak pernah benar — jadi dihapus, bukan disempitkan. */
    addTurn: function (role, text) {
      var clean = sanitize(String(text || '').trim());
      if (clean.length < MIN_TURN_CHARS) return false;

      var turns = Memory.load();
      turns.push({ role: normalizeRole(role), text: clean, ts: Date.now() });
      Memory.save(turns);
      return true;
    },

    clear: function () {
      removeRaw(KEY);
    },

    stats: function () {
      var turns = Memory.load();
      var chars = 0;
      for (var i = 0; i < turns.length; i++) chars += turns[i].text.length;
      return { count: turns.length, chars: chars, persistent: storageOK && !storageDegraded };
    },

    /* ------------------------------------------------------------ prompt - */

    /* Rekaman percakapan dalam bentuk baris-teks untuk system instruction.
     * Sengaja memakai label peran plainly ("Kamu:" / name + ":") supaya model
     * tahu mana kalimat user mana kalimatnya sendiri, bukan menganggap
     * semuanya instruksi. */
    recallLines: function (turns, assistantName) {
      if (!turns || !turns.length) return [];
      var who = (assistantName || 'the assistant').trim();
      var lines = [];
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        var label = t.role === 'model' ? who : 'The user';
        lines.push(label + ': ' + t.text.replace(/\s+/g, ' ').trim());
      }
      return lines;
    },

    /* History verbatim untuk dikirim via `clientContent` saat sambung awal.
     * Best-effort saja: ada laporan bahwa Live API mengabaikan turn yang
     * dikirim lewat jalur ini (googleapis/python-genai#1733), jadi jangan
     * bergantung padanya — blok RECALL di system instruction yang jadi
     * penopang utama. Tokoh di sini cuma meningkatkan fidelity kalau
     * ternyata dipatuhi.
     *
     * `turnComplete` TIDAK diurus di sini; pemanggil yang menentukan. */
    seedTurns: function (turns) {
      if (!turns || !turns.length) return [];
      var out = [];
      for (var i = 0; i < turns.length; i++) {
        var t = turns[i];
        if (!t.text || !t.text.trim()) continue;
        out.push({
          role: normalizeRole(t.role),
          parts: [{ text: t.text.trim() }]
        });
      }
      return out;
    }
  };

  GLA.Memory = Memory;
  GLA.MEMORY_KEY = KEY;
})(typeof window !== 'undefined' ? window : globalThis);