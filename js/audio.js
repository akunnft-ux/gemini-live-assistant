/* =============================================================================
 * audio.js — Mesin audio: tangkap mic → PCM16 16 kHz, playback PCM16 24 kHz
 * -----------------------------------------------------------------------------
 * Satu AudioContext dipakai untuk dua arah (in/out) supaya lebih ringan.
 * Enkripsi: 16 kHz mono 16-bit little-endian (masuk), 24 kHz mono (keluar).
 *
 * Dua mesin, dipilih otomatis:
 *   worklet        — AudioWorkletNode (utama, jalan di thread audio)
 *   scriptprocessor— cadangan kalau addModule() gagal / tidak didukung
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});
  var DSP = GLA.DSP;

  function AudioEngine(opts) {
    opts = opts || {};
    this.onAudioChunk = opts.onAudioChunk || function () {};
    this.onPlaybackLevel = opts.onPlaybackLevel || function () {};
    this.onError = opts.onError || function () {};

    this.ctx = null;
    this.stream = null;
    this.src = null;
    this.captureNode = null;
    this.playbackNode = null;
    this.speakerGain = null;
    this.sinkGain = null;

    this.engine = 'none';
    this.running = false;
    this.muted = false;

    this.micLevel = 0;
    this.playbackLevel = 0;
    this.micAnalyser = null;
    this.playAnalyser = null;
    this._sinks = [];

    /* state khusus mesin cadangan */
    this._capLp = null;
    this._capRes = null;
    this._capChunk = null;
    this._capFilled = 0;
    this._capScratch = new Float32Array(64);
    this._capZeros = null;
    this._playRing = null;
    this._playRes = null;
    this._levelTimer = null;
  }

  var A = GLA.AUDIO;

  /* ---------------------------------------------------------------- utils - */

  function rmsLevel(int16) {
    var sum = 0;
    for (var i = 0; i < int16.length; i += 4) {
      var v = int16[i] / 32768;
      sum += v * v;
    }
    var n = Math.ceil(int16.length / 4);
    if (!n) return 0;
    var rms = Math.sqrt(sum / n);
    /* naikkan kontras supaya indikator bicara terlihat jelas */
    return Math.min(1, Math.pow(rms * 3.2, 0.65));
  }

  /* ---------------------------------------------------------------- start - */

  /* "Pemanasan" AudioContext. Harus dipanggil langsung di dalam event klik,
   * karena beberapa browser hanya mengizinkan resume() saat ada user gesture. */
  AudioEngine.prototype.prime = function () {
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) return Promise.resolve();
    try {
      if (!this.ctx) this.ctx = new Ctor();
    } catch (e) {
      return Promise.resolve();
    }
    if (this.ctx.state === 'running') return Promise.resolve();
    return this.ctx.resume().catch(function () {});
  };

  AudioEngine.prototype.start = function () {
    var self = this;

    if (this.running) return Promise.resolve(this.engine);
    if (!global.navigator || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(
        new Error(
          'Browser tidak mendukung perekaman mikrofon. Gunakan Chrome, Edge, Firefox, atau Safari terbaru.'
        )
      );
    }

    return navigator.mediaDevices
      .getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      })
      .then(function (stream) {
        self.stream = stream;
        var Ctor = global.AudioContext || global.webkitAudioContext;
        if (!Ctor) throw new Error('Web Audio tidak didukung browser ini.');
        if (!self.ctx) self.ctx = new Ctor();

        var canWorklet = !!(self.ctx.audioWorklet && global.AudioWorkletNode);
        if (!canWorklet) {
          self._setupFallback();
          return 'scriptprocessor';
        }
        return self.ctx.audioWorklet
          .addModule(GLA.Worklet.url())
          .then(function () {
            self._setupWorklet();
            return 'worklet';
          })
          .catch(function () {
            self._setupFallback();
            return 'scriptprocessor';
          });
      })
      .then(function (engine) {
        self.engine = engine;
        self.running = true;
        return self.ctx.resume().then(function () {
          return engine;
        });
      })
      .catch(function (err) {
        self._teardown();
        throw describeMediaError(err);
      });
  };

  function describeMediaError(err) {
    var n = (err && err.name) || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') {
      return new Error(
        'Izin mikrofon ditolak. Klik ikon gembok di address bar lalu izinkan akses mikrofon, lalu coba lagi.'
      );
    }
    if (n === 'NotFoundError' || n === 'OverconstrainedError') {
      return new Error('Tidak ada mikrofon yang terdeteksi pada perangkat ini.');
    }
    if (n === 'NotReadableError') {
      return new Error('Mikrofon sedang dipakai aplikasi lain. Tutup aplikasi itu lalu coba lagi.');
    }
    if (global.location && global.location.protocol === 'file:') {
      return new Error(
        (err && err.message ? err.message : 'Gagal membuka mikrofon.') +
          ' Catatan: beberapa browser (Safari) memblokir mikrofon pada file:// — buka lewat server lokal (python3 -m http.server) atau GitHub Pages.'
      );
    }
    return err;
  }

  /* ------------------------------------------------------- mesin worklet -- */

  AudioEngine.prototype._setupWorklet = function () {
    var self = this;
    this.src = this.ctx.createMediaStreamSource(this.stream);

    this.captureNode = new AudioWorkletNode(this.ctx, 'gla-capture', {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: {
        targetRate: A.input.targetRate,
        chunkSamples: A.input.chunkSamples
      }
    });
    this.captureNode.port.onmessage = function (e) {
      var int16 = new Int16Array(e.data);
      self.micLevel = rmsLevel(int16);
      self.onAudioChunk(int16);
    };
    this.src.connect(this.captureNode);

    this.playbackNode = new AudioWorkletNode(this.ctx, 'gla-playback', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { sourceRate: A.output.sourceRate }
    });
    this.playbackNode.port.onmessage = function (e) {
      if (e.data && e.data.type === 'level') self._setPlaybackLevel(e.data.size);
    };
    this.speakerGain = this.ctx.createGain();
    this.playbackNode.connect(this.speakerGain);
    this.speakerGain.connect(this.ctx.destination);
    this.playAnalyser = this._attachAnalyser(this.speakerGain);
    this.micAnalyser = this._attachAnalyser(this.src);

    if (this.muted) this.captureNode.port.postMessage('mute');
  };

  /* Analyser hanya di-proses browser kalau graf-nya sampai ke destination,
   * jadi sambungkan lewat gain 0 (tidak terdengar) sebagai "sink". */
  AudioEngine.prototype._attachAnalyser = function (node) {
    var an = this.ctx.createAnalyser();
    an.fftSize = 512;
    an.smoothingTimeConstant = 0.75;
    an.minDecibels = -90;
    an.maxDecibels = -18;
    var zero = this.ctx.createGain();
    zero.gain.value = 0;
    node.connect(an);
    an.connect(zero);
    zero.connect(this.ctx.destination);
    this._sinks.push(an, zero);
    return an;
  };

  /* Spektrum ternormalisasi 0..1 untuk visualizer. */
  AudioEngine.prototype.spectrum = function (which) {
    var an = which === 'play' ? this.playAnalyser : this.micAnalyser;
    if (!an) return null;
    if (!this._specBuf || this._specBuf.length !== an.frequencyBinCount) {
      this._specBuf = new Uint8Array(an.frequencyBinCount);
    }
    an.getByteFrequencyData(this._specBuf);
    return this._specBuf;
  };

  /* ------------------------------------------------- mesin scriptprocessor - */

  AudioEngine.prototype._setupFallback = function () {
    var self = this;
    this.src = this.ctx.createMediaStreamSource(this.stream);

    var rate = this.ctx.sampleRate;
    this._capLp = DSP.biquadLowpass(rate, A.input.targetRate * 0.45, 0.707);
    this._capRes = DSP.resampler(rate, A.input.targetRate);
    this._capChunk = new Int16Array(A.input.chunkSamples);
    this._capFilled = 0;

    this.captureNode = this.ctx.createScriptProcessor(4096, 1, 1);
    this.captureNode.onaudioprocess = function (e) {
      var ch = e.inputBuffer.getChannelData(0);
      if (self.muted) {
        /* Mute = digital silence, bukan hentikan capture (lihat catatan di
         * worklet.js). Chunk senyap tetap mengalir supaya koneksi WebSocket
         * tidak menganggur selama assistant bicara. */
        if (!self._capZeros || self._capZeros.length !== ch.length) {
          self._capZeros = new Float32Array(ch.length);
        }
        self._ingestInput(self._capZeros);
        return;
      }
      self._ingestInput(ch);
    };
    /* ScriptProcessor hanya berjalan kalau terhubung ke destination;
     * sambungkan lewat gain 0 supaya tidak menghasilkan feedback. */
    this.sinkGain = this.ctx.createGain();
    this.sinkGain.gain.value = 0;
    this.src.connect(this.captureNode);
    this.captureNode.connect(this.sinkGain);
    this.sinkGain.connect(this.ctx.destination);

    this._playRing = DSP.ring(48000);
    this._playRes = DSP.resampler(A.output.sourceRate, rate);
    this._playRes.reset(0);
    var ring = this._playRing;
    var res = this._playRes;
    /* WAJIB: resampler mode "pull" mengambil sample dari antrean lewat
     * .source. Tanpa baris ini nextOutput() selalu mengembalikan 0 → speaker
     * diam total, padahal transkrip tetap jalan. */
    res.source = function () {
      return ring.shift();
    };
    this.playbackNode = this.ctx.createScriptProcessor(4096, 1, 1);
    this.playbackNode.onaudioprocess = function (e) {
      var out = e.outputBuffer.getChannelData(0);
      for (var i = 0; i < out.length; i++) out[i] = res.nextOutput();
    };
    this.speakerGain = this.ctx.createGain();
    this.speakerGain.connect(this.playbackNode);
    this.playbackNode.connect(this.ctx.destination);
    /* Analyser playback harus menyentuh node SESUDAH playbackNode: audio
     * synthesized di onaudioprocess tidak pernah lewat speakerGain. */
    this.playAnalyser = this._attachAnalyser(this.playbackNode);
    this.micAnalyser = this._attachAnalyser(this.src);

    var self2 = this;
    this._levelTimer = setInterval(function () {
      self2._setPlaybackLevel(ring.size);
    }, 60);
  };

  AudioEngine.prototype._ingestInput = function (channel) {
    var chunk = this._capChunk;
    var chunkSize = chunk.length;
    for (var i = 0; i < channel.length; i++) {
      var s = this._capLp.process(channel[i]);
      var n = this._capRes.pushSample(s, this._capScratch, 0);
      for (var j = 0; j < n; j++) {
        var v = this._capScratch[j];
        if (v > 1) v = 1;
        else if (v < -1) v = -1;
        chunk[this._capFilled++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this._capFilled === chunkSize) {
          this._capFilled = 0;
          var int16 = chunk.subarray(0, chunkSize);
          this.micLevel = rmsLevel(int16);
          this.onAudioChunk(int16);
        }
      }
    }
  };

  AudioEngine.prototype._setPlaybackLevel = function (queueSize) {
    /* ~0.4 s buffer = nivel "sedang bicara" */
    var norm = Math.min(1, queueSize / (A.output.sourceRate * 0.4));
    this.playbackLevel = norm > 0.02 ? norm : 0;
    this.onPlaybackLevel(this.playbackLevel, queueSize);
  };

  /* -------------------------------------------------------------- output - */

  AudioEngine.prototype.enqueueOutput = function (int16) {
    if (!this.running) return;
    if (this.engine === 'worklet') {
      var copy = int16.buffer.slice(0);
      this.playbackNode.port.postMessage({ type: 'audio', buffer: copy }, [copy]);
    } else {
      this._playRing.writeInt16(int16);
    }
  };

  /* barge-in: buang sisa audio AI supaya tidak bicara di atas pengguna */
  AudioEngine.prototype.clearOutput = function () {
    this.playbackLevel = 0;
    if (!this.playbackNode) return;
    if (this.engine === 'worklet') {
      this.playbackNode.port.postMessage({ type: 'clear' });
    } else {
      this._playRing.clear();
      this._playRes.reset(0);
    }
  };

  AudioEngine.prototype.setMuted = function (muted) {
    this.muted = !!muted;
    if (muted) this.micLevel = 0;
    if (!this.captureNode) return;
    if (this.engine === 'worklet') {
      this.captureNode.port.postMessage(muted ? 'mute' : 'unmute');
    }
  };

  /* ---------------------------------------------------------------- stop -- */

  AudioEngine.prototype._teardown = function () {
    this.running = false;
    this.micLevel = 0;
    this.playbackLevel = 0;
    /* WAJIB: state mute harus ikut dibuang. Kalau tidak, sesi berikutnya
     * mulai dalam keadaan mute (capture di-mute lagi di _setupWorklet) dan
     * tidak ada yang meng-unmute-nya → mikrofon mati diam-diam. */
    this.muted = false;

    if (this._levelTimer) {
      clearInterval(this._levelTimer);
      this._levelTimer = null;
    }
    if (this.captureNode) {
      if (this.captureNode.port) this.captureNode.port.postMessage('stop');
      this.captureNode.onaudioprocess = null;
      if (this.captureNode.port) this.captureNode.port.onmessage = null;
      try {
        this.captureNode.disconnect();
      } catch (e) {}
    }
    if (this.playbackNode) {
      if (this.playbackNode.port) this.playbackNode.port.postMessage({ type: 'stop' });
      this.playbackNode.onaudioprocess = null;
      if (this.playbackNode.port) this.playbackNode.port.onmessage = null;
      try {
        this.playbackNode.disconnect();
      } catch (e) {}
    }
    if (this.speakerGain) {
      try {
        this.speakerGain.disconnect();
      } catch (e) {}
    }
    if (this.sinkGain) {
      try {
        this.sinkGain.disconnect();
      } catch (e) {}
    }
    if (this.src) {
      try {
        this.src.disconnect();
      } catch (e) {}
    }
    this._sinks.forEach(function (n) {
      try {
        n.disconnect();
      } catch (e) {}
    });
    this._sinks = [];
    this.micAnalyser = null;
    this.playAnalyser = null;
    if (this.stream) {
      this.stream.getTracks().forEach(function (t) {
        t.stop();
      });
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      try {
        this.ctx.close();
      } catch (e) {}
    }
    this.ctx = null;
    this.stream = null;
    this.src = null;
    this.captureNode = null;
    this.playbackNode = null;
    this.speakerGain = null;
    this.sinkGain = null;
    this._capChunk = null;
    this._capLp = null;
    this._capRes = null;
    this._capZeros = null;
    this._playRing = null;
    this._playRes = null;
    this.engine = 'none';
  };

  AudioEngine.prototype.stop = function () {
    this._teardown();
  };

  GLA.AudioEngine = AudioEngine;
  GLA.rmsLevel = rmsLevel;
})(typeof window !== 'undefined' ? window : globalThis);
