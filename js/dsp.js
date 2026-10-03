/* =============================================================================
 * dsp.js — Utilitas sinyal, dipakai oleh halaman UTAMA dan oleh AudioWorklet
 * -----------------------------------------------------------------------------
 * Fungsi di workletParts() di-stringify lalu dievaluasi ulang di dalam thread
 * AudioWorklet. Constraint penting:
 *   1. bentuknya factory function + object literal (BUKAN class dengan
 *      prototype.* di luar) — ClassName.toString() tidak menyertakan method
 *      prototype, sedangkan source object literal menyertakannya;
 *   2. setiap factory self-contained, tidak boleh merujuk fungsi di luar
 *      string tersebut;
 *   3. hanya boleh memakai API yang ada di AudioWorkletGlobalScope.
 * Justru karena satu implementasi dipakai dua tempat, algoritma resampling
 * tidak bisa berbeda antara mode worklet dan mode cadangan.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});

  /* ======================================================================== */
  /* workletParts() — seluruh kode yang harus hidup di thread audio           */
  /* ======================================================================== */

  function workletParts() {
    /* ------------------------------------------------------- biquad LPF --- */
    /* Low-pass RBJ cookbook. Memfilter sebelum downsampling 48k→16k supaya isi
     * spektrum di atas 8 kHz tidak terlipat (alias) menjadi suara sengau. */
    function biquadLowpass(fs, f0, Q) {
      var w0 = (2 * Math.PI * Math.min(f0, fs * 0.49)) / fs;
      var cw = Math.cos(w0);
      var sw = Math.sin(w0);
      var alpha = sw / (2 * (Q || 0.707));
      var a0 = 1 + alpha;
      var b0 = (1 - cw) / 2 / a0;
      var b1 = (1 - cw) / a0;
      var b2 = (1 - cw) / 2 / a0;
      var a1 = (-2 * cw) / a0;
      var a2 = (1 - alpha) / a0;
      var x1 = 0,
        x2 = 0,
        y1 = 0,
        y2 = 0;
      return {
        process: function (x) {
          var y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
          x2 = x1;
          x1 = x;
          y2 = y1;
          y1 = y;
          return y;
        },
        reset: function () {
          x1 = x2 = y1 = y2 = 0;
        }
      };
    }

    /* --------------------------------------------------- resampler linear - */
    /* Resampler streaming linear tanpa look-ahead.
     * step = sumber/destination = jumlah sample sumber per sample tujuan.
     * Dua mode berbagi state (prev/next/pos):
     *   nextOutput()  mode "pull" (sink)   → 1 sample output per panggilan
     *   pushSample()  mode "push" (source) → 1 sample input, 0..N output
     * Ada offset 1 sampel (62 µs) pada mode push; tidak audible. */
    function resampler(srcRate, dstRate) {
      var step = srcRate / dstRate;
      var pos = 0;
      var prev = 0;
      var next = 0;
      var primed = false;
      var self = {
        source: null,
        reset: function (v) {
          pos = 0;
          prev = next = v || 0;
          primed = true;
        },
        nextOutput: function () {
          if (pos >= 1) {
            prev = next;
            next = self.source ? self.source() : 0;
            pos -= 1;
          }
          var v = prev + (next - prev) * pos;
          pos += step;
          return v;
        },
        pushSample: function (sample, out, offset) {
          offset = offset || 0;
          if (!primed) {
            prev = next = sample;
            primed = true;
            return 0;
          }
          next = sample;
          var n = 0;
          while (pos < 1) {
            out[offset + n] = prev + (next - prev) * pos;
            n++;
            pos += step;
          }
          pos -= 1;
          prev = next;
          return n;
        }
      };
      return self;
    }

    /* --------------------------------------------------- ring buffer float - */
    /* Antrean playback: sample PCM16 yang masuk dari network. */
    function ring(capacity) {
      var buf = new Float32Array(capacity || 8192);
      var head = 0;
      var tail = 0;
      var size = 0;
      function grow() {
        var bigger = new Float32Array(buf.length * 2);
        for (var i = 0; i < size; i++) bigger[i] = buf[(head + i) % buf.length];
        buf = bigger;
        head = 0;
        tail = size;
      }
      return {
        get size() {
          return size;
        },
        push: function (v) {
          if (size === buf.length) grow();
          buf[tail] = v;
          tail = tail + 1 === buf.length ? 0 : tail + 1;
          size++;
        },
        shift: function () {
          if (size === 0) return 0;
          var v = buf[head];
          head = head + 1 === buf.length ? 0 : head + 1;
          size--;
          return v;
        },
        writeInt16: function (int16) {
          for (var i = 0; i < int16.length; i++) {
            this.push(int16[i] < 0 ? int16[i] / 32768 : int16[i] / 32767);
          }
        },
        clear: function () {
          head = 0;
          tail = 0;
          size = 0;
        }
      };
    }

    return { biquadLowpass: biquadLowpass, resampler: resampler, ring: ring };
  }

  var parts = workletParts();

  /* ======================================================================== */
  /* Utilitas konversi — hanya di halaman utama                              */
  /* ======================================================================== */

  /* Batas argumen untuk String.fromCharCode.apply. Beberapa engine (terutama
   * Safari lama) melempar RangeError kalau jumlah elemennya terlalu besar, dan
   * AudioWorklet tidak punya jalur base64 lain.
   *
   * WAJIB kelipatan 3. Base16 di-encode per potongan, jadi hanya potongan
   * terakhir boleh punya padding '='. Kalau ukuran potongan bukan kelipatan 3,
   * setiap potongan selain terakhir menghasilkan padding di tengah hasil —
   * dan string seperti "AAA=AAA=" BUKAN base64 yang valid: server memotongnya
   * di '=' pertama sehingga audio rusak atau frame ditolak. Dengan kelipatan 3
   * semua potongan middle bebas padding dan penggabungannya lossless.
   *
   * 8190 = 3 × 2730. Chunk audio 200 ms = 6400 byte, jadi di pemakaian normal
   * ini tetap satu kali panggilan (tanpa overhead loop). */
  var B64_CHUNK = 8190;

  function toBase64(int16) {
    var bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
    if (bytes.length <= B64_CHUNK) {
      return global.btoa(String.fromCharCode.apply(null, bytes));
    }
    var out = [];
    for (var i = 0; i < bytes.length; i += B64_CHUNK) {
      out.push(
        global.btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + B64_CHUNK)))
      );
    }
    return out.join('');
  }

  GLA.DSP = {
    biquadLowpass: parts.biquadLowpass,
    resampler: parts.resampler,
    ring: parts.ring,
    toBase64: toBase64,
    workletParts: workletParts,
    WORKLET_PARTS: [parts.biquadLowpass, parts.resampler, parts.ring]
  };
})(typeof window !== 'undefined' ? window : globalThis);
