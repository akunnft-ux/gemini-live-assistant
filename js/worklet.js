/* =============================================================================
 * worklet.js — Menyusun source code AudioWorklet dari fungsi di dsp.js
 * -----------------------------------------------------------------------------
 * AudioWorkletProcessor WAJIB dimuat lewat addModule(URL). Karena aplikasi ini
 * harus jalan dari file:// (fetch file lokal diblokir CORS), kita tidak bisa
 * memuat file .js terpisah. Solusinya: bangun source code sebagai string dari
 * fungsi yang sudah ada lalu jadikan Blob URL — ini selalu berhasil, baik di
 * file:// maupun di GitHub Pages.
 *
 * Cadangan: ScriptProcessorNode (lihat audio.js) dipakai kalau addModule gagal.
 * ========================================================================== */
(function (global) {
  'use strict';

  var GLA = (global.GLA = global.GLA || {});

  var PROCESSOR_SOURCE = [
    'class GLA_CAPTURE extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var o = (options && options.processorOptions) || {};',
    '    this.targetRate = o.targetRate || 16000;',
    '    this.chunkSamples = o.chunkSamples || 3200;',
    '    this.muted = false;',
    '    this.alive = true;',
    '    this.filled = 0;',
    '    this.chunk = new Int16Array(this.chunkSamples);',
    '    this.scratch = new Float32Array(64);',
    '    this.resampler = resampler(sampleRate, this.targetRate);',
    '    this.lp = biquadLowpass(sampleRate, this.targetRate * 0.45, 0.707);',
    '    this.port.onmessage = function (e) {',
    '      if (e.data === "mute") this.muted = true;',
    '      else if (e.data === "unmute") this.muted = false;',
    '      else if (e.data === "stop") this.alive = false;',
    '    }.bind(this);',
    '  }',
    '  flush() {',
    '    if (this.filled === 0) return;',
    '    var copy = this.chunk.buffer.slice(0, this.filled * 2);',
    '    this.filled = 0;',
    '    this.port.postMessage(copy, [copy]);',
    '  }',
    '  process(inputs) {',
    '    if (!this.alive) { this.flush(); return false; }',
    '    var ch = inputs[0] && inputs[0][0];',
    '    if (!ch || ch.length === 0 || this.muted) return true;',
    '    for (var i = 0; i < ch.length; i++) {',
    '      var s = this.lp.process(ch[i]);',
    '      var n = this.resampler.pushSample(s, this.scratch, 0);',
    '      for (var j = 0; j < n; j++) {',
    '        var v = this.scratch[j];',
    '        if (v > 1) v = 1; else if (v < -1) v = -1;',
    '        this.chunk[this.filled++] = v < 0 ? v * 0x8000 : v * 0x7fff;',
    '        if (this.filled === this.chunkSamples) this.flush();',
    '      }',
    '    }',
    '    return true;',
    '  }',
    '}',
    '',
    'class GLA_PLAYBACK extends AudioWorkletProcessor {',
    '  constructor(options) {',
    '    super();',
    '    var o = (options && options.processorOptions) || {};',
    '    this.sourceRate = o.sourceRate || 24000;',
    '    this.queue = ring(24000);',
    '    this.resampler = resampler(this.sourceRate, sampleRate);',
    '    this.resampler.reset(0);',
    '    var self = this;',
    '    this.resampler.source = function () { return self.queue.shift(); };',
    '    this.alive = true;',
    '    this.tick = 0;',
    '    this.port.onmessage = function (e) {',
    '      var d = e.data;',
    '      if (d.type === "audio") {',
    '        this.queue.writeInt16(new Int16Array(d.buffer));',
    '      } else if (d.type === "clear") {',
    '        this.queue.clear();',
    '        this.resampler.reset(0);',
    '      } else if (d.type === "stop") {',
    '        this.alive = false;',
    '      }',
    '    }.bind(this);',
    '  }',
    '  process(inputs, outputs) {',
    '    var out = outputs[0] && outputs[0][0];',
    '    if (out) {',
    '      for (var i = 0; i < out.length; i++) out[i] = this.resampler.nextOutput();',
    '    }',
    '    if (++this.tick % 16 === 0) {',
    '      this.port.postMessage({ type: "level", size: this.queue.size });',
    '    }',
    '    return this.alive;',
    '  }',
    '}',
    '',
    'registerProcessor("gla-capture", GLA_CAPTURE);',
    'registerProcessor("gla-playback", GLA_PLAYBACK);'
  ].join('\n');

  var source = GLA.DSP.WORKLET_PARTS.map(function (fn) {
    return fn.toString();
  }).join('\n');

  var blobURL = null;

  GLA.Worklet = {
    source: source + '\n' + PROCESSOR_SOURCE,
    name: 'gla-audio-worklet',

    /* Dipanggil sekali; mengembalikan Blob URL worklet. */
    url: function () {
      if (!blobURL) {
        var blob = new Blob([this.source], { type: 'application/javascript' });
        blobURL = URL.createObjectURL(blob);
      }
      return blobURL;
    },

    release: function () {
      if (blobURL) {
        URL.revokeObjectURL(blobURL);
        blobURL = null;
      }
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
