# Lumi — Asisten Suara Pribadi (Gemini Live)

Ngobrol natural, dalam bahasa apa pun, langsung di browser.
HTML + CSS + JavaScript murni — **tanpa build step, tanpa server, tanpa backend**.

---

## Daftar isi

- [Fitur](#fitur)
- [Cara pakai](#cara-pakai)
- [Deploy ke GitHub Pages](#deploy-ke-github-pages)
- [Keamanan API key](#keamanan-api-key)
- [Cara kerja di balik layar](#cara-kerja-di-belakang-layar)
- [Struktur file](#struktur-file)
- [Pengaturan](#pengaturan)
- [Batasan & catatan penting](#batasan--catatan-penting)
- [Masalah yang sering muncul](#masalah-yang-sering-muncul)
- [Pengembangan lanjutan](#pengembangan-lanjutan)

---

## Fitur

| Fitur | Keterangan |
| --- | --- |
| **Percakapan suara** | Mikrofon → Gemini → suara assistant, full duplex lewat Gemini Live API |
| **Barge-in** | Bicara saat assistant masih bicara → dia langsung berhenti dan mendengarkan |
| **Transkrip live dua arah** | Teks dari suaramu dan dari assistant muncul streaming di panel kanan |
| **Multi-bahasa** | Deteksi bahasa otomatis, atau dikunci ke satu bahasa; assistant ikut berganti |
| **Visualizer audio** | Orb dan equalizer bergerak mengikuti spektrum suara sungguhan |
| **Sambung ulang otomatis** | Koneksi diputus server (rotasi/putus jaringan) → disambung ulang dengan *session resumption*, transkrip dan konteks tetap utuh |
| **Sesi tanpa batas** | *Context window compression* (sliding window) menembus batas keras 15 menit; koneksi tetap dirotasi otomatis tiap ±10 menit tanpa memutus percakapan |
| **Kunci API** | Disimpan di `localStorage` browser, tidak pernah masuk repository |

---

## Cara pakai

### 1. Dapatkan API key

Buat key gratis di **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)**.
Pastikan project key tersebut mengaktifkan **Generative Language API**.

### 2. Jalankan aplikasinya

**Cara tercepat:** klik dua kali `index.html`. Tidak perlu server apa pun.

Kalau ada masalah (khususnya di Safari, atau soal penyimpanan pengaturan),
jalankan lewat server lokal:

```bash
cd gemini-live-assistant
python3 -m http.server 8000
# lalu buka http://localhost:8000
```

### 3. Mulai ngobrol

1. Tempel API key di dialog yang muncul, isi nama asisten kalau mau, klik **Simpan**.
2. Tekan tombol mikrofon (atau spasi).
3. Berbicara. Assistant menjawab dengan suara. Interupsi kapan saja dengan bicara.

> **Pakai headphone atau earphone.** Tanpa headphone, suara assistant bisa
> tertangkap mikrofon sehingga assistant Mendengar dirinya sendiri dan terputus
> sendiri. Kalau tidak bisa pakai headphone, aktifkan pengaturan
> **“Matikan mikrofon saat assistant bicara”**.

---

## Deploy ke GitHub Pages

1. Buat repository baru (misal `gemini-live-assistant`), lalu upload semua file
   apa adanya:

   ```bash
   cd gemini-live-assistant
   git init
   git add .
   git commit -m "Asisten suara Gemini Live"
   git branch -M main
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

2. Di GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   pilih branch `main`, folder `/(root)`, lalu **Save**.

3. Tunggu sekitar 1 menit. Situsnya aktif di `https://<user>.github.io/<repo>/`.

Semua path di dalam kode relatif (`css/style.css`, `js/app.js`), jadi aplikasi
aman dipasang di subpath repo maupun di domain sendiri.

> **Jangan pernah commit API key.** Kode ini tidak pernah membaca key dari file
> konfigurasi — key hanya diminta lewat dialog di browser. Kalau `index.html` dan
> `js/*` di repo tidak pernah memuat string `AIza…`, repo-mu aman dipublikasikan.

---

## Keamanan API key

Aplikasi ini **murni client-side**, jadi tidak ada server yang bisa menyembunyikan
rahasia. Konsekuensinya, dengan jujur:

- API key tersimpan di `localStorage` browser, dan **secara teknis bisa dibaca**
  siapa pun yang memakai aplikasi ini di perangkat yang sama.
- Untuk pemakaian pribadi di perangkat pribadi: ini sudah cukup, dan tidak ada
  data lain yang terkirim selain ke Google.
- Untuk repository publik: batasi key-nya di Google AI Studio —
  **API restrictions → hanya “Generative Language API”**, dan
  **HTTP referrer allowable → isi domain GitHub Pages kamu**. Key yang dibatasi
  tidak bisa disalahgunakan dari situs lain.
- Key juga terlihat di URL WebSocket selama sesi berjalan. Jangan bagikan log
  browser atau tangkapan layar yang memuat URL sesi.
- Hapus key kapan saja lewat **Pengaturan → Hapus API key**.

Alternatif yang benar-benar menyembunyikan key butuh server (ephemeral token),
yang justru mustahil di aplikasi tanpa server. Ini trade-off yang disadari.

---

## Cara kerja di balik layar

```
Mikrofon
   │  getUserMedia (48 kHz)
   ▼
AudioWorklet "gla-capture"
   │  low-pass 7,2 kHz        (anti-aliasing)
   │  resample 48 k → 16 kHz  (linear, streaming)
   │  kumpulkan 3200 sampel   = 200 ms per chunk
   ▼  Int16Array(3200) → ArrayBuffer
base64 → WebSocket  wss://generativelanguage.googleapis.com/ws/…BidiGenerateContent
   ▼
Gemini Live API      ← VAD server menentukan giliran bicara (barge-in)
   │  PCM16 24 kHz per potongan, plus transkrip input & output
   ▼
AudioWorklet "gla-playback"
      ring buffer → resample 24 kHz → rate perangkat → speaker
```

Detail yang menentukan kualitasnya:

- **AudioWorklet, bukan ScriptProcessor.** Capture dan playback diproses di thread
  audio, sehingga tidak terkena glitch UI seperti yang biasa terjadi di thread utama.
- **Fallback otomatis.** Kalau `addModule()` gagal, app beralih ke
  `ScriptProcessorNode` dengan **resampler yang sama persis** — satu implementasi
  DSP dipakai kedua mesin, jadi tidak ada perbedaan kualitas yang menyesatkan.
  Badge di bawah tombol mikrofon menunjukkan mesin mana yang sedang dipakai.
- **Worklet dimuat dari Blob URL.** `fetch` file lokal diblokir CORS saat aplikasi
  dibuka lewat `file://`, jadi source worklet dibangun dari fungsi yang sudah ada
  lalu dijadikan Blob URL. Cara ini berhasil di `file://` maupun di hosting.
- **Backpressure.** Kalau antrean WebSocket menumpuk di atas 512 KB, chunk audio
  dibuang (suara terputus sesaat) alih-alih menambah latensi. Transkrip tetap utuh
  karena transkripsi dilakukan di server.
- **Transkrip dua arah** lewat `inputAudioTranscription` dan `outputAudioTranscription`.
  Ini satu-satunya cara mendapat teks dari model yang keluarannya `AUDIO` — dan
  justru keuntungannya: yang ditulis assistant persis apa yang diucapkannya.
- **Anti-XSS.** Semua teks dari model disisipkan dengan `textContent`.

---

## Struktur file

```
gemini-live-assistant/
├── index.html          markup + modal pengaturan
├── css/
│   └── style.css       tema gelap, orb, equalizer, responsif
├── js/
│   ├── config.js       konstanta, daftar model/voice/bahasa, system instruction
│   ├── storage.js      localStorage + fallback ke memory + util
│   ├── dsp.js          biquad, resampler, ring buffer (dipakai worklet & halaman)
│   ├── worklet.js      menyusun source AudioWorklet dari dsp.js
│   ├── audio.js        mesin audio: capture mic & playback speaker
│   ├── live-client.js  protokol WebSocket Gemini Live API
│   ├── ui.js           transkrip, status, visualizer, modal
│   └── app.js          orkestrasi seluruh alur
├── .nojekyll           agar GitHub Pages menyajikan file apa adanya
└── README.md
```

Semua skrip dimuat sebagai **classic script** (bukan ES module) dan berbagi objek
global `window.GLA`. ES module diblokir kebijakan CORS pada `file://`, dan justru
keputusan inilah yang membuat aplikasi bisa dibuka tanpa server.

---

## Pengaturan

| Pengaturan | Arti |
| --- | --- |
| **API key** | Wajib. Disimpan di browser, tidak pernah masuk git. |
| **Model** | Default `gemini-3.1-flash-live-preview`. Field bebas diisi, jadi model Live API lain bisa dipakai sesuai kuota key. |
| **Nama asisten** | Masuk ke system instruction, jadi assistant memperkenalkan diri dengan nama itu. |
| **Namamu** | Opsional. Assistant sesekali memanggil namamu, bukan di setiap balasan. |
| **Bahasa** | Otomatis (ikuti bahasa user) atau dikunci; kalau kamu berganti bahasa, dia tetap mengikuti. |
| **Suara** | Kosong = biarkan model memilih. Bisa diisi prebuilt voice (`Puck`, `Kore`, `Zephyr`, dan lainnya). |
| **Kecepatan respons** | Normal: jeda 0,6 s sebelum menjawab. Cepat: 0,35 s dan lebih mudah disela. |
| **Matikan mic saat assistant bicara** | Anti-feedback tanpa headphone; konsekuensinya barge-in nonaktif selama assistant bicara. |

System instruction yang dikirim (`config.js → buildSystemInstruction`) secara
eksplisit melarang model mengeluarkan markdown, bullet, emoji, atau kode —
karena output-nya **diucapkan**, bukan ditampilkan. Hasilnya suara yang terdengar
natural, bukan seperti membaca dokumen.

---

## Batasan & catatan penting

- **Sesi tidak dibatasi 15 menit lagi.** Tanpa konfigurasi tambahan, Live API
  membatasi sesi audio-only **keras 15 menit** karena token konteks penuh — dan
  session resumption **tidak bisa** menembus batas ini. Itu sebabnya dulu
  koneksi tampak "gagal reconnect di menit ke-15". Aplikasi kini mengaktifkan
  `contextWindowCompression` dengan `slidingWindow`, sehingga server otomatis
  membuang bagian paling awal konteks dan sesi bisa berjalan tanpa batas waktu
  (system instruction tetap dipertahankan).
- **Koneksi dirotasi otomatis.** Umur satu WebSocket di Live API terbatas
  sekitar 10 menit. Server mengirim `goAway` sebelum menutupnya; aplikasi lalu
  membuka koneksi baru sambil membawa handle session resumption, jadi
  percakapan berlanjut dengan konteks utuh dan tanpa menekan mikrofon lagi.
  Timer di layar menghitung total durasi bicara, bukan umur satu koneksi.
- **Putus jaringan pun disambung ulang.** Penutupan yang tidak diminta
  dideteksi lalu dicoba ulang dengan backoff bertingkat memakai
  `sessionResumption`. Handle berlaku 2 jam setelah sesi berakhir. Kalau server
  menolak resume (handle kedaluwarsa / sesi benar-benar tamat), aplikasi
  **otomatis memulai sesi baru** — mikrofon tetap aktif, hanya konteks lama yang
  hilang — bukan meminta kamu klik ulang.
- **Sesi benar-benar berakhir hanya bila kamu menekan tombol mikrofon** (atau
  gagal berulang karena API key/kuota).
- **Biaya mengikuti kuota API key kamu.** Live API ditagih per token audio
  (sekitar 25 token per detik bicara). Karena sesi kini bisa panjang, biaya juga
  ikut bertambah — pasang kuota harian di Google Cloud Console kalau tidak ingin
  kejutan biaya.
- **`file://` punya beberapa batasan browser.** Chrome dan Edge biasanya bekerja
  penuh. Safari memblokir mikrofon pada `file://` (harus lewat `http://localhost`
  atau hosting), dan sebagian browser tidak menyediakan `localStorage` untuk
  origin `file://` — aplikasi otomatis beralih ke penyimpanan sementara dan
  menampilkan peringatan di pengaturan.
- **WebSocket tanpa origin `file://` bisa ditolak jaringan.** Kalau muncul
  "Koneksi ditolak" padahal API key benar, jalankan lewat `localhost` atau
  GitHub Pages.
- **Nama model berubah dari waktu ke waktu.** Yang dipakai default adalah
  `gemini-3.1-flash-live-preview`. Kolom model bisa diisi manual dengan id terbaru.

---

## Masalah yang sering muncul

| Gejala | Penyebab dan solusi |
| --- | --- |
| "Izin mikrofon ditolak" | Klik ikon gembok di address bar, izinkan mikrofon, lalu muat ulang halaman. |
| Mikrofon tidak bergerak sama sekali di Safari | Safari memblokir mikrofon pada `file://`. Jalankan lewat `python3 -m http.server` atau deploy ke GitHub Pages. |
| "API key ditolak" (401) | Key salah atau belum diaktifkan. Cek di AI Studio dan pastikan Generative Language API aktif untuk project-nya. |
| "API key tidak punya izin" (403) | Key punya restriction yang tidak mengizinkan endpoint ini, atau billing belum aktif. |
| "Kuota atau rate limit habis" (429) | Kuota habis. Tunggu sebentar, atau ganti project/key. |
| "Suara yang dipilih tidak didukung" | Tidak semua model menerima semua prebuilt voice. Pilih **Otomatis** di pengaturan. |
| "Model … tidak tersedia" (404) | Id model tidak cocok dengan key. Gunakan `gemini-3.1-flash-live-preview` atau id terbaru. |
| Assistant terputus sendiri saat dia bicara | Feedback speaker ke mikrofon. Pakai headphone, atau nyalakan “Matikan mikrofon saat assistant bicara”. |
| "Koneksi ditolak" | Jalankan lewat `localhost`/hosting agar `Origin` valid, atau cek firewall. |
| Percakapan sempat terasa putus lalu lanjut lagi tiap ±10 menit | Normal: server merotasi WebSocket. Aplikasi menyambung ulang otomatis dengan session resumption — muncul notifikasi "sesi dilanjutkan", transkrip & konteks tetap utuh. |
| Notifikasi "memulai konteks percakapan baru" | Server menolak resume (sesi sudah tamat/kedaluwarsa). Aplikasi otomatis memulai sesi baru; mikrofon tetap aktif, hanya konteks lama yang hilang. |
| "Koneksi Live API terputus dan tidak berhasil disambung ulang" | Percobaan sambung ulang habis (jaringan/kuota/API key). Tekan mikrofon untuk memulai sesi baru. |
| Assistant terpotong sendiri saat kamu bicara | Jeda bisikan terlalu pendek. Turunkan “Kecepatan respons” ke **Normal**. |
| Badge "ScriptProcessor (cadangan)" | `addModule` gagal di browser itu. Tetap berfungsi; AudioWorklet hanya lebih halus. |

---

## Pengembangan lanjutan

Titik sambung yang sudah disiapkan, tinggal diisi:

- **Input teks.** `LiveClient.prototype.sendText()` sudah tersedia. Tinggal menambah
  input di UI; model membalas dengan suara dan transkripnya sudah tertangkap.
  Catatan: untuk model Live terbaru, `clientContent` hanya dipakai untuk seeding
  konteks awal — gunakan `realtimeInput.text` untuk percakapan.
- **Riwayat antar sesi.** Simpan transkrip per sesi di IndexedDB, lalu kirim
  sebagai ringkasan `clientContent` saat menyambung ulang.
- **Profil assistant.** `buildSystemInstruction()` menerima objek settings;
  menambah field gaya atau profil di sana sudah cukup untuk variasi persona.
- **Model Live Translate** (`gemini-3.5-live-translate-preview`) sudah ada di daftar
  model untuk kebutuhan voice-to-voice translation.

## Lisensi

MIT — pakai, ubah, dan sebarkan bebas.
