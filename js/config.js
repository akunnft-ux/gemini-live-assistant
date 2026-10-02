/* =============================================================================
 * config.js — Konstanta runtime untuk Gemini Live Assistant
 * -----------------------------------------------------------------------------
 * Semua script dimuat sebagai classic script (BUKAN ES module) supaya aplikasi
 * tetap bisa dibuka langsung dari file:// tanpa server.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});

  /* ------------------------------------------------------------------ API -- */

  var API = {
    host: 'generativelanguage.googleapis.com',
    service: 'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent'
  };

  /* ---------------------------------------------------------------- AUDIO -- */
  /* Live API: input raw PCM 16-bit little-endian 16 kHz mono,
   *          output raw PCM 16-bit little-endian 24 kHz mono.              */

  var AUDIO = {
    input: {
      targetRate: 16000,
      mimeType: 'audio/pcm;rate=16000',
      chunkSamples: 3200, // 3200 / 16000 = 200 ms per chunk
      // Batas antrean WebSocket; kalau buffer menumpuk, drop chunk (dtu)
      maxBufferedBytes: 512 * 1024
    },
    output: {
      sourceRate: 24000
    },
    /* Batas durasi satu KONEKSI (~10 menit menurut dokumen Live API). Bukan
     * batas sesi: sesi bisa lebih panjang dari ini karena context window
     * compression + session resumption. Angka 15 menit di sini hanya jaring
     * pengaman kalau `goAway` tidak sampai. */
    sessionLimitMs: 15 * 60 * 1000,
    warnBeforeMs: 60 * 1000
  };

  /* -------------------------------------------------------------- SESSION -- */
  /* TANPA context window compression, sesi audio-only DIBATASI KERAS 15
   * menit oleh server — bukan karena koneksi, tapi karena token konteks
   * penuh. Ini penting: session resumption TIDAK BISA menembus batas ini.
   * Begitu token habis, sesinya tamat dan reconnect memakai handle sekalipun
   * akan ditolak server → user harus memulai ulang manual. Itulah kenapa
   * koneksi "gagal reconnect setelah 15 menit".
   *
   * Dengan `slidingWindow`, server otomatis membuang bagian paling awal
   * konteks ketika sudah terlalu panjang, sehingga sesi bisa berjalan tanpa
   * batas waktu. Sistem instruction selalu dipertahankan. */
  var SESSION = {
    contextWindowCompression: { slidingWindow: {} }
  };

  /* ------------------------------------------------------------ RECONNECT -- */
  /* Server Live API memutus WebSocket secara berkala (batas umur koneksi ~10
   * menit, rotasi, atau drop jaringan). Koneksi yang putus TIDAK berarti sesi
   * berakhir: dengan `sessionResumption` di setup, sambungan baru bisa
   * melanjutkan konteks percakapan yang sama lewat handle. Jadi ini pengaman
   * koneksi, bukan fitur tambahan — tanpa ini user kehilangan sesi secara
   * acak, kadang jauh sebelum 15 menit. */
  var RECONNECT = {
    /* Tunggu sebentar setelah goAway, lalu pindah koneksi lebih dulu daripada
     * menunggu server menutup paksa (menjaga jeda tetap pendek). */
    goAwayDelayMs: 3000,
    /* Backoff percobaan sambung ulang (ms). */
    backoffMs: [1200, 2500, 5000, 9000, 15000],
    /* Handle resumption hanya dipakai selama ini setelah sesi berakhir.
     * Server menyimpan token 2 jam; 90 menit lebih dari cukup dan membuat
     * handle basi dibuang sendiri. */
    resumptionTtlMs: 90 * 60 * 1000
  };

  /* --------------------------------------------------------------- VAD ---- */
  /* Barge-in: model's Voice Activity Detection menentukan kapan giliran
   * bicara. START_OF_ACTIVITY_INTERRUPTS = suara user selalu memutus
   * jawaban model. Ini enum resmi dari AI (bukan "USER_ACTIVITY"):
   *   ACTIVITY_HANDLING_UNSPECIFIED | START_OF_ACTIVITY_INTERRUPTS | NO_INTERRUPTION
   * START_SENSITIVITY_HIGH membuat suara lebih mudah terdeteksi, jadi
   * barge-in lebih responsif.                                                     */

  var VAD = {
    automaticActivityDetection: {
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      prefixPaddingMs: 200,
      silenceDurationMs: 600
    },
    activityHandling: 'START_OF_ACTIVITY_INTERRUPTS'
  };

  /* ------------------------------------------------------------- MODELS --- */

  /* search: apakah model Live ini mendukung Grounding with Google Search.
   * Hanya model Live non-translate yang mendukungnya. */
  var MODELS = [
    {
      id: 'gemini-3.8-live',
      label: 'Gemini 3.8 Live (disarankan)',
      note: 'Model Live terbaru: latensi rendah, 97 bahasa, thinking level.',
      search: true
    },
    {
      id: 'gemini-2.5-flash-native-audio-preview-12-2025',
      label: 'Gemini 2.5 Flash Native Audio',
      note: 'Lebih lama, punya affective dialog (menyesuaikan nada/emosi).',
      search: true
    },
    {
      id: 'gemini-3.5-live-translate-preview',
      label: 'Gemini 3.5 Live Translate',
      note: 'Model translate speech-to-speech 70+ bahasa.',
      search: false
    }
  ];

  function modelById(id) {
    for (var i = 0; i < MODELS.length; i++) {
      if (MODELS[i].id === id) return MODELS[i];
    }
    return null;
  }

  /* Model Live yang pernah jadi default lalu dipensiunkan. Dipakai untuk
   * migrasi settings lama: kalau localStorage masih menyimpan salah satu id
   * ini, turunkan ke default baru (mis. setelah default diganti ke
   * gemini-3.8-live, user di origin lain tetap ikut model terbaru). */
  var RETIRED_MODELS = ['gemini-3.1-flash-live-preview'];

  /* Model yang diketik manual di pengaturan tidak ada di daftar → anggap
   * dukung search (server yang akhirnya memutuskan). */
  function modelSupportsSearch(id) {
    var m = modelById(id);
    return m ? m.search !== false : true;
  }

  /* -------------------------------------------------------------- VOICES -- */
  /* Prebuilt voice native-audio. Kosongkan ([]) = biarkan model memilih.  */

  var VOICES = [
    { id: '', label: 'Otomatis (pilihan model)' },
    { id: 'Zephyr', label: 'Zephyr — netral, jernih' },
    { id: 'Puck', label: 'Puck — hangat, energik' },
    { id: 'Charon', label: 'Charon — dalam, tenang' },
    { id: 'Kore', label: 'Kore — lembut, ramah' },
    { id: 'Fenrir', label: 'Fenrir — mantap, tegas' },
    { id: 'Aoede', label: 'Aoede — lantang, tegas' },
    { id: 'Leda', label: 'Leda — muda, ringan' },
    { id: 'Orus', label: 'Orus — dalam, sengaja' }
  ];

  /* ----------------------------------------------------------- BAHASA ---- */
  /* code = BCP-47 (untuk UI), name = nama natural yang disuntik ke system
   * instruction (lebih tahan gagal daripada enum API).                     */

  var LANGUAGES = [
    { code: 'auto', label: 'Otomatis (deteksi bahasa)' },
    { code: 'id', label: 'Bahasa Indonesia', name: 'Indonesian (Bahasa Indonesia)' },
    { code: 'en', label: 'English', name: 'English' },
    { code: 'ms', label: 'Bahasa Melayu', name: 'Malay (Bahasa Melayu)' },
    { code: 'ja', label: '日本語 (Japanese)', name: 'Japanese' },
    { code: 'ko', label: '한국어 (Korean)', name: 'Korean' },
    { code: 'zh', label: '中文 (Chinese)', name: 'Chinese (Mandarin)' },
    { code: 'ar', label: 'العربية (Arabic)', name: 'Arabic' },
    { code: 'hi', label: 'हिन्दी (Hindi)', name: 'Hindi' },
    { code: 'th', label: 'ไทย (Thai)', name: 'Thai' },
    { code: 'vi', label: 'Tiếng Việt', name: 'Vietnamese' },
    { code: 'es', label: 'Español', name: 'Spanish' },
    { code: 'fr', label: 'Français', name: 'French' },
    { code: 'de', label: 'Deutsch', name: 'German' },
    { code: 'pt', label: 'Português', name: 'Portuguese' },
    { code: 'ru', label: 'Русский', name: 'Russian' },
    { code: 'tr', label: 'Türkçe', name: 'Turkish' }
  ];

  /* ----------------------------------------------------------- PERSONA ---- */

  var DEFAULT_SETTINGS = {
    apiKey: '',
    assistantName: 'Lumi',
    model: MODELS[0].id,
    voice: '',
    language: 'auto',
    userName: '',
    muteMicWhileSpeaking: false,
    vadSensitivity: 'normal', // 'normal' | 'responsive'
    /* Grounding with Google Search. Default 'off': fitur ini menambah jeda
     * 1–3 detik dan memakai kuota Search, jadi tidak diaktifkan diam-diam
     * untuk pengguna lama. Nyalakan lewat Pengaturan → Web search. */
    searchMode: 'off' // 'off' | 'auto' | 'always'
  };

  var STORAGE_KEY = 'gla.settings.v1';

  /* --------------------------------------------- SYSTEM INSTRUCTION ------- */

  function buildSystemInstruction(s) {
    var lang = LANGUAGES.filter(function (l) {
      return l.code === s.language;
    })[0];

    var name = (s.assistantName || DEFAULT_SETTINGS.assistantName).trim();
    var user = (s.userName || '').trim();

    var langLine =
      s.language === 'auto'
        ? '- Detect the language the user speaks and ALWAYS reply in that same ' +
          'language, with that language’s natural vocabulary and tone. If the ' +
          'user switches to another language mid-conversation, switch with them ' +
          'immediately and seamlessly. Never announce which language you are ' +
          'using and never ask about it.'
        : '- Speak ' +
          (lang ? lang.name : 'the user’s language') +
          ' by default. Mirror the user’s language whenever they switch: ' +
          'if they start writing or speaking another language, reply in that ' +
          'language from then on. Never announce which language you are using.';

    var lines = [
      'You are ' +
        name +
        ', a warm, genuinely helpful personal assistant built for natural ' +
        'spoken conversation.',
      '',
      'LANGUAGE',
      langLine,
      '',
      'SPEAKING STYLE (this matters — your output is spoken aloud)',
      '- Speak in short, natural spoken sentences. One idea at a time.',
      '- Use natural filler and warmth. You are a person, not a document.',
      '- Never read out markdown, asterisks, bullet points, numbered lists, ' +
        'code blocks, URLs, emoji, or special characters.',
      '- Never spell out formatting or say "here is a list". Say the words.',
      '- Keep replies brief by default (1–3 sentences). Go deeper only when ' +
        'the user asks for detail.',
      '',
      'BEHAVIOUR',
      '- If the user interrupts you, stop immediately and listen. Do not ' +
        'finish your sentence.',
      '- If you are unsure or lack current information, say so plainly ' +
        'instead of guessing or inventing facts.',
      '- Keep the conversation warm and human. Light humour is welcome, ' +
        'but stay respectful and never offensive.'
    ];

    if (user) {
      lines.push('', 'The user’s name is ' + user + '. Use it naturally and ' +
        'occasionally, not in every single reply.');
    }

    if (searchEnabled(s.searchMode)) lines.push('', searchBlock(s.searchMode));

    return lines.join('\n');
  }

  /* ---------------------------------------------- SEARCH INSTRUCTION ------- */
  /*_searchMode_: 'auto'   → model memutuskan kapan perlu cari
   *              'always' → selalu cari untuk pertanyaan faktual
   *              'off'/'undefined' → tidak ada blok search sama sekali      */

  function searchEnabled(mode) {
    return mode === 'auto' || mode === 'always';
  }

  function searchBlock(mode) {
    var head =
      'WEB SEARCH (you have live Google Search grounding available)';
    var common = [
      '- Search whenever the answer depends on facts that change: news, prices, ' +
        'dates, weather, scores, releases, schedules, people in the news, or ' +
        'anything after your knowledge cutoff. Search rather than guessing.',
      '- Say briefly that you are searching before you answer, then give the ' +
        'answer. Do not narrate the search process step by step.',
      '- Ground your claims in what you actually found. If the sources disagree, ' +
        'say so. If search turns up nothing, say that plainly instead of filling ' +
        'the gap from memory.',
      '- Do not read URLs out loud character by character. Refer to sources by ' +
        'name, like "menurut Kompas" or "according to Reuters".'
    ];

    if (mode === 'always') {
      return [
        head,
        '- For EVERY factual question, search first before answering, even for ' +
          'things you believe you already know. This is a research assistant: ' +
          'fresh, sourced answers are the whole point.'
      ]
        .concat(common)
        .join('\n');
    }

    return [
      head,
      '- Use it when it would genuinely help. Skip it for small talk, opinions, ' +
        'and things you know well and that rarely change.',
      '- When the user asks you to research, look something up, find out, or ' +
        'check the latest, always search. Do those requests even if your ' +
        'confidence is high.',
      '- For a research request, do a real search, then summarise the findings in ' +
        'spoken form. Keep it to a few sentences unless the user asks for detail.'
    ]
      .concat(common)
      .join('\n');
  }

  /* ------------------------------------------------------------- EXPORT --- */

  GLA.API = API;
  GLA.AUDIO = AUDIO;
  GLA.SESSION = SESSION;
  GLA.RECONNECT = RECONNECT;
  GLA.VAD = VAD;
  GLA.MODELS = MODELS;
  GLA.VOICES = VOICES;
  GLA.LANGUAGES = LANGUAGES;
  GLA.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  GLA.STORAGE_KEY = STORAGE_KEY;
  GLA.buildSystemInstruction = buildSystemInstruction;
  GLA.modelById = modelById;
  GLA.modelSupportsSearch = modelSupportsSearch;
  GLA.searchEnabled = searchEnabled;
  GLA.RETIRED_MODELS = RETIRED_MODELS;

  GLA.wsUrl = function (apiKey) {
    /* service sudah memuat versi API (…v1beta.GenerativeService…), jangan
     * menambahkannya lagi atau URL akan 404. */
    return 'wss://' + API.host + '/ws/' + API.service + '?key=' + encodeURIComponent(apiKey);
  };
})(typeof window !== 'undefined' ? window : globalThis);
