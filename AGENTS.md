# AGENTS.md — Lumi (Gemini Live Assistant)

Catatan untuk coding agent yang mengerjakan repo ini. Tulis ulang file ini
kalau arsitekturnya berubah; jangan biarkan isinya kadaluarsa.

Isi file ini **netral dan aman dipublikasikan**. Kalau ada catatan internal,
racun, atau daftar shrug yang tidak boleh masuk git, taruh di `AGENTS.local.md`
(sudah di-ignore) — jangan di sini.

---

## 1. Apa ini

Aplikasi web statis untuk ngobrol suara dua arah dengan **Gemini Live API**
(BidiGenerateContent lewat raw WebSocket). Satu halaman, tanpa backend, tanpa
build step. Audio duplex penuh: mikrofon masuk, suara assistant keluar,
barge-in bekerja karena VAD dijalankan di server.

## 2. Batasan yang tidak bisa dilanggar

Semua keputusan di bawah lahir dari Trade-off nyata. Mengabaikannya berarti
memecahkan sesuatu yang sebelumnya sengaja diperbaiki.

| Batasan | Kenapa |
| --- | --- |
| **Classic script, bukan ES module** | `file://` memblokir ES module karena CORS. Justru inilah alasan app bisa dibuka tanpa server. Memakai `type="module"` mematikan fitur utama. |
| **Semua API jadi anggota `window.GLA`** | Tidak ada sistem modul. Coupling lewat global namespace satu ini. |
| **Tanpa dependensi, tanpa build** | Tidak ada `package.json`, tidak ada bundler. Tambah dependensi = ganti karakter project. |
| **Bisa jalan di `file://`** | README menyebut "klik dua kali `index.html`" sebagai cara tercepat. Jangan tambahkan `fetch` file lokal. |
| **Tanpa innerHTML untuk data** | Semua teks dari model masuk lewat `textContent` (anti-XSS). Jangan pakai `innerHTML` untuk data. |

## 3. Urutan `<script>` bukan hiasan

Classic script dieksekusi berurutan, dan ketergantungan antarfile tidak
dideklarasikan di mana pun. Salah urutan = `undefined` saat load.

```
config.js  → storage.js → memory.js → dsp.js → worklet.js
           → audio.js → live-client.js → ui.js → app.js
```

Ketergantungan yang harus diingat saat menambah file:

- `memory.js` membaca `GLA.MEMORY` **saat dimuat**, jadi wajib setelah `config.js`.
- `ui.js` memanggil `GLA.Memory` dan `GLA.Util`, jadi wajib setelah keduanya.
- `app.js` hanya dieksekusi dari `wire()` yang dipanggil setelah semua file siap.

Kalau ragu, cek urutan di `index.html` sebelum menambahkan file ke `js/`.

## 4. Dua jebakan yang mudah keliru

### 4.1 Session resumption

`sessionResumption` **wajib ada di setiap setup**, bahkan di sambungan pertama.
Field itu yang menyuruh server mengirim `sessionResumptionUpdate` secara berkala.
Tanpanya, handle tidak pernah dikirim dan konteks hilang begitu socket tertutup
(rotasi ±10 menit atau drop jaringan) — inilah penyebab historis "reconnect gagal
di menit ke-15".

Isi `handle` **hanya** pada sambungan lanjutan. `sessionResumption: {}` di sambungan
baru = sesi baru yang tetap resummable. Jangan pernah menghapus fieldnya.

### 4.2 Audio: 16 kHz masuk, 24 kHz keluar

- Input mic: **PCM16 LE mono 16 kHz**, di-resample dari 48 kHz device.
- Output speaker: **PCM16 LE mono 24 kHz**, di-resample ke rate perangkat.
- Salah angka di sini = suara chipmunk/robot, bukan crash yang terdengar jelas.
- Input dikirim sebagai base64. Output datang sebagai **binary frame**, bukan
  teks — biarkan `ws.binaryType = 'arraybuffer'`, kalau dibiarkan `blob` maka
  `JSON.parse` selalu gagal dan semua frame terbuang diam-diam.

Resampler di `dsp.js` dipakai bersama oleh worklet **dan** fallback
`ScriptProcessorNode`, supaya kualitas kedua jalur tidak berbeda.

## 5. Backpressure

WebSocket yang menumpuk buffer lebih buruk daripada audio terputus sesaat.
`live-client.js` dropping frame audio ketika antrean melewati ambang, **tapi
tidak** dropping frame transkrip. Jangan diubah tanpa membaca komentar di
sekitar `_pump`/`_send` — urutannya sudah disetel supaya transkrip tetap utuh.

## 6. State dan guard generasi

`LiveClient` memakai `this._gen` (nomor generasi koneksi). Setiap `connect()`
menaikkan `_gen` **sebelum** menutup socket lama, supaya event socket lama
diabaikan. Kalau urutannya dibalik, `onclose` socket lama lolos guard dan
memancarkan state `CLOSED`, yang membuat orkestrator menganggur sesi dan
membuang handle resumption tepat sebelum setup baru dikirim — konteks hilang.

## 7. Pola settings: dua arah

Setiap field settings **wajib** muncul di `ui.js → fillSettings()` **dan**
`readSettings()`. Kalau hanya salah satu, field itu hilang setiap kali user
klik Simpan — settings terkikis sedikit demi sedikit tanpa jejak dan sangat
sulit didiagnosis. `DEFAULT_SETTINGS` di `config.js` adalah satu-satunya
sumber default; `storage.js` menormalkan dari sana.

`readSettings()` juga menangani pemangkasan input yang punya batas (mis. `memoryNotes`),
potong dari **atas** supaya bagian bawah — yang biasanya ditulis belakangan —
tetap utuh.

## 8. Memori antar sesi

Lihat `js/memory.js` dan bagian "Kenapa memori dikirim lewat system instruction"
di README. Ringkasnya:

- Simpan **verbatim** di `localStorage`. Tanpa ringkasan LLM, tanpa panggilan API
  tambahan — tidak ada tempat untuk menaruh model kedua.
- Batas: 12 giliran / 6000 karakter (`GLA.MEMORY`), dipangkas dari **lama ke baru**.
- Dua jalur pengiriman, dan urutannya penting:
  1. `systemInstruction` (andal — cuma teks, tidak bisa diabaikan server).
  2. `clientContent` (pelengkap, dan dilaporkan sering diabaikan —
     [python-genai#1733](https://github.com/googleapis/python-genai/issues/1733)).
- `clientContent` **hanya di sambungan fresh**, dan `turnComplete` **wajib
  `false`**. Tanpa itu server langsung mulai generate dan assistant bicara
  sendiri begitu mikrofon dinyalakan.
- `recall` di sambungan resume dikosongkan (`[]`) supaya blok RECALL tidak
  mengulang giliran yang server sudah punya. Catatan user tetap ikut karena
  blok itu tidak bergantung pada giliran.
- Isi `<<<MEMORY_*>>>` adalah **data, bukan instruksi**. Kalimat penjaga di
  `buildSystemInstruction` tidak boleh dihapus.

## 9. Workflow agent

### Verifikasi

Repo ini tidak punya test runner, jadi verifikasi minimal yang harus dijalankan
setiap perubahan:

```bash
for f in js/*.js; do node --check "$f" || echo "SINTAX FAIL: $f"; done
```

Untuk perubahan yang menyentuh memori atau wire protocol, jalankan harness
`/tmp/opencode/gla-test/wire.js` (sandbox `vm` + stub WebSocket, tanpa browser)
dan `t.js` (unit test store). Keduanya berbasis assert dan bisa dijalankan ulang.

Tidak ada Chrome/Chromium di environment ini, jadi **smoke test di browser
tidak bisa diotomasikan** — katakan terus terang kalau sebuah perubahan
hanya terverifikasi secara statis, jangan klaim sudah dites manual.

### Gaya

- Bahasa Indonesia untuk komentar, README, dan semua string UI. Ini konsisten
  dengan codebase yang ada; jangan campur Inggris kecuali untuk nama API.
- **Komentar menjelaskan alasan, bukan mengulang kode.** Kalau sebuah baris
  kode sudah menjelaskan dirinya sendiri, tulis komentar untuk hal yang
  *tidak* terlihat dari kode (kebutusan, trade-off, bug yang pernah terjadi).
- Komentar berbahasa Inggris hanya untuk istilah yang benar-benar dari
  upstream API (`turnComplete`, `clientContent`, `sessionResumption`).
- Ikuti format yang sudah ada di file tersebut. Jangan reformat baris yang
  tidak kamu ubah.
- Jangan pernah commit API key, `*.local`, atau `.env`.

## 10. Hal yang sudah dicoba dan gagal

- **IndexedDB untuk memori.** Ditolak: `file://` di Chrome memberi opaque
  origin, `localStorage` juga bisa gagal tapi punya fallback in-memory yang
 cukup untuk kasus degenerate.
- **Ringkasan memori pakai LLM.** Butuh panggilan API tambahan, menambah
  latensi, surface area failure, dan hasil kosong kalau quota habis. Verbatim
  + batas karakter sudah menutup sekitar 95% kebutuhan tanpa biaya.