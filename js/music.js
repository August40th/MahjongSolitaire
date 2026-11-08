'use strict';
/* =====================================================================================================
   AMBIENT MUSIC (from Rainbow Runner): a never-ending, randomly composed sequence on the five black keys
   of a piano. Everything is synthesised here (no sound files). A direct port of the Python engine:
     - MusicCommon():  the shared engine code (settings, note synthesis, composer, mixer, effects)
     - a Web Worker builds the notes in the background,
     - an AudioWorklet composes, mixes and applies phaser / flanger / echo / reverb in real time,
     - MusicPlayer is what the game talks to (same API as the Python AmbientMusic).
   MusicCommon is a self-contained function so its source can be copied into the worker and the worklet.
   ===================================================================================================== */

function MusicCommon() {
  const MUS_RATE = 22050;                     // samples per second (the engine always runs at this rate)
  const MUS_N = 512;                          // frames per processing block (23 ms)
  const MUS_INSTRUMENTS = ['Piano', 'Koto', 'Steel drum', 'Kalimba'];
  const MUS_DEFAULTS = { on: true, inst: 'Piano', oct_lo: 2, oct_n: 4, density: 10, long: 3, voices: 4, vol: 7,
                         rev_mix: 8, rev_len: 8, dly_mix: 4, dly_time: 7, pha_mix: 9, pha_rate: 8,
                         fla_mix: 10, fla_rate: 8 };
  const MUS_LIMITS = { oct_lo: [1, 6], oct_n: [1, 4], density: [1, 15], long: [0, 10], voices: [1, 4],
                       vol: [0, 10], rev_mix: [0, 10], rev_len: [1, 10], dly_mix: [0, 10], dly_time: [1, 10],
                       pha_mix: [0, 10], pha_rate: [1, 10], fla_mix: [0, 10], fla_rate: [1, 10] };
  const BLACK_PCS = [1, 3, 6, 8, 10];         // C#  D#  F#  G#  A#
  const NOTE_NAMES = { 1: 'C#', 3: 'D#', 6: 'F#', 8: 'G#', 10: 'A#' };

  /* A complete, valid settings object from whatever was saved. */
  function musicClean(d) {
    const out = Object.assign({}, MUS_DEFAULTS);
    if (d && typeof d === 'object') {
      for (const k of Object.keys(d)) {
        const v = d[k];
        if (k === 'on') out.on = !!v;
        else if (k === 'inst' && MUS_INSTRUMENTS.indexOf(v) >= 0) out.inst = v;
        else if (Object.prototype.hasOwnProperty.call(MUS_LIMITS, k) && typeof v === 'number' && isFinite(v)) {
          out[k] = Math.max(MUS_LIMITS[k][0], Math.min(MUS_LIMITS[k][1], Math.trunc(v)));
        }
      }
    }
    out.oct_lo = Math.min(out.oct_lo, 7 - out.oct_n);
    return out;
  }

  /* Every black-key MIDI note inside the chosen octave range, low to high. */
  function musicPitches(p) {
    const out = [];
    for (let o = p.oct_lo; o < p.oct_lo + p.oct_n; o++) for (const pc of BLACK_PCS) out.push(12 * (o + 1) + pc);
    return out;
  }

  function musicNoteName(m) { return (NOTE_NAMES[m % 12] || '?') + (Math.floor(m / 12) - 1); }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ---------------------------------------------------------------- note synthesis */
  /* A grand piano note, added into buf. What makes it a piano and not a keyboard: every partial is slightly
     stretched (stiff strings), every partial is TWO strings tuned a fraction of a cent apart (they beat and
     shimmer), the sound dies in two stages (a quick "prompt" fall, then a long "after-ring"), higher
     partials die sooner, the hammer strikes a point on the string (some partials are weak), and the felt
     hammer adds a soft thump at the start. */
  function grandPiano(buf, f, midi, ls) {
    const n = buf.length;
    const rnd = mulberry32(midi * 7 + 1);
    const uni = (a, b) => a + (b - a) * rnd();
    const R = MUS_RATE;
    const twoPi = 2.0 * Math.PI;
    const bigB = 0.00012 * Math.exp((midi - 48) / 16.0);                    // string stiffness: stretched partials
    const tau1 = Math.max(0.35, Math.min(4.0, 1.7 * Math.pow(261.6 / f, 0.55))) * ls;   // low notes ring longer
    for (let k = 1; k <= 18; k++) {
      const fk = k * f * Math.sqrt(1.0 + bigB * k * k);
      if (fk > R * 0.45) break;
      const amp = Math.abs(Math.sin(Math.PI * k * 0.12)) / Math.pow(k, 0.75) * Math.exp(-(k - 1) * 0.11);
      if (amp < 0.004) continue;
      const t1 = tau1 / (1.0 + 0.35 * Math.pow(k - 1, 1.1));
      const t2 = t1 * 4.5;
      const m = Math.min(n, Math.floor(R * t2 * 6.0));
      const d1 = Math.exp(-1.0 / (R * t1));
      const d2 = Math.exp(-1.0 / (R * t2));
      const cents = uni(0.3, 0.9) / 1200.0 * Math.log(2.0);
      const wa = twoPi * fk * (1.0 + cents) / R;
      const wb = twoPi * fk * (1.0 - cents) / R;
      const pa = uni(0, twoPi);
      const pb = uni(0, twoPi);
      let e1 = 0.6 * amp * 0.5;
      let e2 = 0.4 * amp * 0.5;
      // two sine oscillators by rotation (much cheaper than a sin() per sample)
      const ca = Math.cos(wa), sa = Math.sin(wa), cb = Math.cos(wb), sb = Math.sin(wb);
      let xa = Math.cos(pa), ya = Math.sin(pa), xb = Math.cos(pb), yb = Math.sin(pb);
      for (let i = 0; i < m; i++) {
        buf[i] += (e1 + e2) * (ya + yb);
        let t = xa * ca - ya * sa; ya = xa * sa + ya * ca; xa = t;
        t = xb * cb - yb * sb; yb = xb * sb + yb * cb; xb = t;
        e1 *= d1;
        e2 *= d2;
        if (e1 + e2 < 1e-7) break;                                          // inaudible from here on
      }
    }
    let lp = 0.0;                                                           // the hammer's felt thump
    const a = Math.min(0.9, 2.0 * Math.PI * Math.min(2500.0, f * 3.0) / R);
    const lim = Math.floor(0.06 * R);
    for (let i = 0; i < lim; i++) {
      lp += a * (uni(-1.0, 1.0) - lp);
      buf[i] += 0.55 * lp * Math.exp(-i / (0.008 * R));
    }
  }

  /* One note of an instrument as mono floats (peak 0.8). Additive synthesis: a handful of partials, each
     with its own decay; `long` stretches every decay so the note rings on. */
  function synthNote(inst, midi, long) {
    const R = MUS_RATE;
    const f = 440.0 * Math.pow(2.0, (midi - 69) / 12.0);
    const secs = long ? 10.0 : 7.0;
    const n = Math.floor(R * secs);
    const ls = long ? 2.6 : 1.0;
    const tl = Math.max(0.55, Math.min(1.6, Math.pow(261.6 / f, 0.35)));    // low notes ring longer
    let bend = 0.0;
    let parts = [];
    if (inst === 'Koto') {
      for (let k = 1; k <= 8; k++) parts.push([k, 1.0 / Math.pow(k, 0.8), 2.0 * tl / Math.pow(k, 0.75)]);
      parts.push([1.004, 0.25, 1.4 * tl]);                                  // a faint second string: slight shimmer
      bend = 0.011;
    } else if (inst === 'Steel drum') {
      parts = [[1.0, 1.0, 2.4 * tl], [1.003, 0.45, 2.1 * tl], [2.0, 0.75, 1.7 * tl], [3.0, 0.38, 1.0 * tl],
               [4.01, 0.20, 0.6 * tl], [5.98, 0.08, 0.35 * tl], [2.76, 0.12, 0.18 * tl]];
    } else if (inst !== 'Piano') {                                          // Kalimba
      parts = [[1.0, 1.0, 2.6 * tl], [2.0, 0.16, 1.1 * tl], [5.4, 0.30, 0.24 * tl], [8.9, 0.09, 0.10 * tl]];
    }
    const buf = new Float64Array(n);
    const twoPi = 2.0 * Math.PI;
    if (inst === 'Piano') grandPiano(buf, f, midi, ls);
    for (const [ratio, amp, tau0] of parts) {
      const fr = f * ratio;
      if (fr > R * 0.45) continue;
      const tau = tau0 * ls;
      const m = Math.min(n, Math.floor(R * tau * 7.0));
      const dec = Math.exp(-1.0 / (R * tau));
      const w = twoPi * fr / R;
      let e = amp;
      if (bend) {
        const tb = 0.06 * R;
        for (let i = 0; i < m; i++) {
          buf[i] += e * Math.sin(w * (i + bend * tb * (1.0 - Math.exp(-i / tb))));
          e *= dec;
        }
      } else {
        for (let i = 0; i < m; i++) {
          buf[i] += e * Math.sin(w * i);
          e *= dec;
        }
      }
    }
    for (let i = 0; i < 80; i++) buf[i] *= i / 80.0;                        // a soft attack: no click
    let peak = 0;
    for (let i = 0; i < n; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    if (!peak) peak = 1.0;
    const k = 0.8 / peak;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = buf[i] * k;
    return out;
  }

  const noteKey = (inst, midi, long) => inst + '|' + midi + '|' + (long ? 1 : 0);
  const clamp1 = (v) => (v > 1 ? 1 : (v < -1 ? -1 : v));

  /* ---------------------------------------------------------------- the player's engine */
  /* Composes notes, mixes up to four voices and runs them through phaser, flanger, echo and reverb.
     block() makes 23 ms of stereo audio (512 frames at 22050 Hz). */
  class AmbientEngine {
    constructor(settings, rng) {
      this.p = musicClean(settings);
      this.rng = rng || Math.random;
      this.notes = new Map();
      this.voices = [];
      this.t = 0;                                         // frames rendered so far
      this.nextOn = Math.trunc(0.6 * MUS_RATE);
      this.recent = [];                                   // the last pitches played
      this.tri = [];                                      // recent three-note shapes
      this.ivs = [];                                      // recent intervals
      this.reg = {};                                      // how often each octave was used lately
      this.fade = 0.0;
      this.L = new Float32Array(MUS_N);
      this.R = new Float32Array(MUS_N);
      // effect state
      this.phaPh = 0.0;
      this.phaSt = [new Float64Array(8), new Float64Array(8)];
      this.flaPh = 0.0;
      this.dryL = new Float32Array(2048);
      this.dryR = new Float32Array(2048);
      this.dryN = 0;
      this.echoBuf = new Float32Array(65536);
      this.echoN = 0;
      this.combs = [0, 1].map(() => this.COMB_MS[0].map(() => new Float32Array(4096)));
      this.combN = 0;
      this.COMB_MS_USE = this.COMB_MS;
    }

    get COMB_MS() { return [[24.1, 29.7, 37.1, 41.1, 47.3, 53.9], [25.3, 31.9, 35.3, 43.3, 49.9, 57.1]]; }

    addNote(inst, midi, long, data) { this.notes.set(noteKey(inst, midi, long), data); }
    getNote(inst, midi, long) { return this.notes.get(noteKey(inst, midi, long)); }
    forget(keepInst) { for (const k of Array.from(this.notes.keys())) if (k.split('|')[0] !== keepInst) this.notes.delete(k); }
    reset() { this.voices = []; this.fade = 0.0; }

    /* ----- composing ----- */
    choices(cands, weights) {
      let total = 0;
      for (const w of weights) total += w;
      let r = this.rng() * total;
      for (let i = 0; i < cands.length; i++) { r -= weights[i]; if (r < 0) return cands[i]; }
      return cands[cands.length - 1];
    }

    /* Pick the next pitch: black keys only, not a recent note, spread away from the notes already sounding,
       and never a shape (three notes in a row) that was heard a moment ago. */
    choose() {
      const p = this.p;
      const pits = musicPitches(p).filter(m => this.getNote(p.inst, m, false) !== undefined);
      if (!pits.length) return null;
      const sounding = this.voices.map(v => v.midi);
      const last = this.recent;
      let cands = [], weights = [];
      for (const m of pits) {
        if (last.slice(-4).indexOf(m) >= 0) continue;
        if (last.length && m % 12 === last[last.length - 1] % 12) continue;           // same key, other octave: too alike
        if (last.slice(-5).filter(x => x % 12 === m % 12).length >= 2) continue;
        if (last.length >= 2 && this.tri.some(t => t[0] === last[last.length - 2] && t[1] === last[last.length - 1] && t[2] === m)) continue;
        if (last.length >= 2 && this.ivs.length >= 2 && m - last[last.length - 1] === this.ivs[this.ivs.length - 1] &&
            this.ivs[this.ivs.length - 1] === this.ivs[this.ivs.length - 2]) continue;   // no endless ladders
        let w = 1.0;
        if (sounding.length) {
          const d = Math.min(...sounding.map(s => Math.abs(m - s)));
          w *= d < 3 ? 0.08 : (d < 6 ? 0.5 : 1.0);                                   // keep the voices spread out
        }
        w *= 1.0 / (1.0 + (this.reg[Math.floor(m / 12)] || 0.0));                    // visit every octave
        if (last.length) w *= Math.abs(m - last[last.length - 1]) <= 9 ? 1.0 : 0.6;
        cands.push(m);
        weights.push(w);
      }
      if (!cands.length) {
        const c = pits.filter(m => last.slice(-2).indexOf(m) < 0);
        cands = c.length ? c : pits;
        weights = cands.map(() => 1.0);
      }
      const m = this.choices(cands, weights);
      if (last.length) {
        this.ivs.push(m - last[last.length - 1]);
        if (this.ivs.length > 6) this.ivs.splice(0, this.ivs.length - 6);
      }
      if (last.length >= 2) {
        this.tri.push([last[last.length - 2], last[last.length - 1], m]);
        if (this.tri.length > 24) this.tri.splice(0, this.tri.length - 24);
      }
      last.push(m);
      if (last.length > 12) last.splice(0, last.length - 12);
      for (const k of Object.keys(this.reg)) this.reg[k] *= 0.9;
      const oc = Math.floor(m / 12);
      this.reg[oc] = (this.reg[oc] || 0.0) + 1.0;
      return m;
    }

    /* Average seconds between notes: 9 s at density 1 down to 0.28 s (3.6 notes a second) at 15. */
    meanGap() { return 9.0 * Math.pow(0.78, this.p.density - 1); }

    gap() {
      const mean = this.meanGap();
      let g = mean * (0.35 + Math.min(3.0, -Math.log(1.0 - this.rng())) * 0.65);
      if (this.rng() < 0.10) g *= 0.3;
      return Math.max(0.12, g);
    }

    spawn() {
      const p = this.p, rng = this.rng;
      if (this.voices.length >= p.voices) return false;
      const m = this.choose();
      if (m === null) return false;
      let long = rng() < p.long * 0.1;
      let data = this.getNote(p.inst, m, long);
      if (data === undefined) {
        long = false;
        data = this.getNote(p.inst, m, false);
        if (data === undefined) return false;
      }
      let sf = Math.max(0.15, Math.min(1.0, 0.2 * this.meanGap() * p.voices));      // busy music: shorter notes
      let hold, fade;
      if (long) {
        sf = Math.max(sf, 0.35);
        hold = (6.0 + 2.0 * rng()) * sf; fade = (2.0 + 0.8 * rng()) * sf;
      } else {
        hold = (1.6 + 2.6 * rng()) * sf; fade = (1.0 + 0.8 * rng()) * sf;
      }
      const pits = musicPitches(p);
      const pos = (m - pits[0]) / Math.max(1, pits[pits.length - 1] - pits[0]);
      const pan = Math.max(-0.85, Math.min(0.85, (pos - 0.5) * 0.9 + (-0.3 + 0.6 * rng())));
      const vel = (0.55 + 0.45 * rng()) * (long ? 0.85 : 1.0);
      this.voices.push({ midi: m, buf: data, pos: 0, hold: Math.trunc(hold * MUS_RATE), fade: Math.trunc(fade * MUS_RATE),
                         gl: vel * Math.sqrt((1.0 - pan) / 2.0), gr: vel * Math.sqrt((1.0 + pan) / 2.0) });
      return true;
    }

    /* ----- rendering ----- */
    voicesBlock(L, R) {
      const N = MUS_N;
      L.fill(0); R.fill(0);
      const keep = [];
      for (const v of this.voices) {
        const a = v.pos;
        const buf = v.buf;
        const len = buf.length;
        for (let s = 0; s < 4; s++) {
          const fr = a + s * 128 + 64;
          let g;
          if (fr <= v.hold) g = 1.0;
          else { const x = (fr - v.hold) / v.fade; g = Math.pow(Math.max(0.0, 1.0 - x), 1.5); }
          const fac = g * 0.34;
          for (let j = 0; j < 128; j++) {
            const idx = a + s * 128 + j;
            if (idx >= len) break;
            const m = buf[idx] * fac;
            L[s * 128 + j] += m * v.gl;
            R[s * 128 + j] += m * v.gr;
          }
        }
        v.pos = a + N;
        if (v.pos < Math.min(v.hold + v.fade, len)) keep.push(v);
      }
      this.voices = keep;
      for (let i = 0; i < N; i++) { L[i] = clamp1(L[i]); R[i] = clamp1(R[i]); }
    }

    phaser(L, R, mix) {
      const N = MUS_N;
      const m = mix * 0.1 * 0.6;
      const rate = 0.05 + 0.09 * this.p.pha_rate;
      this.phaPh += 2.0 * Math.PI * rate * N / MUS_RATE;
      const keep = 1.0 - m;
      [L, R].forEach((a, ch) => {
        const lf = 0.5 + 0.5 * Math.sin(this.phaPh + ch * 1.4);
        const fc = 250.0 + 1700.0 * lf * lf;
        const tn = Math.tan(Math.PI * fc / MUS_RATE);
        const c = (tn - 1.0) / (tn + 1.0);
        const st = this.phaSt[ch];
        let x1 = st[0], y1 = st[1], x2 = st[2], y2 = st[3], x3 = st[4], y3 = st[5], x4 = st[6], y4 = st[7];
        for (let i = 0; i < N; i++) {
          const s = a[i];
          let y = c * s + x1 - c * y1;
          x1 = s; y1 = y;
          let z = c * y + x2 - c * y2;
          x2 = y; y2 = z;
          y = c * z + x3 - c * y3;
          x3 = z; y3 = y;
          z = c * y + x4 - c * y4;
          x4 = y; y4 = z;
          a[i] = clamp1(s * keep + z * m);
        }
        st[0] = x1; st[1] = y1; st[2] = x2; st[3] = y2; st[4] = x3; st[5] = y3; st[6] = x4; st[7] = y4;
      });
    }

    pushDry(L, R) {
      const M = 2047;
      for (let i = 0; i < MUS_N; i++) { this.dryL[(this.dryN + i) & M] = L[i]; this.dryR[(this.dryN + i) & M] = R[i]; }
    }

    flanger(L, R, mix) {
      const N = MUS_N;
      this.flaPh += 2.0 * Math.PI * (0.04 + 0.05 * this.p.fla_rate) * N / MUS_RATE;
      const d = Math.trunc(MUS_RATE * (0.0018 + 0.0014 * Math.sin(this.flaPh)));    // 0.4 .. 3.2 ms
      this.pushDry(L, R);                                                           // the dry signal, incl. this block
      const M = 2047;
      const k = mix * 0.1 * 0.45;
      const n0 = this.dryN;
      for (let i = 0; i < N; i++) {
        const j = (n0 + i - d) & M;
        L[i] = clamp1(L[i] * (1.0 - k * 0.5) + this.dryL[j] * k);
        R[i] = clamp1(R[i] * (1.0 - k * 0.5) + this.dryR[j] * k);
      }
    }

    echo(L, R, mix) {
      const N = MUS_N, M = 65535;
      const dl = Math.max(N + 16, Math.trunc(MUS_RATE * (0.12 + 0.075 * this.p.dly_time)));
      const dl2 = Math.trunc(dl * 1.5);
      const n0 = this.echoN;
      const k = mix * 0.1 * 0.8;
      const t1 = new Float32Array(N), t2 = new Float32Array(N);
      for (let i = 0; i < N; i++) { t1[i] = this.echoBuf[(n0 + i - dl) & M]; t2[i] = this.echoBuf[(n0 + i - dl2) & M]; }
      for (let i = 0; i < N; i++) {
        const mono = 0.5 * L[i] + 0.5 * R[i];
        this.echoBuf[(n0 + i) & M] = clamp1(mono + t1[i] * 0.42);
        L[i] = clamp1(L[i] + t1[i] * k);
        R[i] = clamp1(R[i] + t2[i] * k);
      }
      this.echoN += N;
    }

    pushEchoMono(L, R) {
      const N = MUS_N, M = 65535;
      for (let i = 0; i < N; i++) this.echoBuf[(this.echoN + i) & M] = 0.5 * L[i] + 0.5 * R[i];
      this.echoN += N;
    }

    reverb(L, R, mix) {
      const N = MUS_N, M = 4095;
      const g = 0.62 + 0.032 * this.p.rev_len;                                      // feedback: 0.65 .. 0.94
      const n0 = this.combN;
      const mono = new Float32Array(N);
      for (let i = 0; i < N; i++) mono[i] = 0.5 * L[i] + 0.5 * R[i];
      const outs = [new Float32Array(N), new Float32Array(N)];
      for (let side = 0; side < 2; side++) {
        const delays = this.COMB_MS[side];
        for (let j = 0; j < delays.length; j++) {
          const dl = Math.trunc(MUS_RATE * delays[j] / 1000.0);
          const ring = this.combs[side][j];
          const acc = outs[side];
          for (let i = 0; i < N; i++) {
            const lp = 0.5 * ring[(n0 + i - dl) & M] + 0.5 * ring[(n0 + i - dl - 1) & M];   // darker with every pass
            const y = clamp1(mono[i] + g * lp);
            ring[(n0 + i) & M] = y;
            acc[i] = clamp1(acc[i] + y);
          }
        }
      }
      const k = mix * 0.1 * 0.17 * (1.25 - g);
      for (let i = 0; i < N; i++) {
        L[i] = clamp1(L[i] + outs[0][i] * k);
        R[i] = clamp1(R[i] + outs[1][i] * k);
      }
      this.combN += N;
    }

    /* The next 23 ms of the music: 512 stereo frames (floats, -1..1). Returns [left, right]. */
    block() {
      const p = this.p;
      this.t += MUS_N;
      if (this.t >= this.nextOn) {
        if (this.spawn()) this.nextOn = this.t + Math.trunc(this.gap() * MUS_RATE);
        else this.nextOn = this.t + Math.trunc(0.12 * MUS_RATE);
      }
      const L = this.L, R = this.R;
      this.voicesBlock(L, R);
      if (p.pha_mix) this.phaser(L, R, p.pha_mix);
      if (p.fla_mix) this.flanger(L, R, p.fla_mix); else this.pushDry(L, R);
      this.dryN += MUS_N;
      if (p.dly_mix) this.echo(L, R, p.dly_mix); else this.pushEchoMono(L, R);
      this.reverb(L, R, p.rev_mix ? p.rev_mix : 0.0);
      const vol = Math.pow(p.vol / 10.0, 2) * 3.0;
      this.fade = Math.min(1.0, this.fade + MUS_N / (2.0 * MUS_RATE));
      const gain = vol * this.fade;
      for (let i = 0; i < MUS_N; i++) { L[i] = clamp1(L[i] * gain); R[i] = clamp1(R[i] * gain); }
      return [L, R];
    }

    /* Offline: seconds of music as two Float32Arrays (used by tests). */
    render(seconds) {
      const blocks = Math.floor(seconds * MUS_RATE / MUS_N);
      const L = new Float32Array(blocks * MUS_N), R = new Float32Array(blocks * MUS_N);
      for (let b = 0; b < blocks; b++) {
        const [l, r] = this.block();
        L.set(l, b * MUS_N); R.set(r, b * MUS_N);
      }
      return [L, R];
    }
  }

  return { MUS_RATE, MUS_N, MUS_INSTRUMENTS, MUS_DEFAULTS, MUS_LIMITS, BLACK_PCS, NOTE_NAMES, musicClean,
           musicPitches, musicNoteName, mulberry32, synthNote, noteKey, AmbientEngine };
}

/* ---------------------------------------------------------------- Web Worker: builds the notes */
function musicWorkerMain(C) {
  let queue = [];
  let busy = false;
  async function run() {
    busy = true;
    while (queue.length) {
      const [inst, midi, long] = queue.shift();
      let data = null;
      try { data = C.synthNote(inst, midi, long); } catch (e) { data = null; }
      if (data) postMessage({ inst, midi, long, data }, [data.buffer]);
      await new Promise(r => setTimeout(r, 0));               // let a new "want" message in
    }
    busy = false;
  }
  onmessage = (e) => {
    if (e.data && e.data.cmd === 'want') { queue = e.data.keys.slice(); if (!busy) run(); }
  };
}

/* ---------------------------------------------------------------- AudioWorklet: the real-time engine */
function musicWorkletMain(C) {
  class MahjongMusic extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const po = (options && options.processorOptions) || {};
      this.engine = new C.AmbientEngine(po.p);
      this.running = false;
      this.CAP = 8192;
      this.fl = new Float32Array(this.CAP);
      this.fr = new Float32Array(this.CAP);
      this.wi = 0;                                   // engine frames produced so far
      this.rp = 0;                                   // read position (engine frames, fractional)
      this.step = C.MUS_RATE / sampleRate;           // engine frames per output frame
      this.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'note') this.engine.addNote(m.inst, m.midi, m.long, m.data);
        else if (m.type === 'forget') this.engine.forget(m.inst);
        else if (m.type === 'params') this.engine.p = m.p;
        else if (m.type === 'start') { this.engine.reset(); this.wi = 0; this.rp = 0; this.running = true; }
        else if (m.type === 'stop') { this.running = false; }
      };
    }
    process(inputs, outputs) {
      const out = outputs[0];
      const L = out[0];
      const R = out.length > 1 ? out[1] : out[0];
      const n = L.length;
      if (!this.running) { L.fill(0); if (R !== L) R.fill(0); return true; }
      const CAP = this.CAP;
      for (let i = 0; i < n; i++) {
        const i0 = Math.floor(this.rp);
        while (this.wi < i0 + 2) {
          const [bl, br] = this.engine.block();
          for (let j = 0; j < C.MUS_N; j++) {
            this.fl[(this.wi + j) % CAP] = bl[j];
            this.fr[(this.wi + j) % CAP] = br[j];
          }
          this.wi += C.MUS_N;
        }
        const fr = this.rp - i0;
        const a = i0 % CAP, b = (i0 + 1) % CAP;
        L[i] = this.fl[a] + (this.fl[b] - this.fl[a]) * fr;
        R[i] = this.fr[a] + (this.fr[b] - this.fr[a]) * fr;
        this.rp += this.step;
      }
      return true;
    }
  }
  registerProcessor('mahjong-music', MahjongMusic);
}

/* ---------------------------------------------------------------- MusicPlayer: what the game uses */
const MUSIC = MusicCommon();

class MusicPlayer {
  constructor(settings) {
    this.p = MUSIC.musicClean(settings);
    this.ctx = null;
    this.node = null;
    this.worker = null;
    this.analyser = null;
    this.running = false;
    this.error = '';
    this.have = new Set();
    this.haveInst = null;
    this.sig = null;
    this.starting = null;
    this.notesReady = 0;
  }

  get available() {
    return typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext) &&
           !!window.AudioWorklet && !!window.Worker && !!window.Blob && !!(window.URL && URL.createObjectURL);
  }

  set(kw) {
    const q = Object.assign({}, this.p, kw);
    this.p = MUSIC.musicClean(q);
    if (this.running && this.node) {
      this.node.port.postMessage({ type: 'params', p: this.p });
      this.syncBank();
    }
  }

  syncBank() {
    const p = this.p;
    const sig = [p.inst, p.oct_lo, p.oct_n, p.long > 0].join('|');
    if (sig === this.sig) return;
    this.sig = sig;
    const order = MUSIC.musicPitches(p);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    let keys = order.map(m => [p.inst, m, false]);
    if (p.long > 0) keys = keys.concat(order.map(m => [p.inst, m, true]));
    if (this.haveInst !== p.inst) {                              // forget the other instruments
      this.have.clear();
      this.haveInst = p.inst;
      this.node.port.postMessage({ type: 'forget', inst: p.inst });
    }
    this.worker.postMessage({ cmd: 'want', keys: keys.filter(k => !this.have.has(MUSIC.noteKey(k[0], k[1], k[2]))) });
  }

  /* Must be called from a click or key press the first time (browsers only allow sound after one). */
  start() {
    if (!this.available) return Promise.resolve(false);
    if (this.running) return Promise.resolve(true);
    if (this.starting) return this.starting;
    const AC = window.AudioContext || window.webkitAudioContext;
    try {
      if (!this.ctx) {
        try { this.ctx = new AC({ sampleRate: MUSIC.MUS_RATE, latencyHint: 'playback' }); }
        catch (e) { this.ctx = new AC({ latencyHint: 'playback' }); }
      }
      const resumed = this.ctx.resume();
      this.error = '';
      this.starting = (async () => {
        try {
          await resumed;
          if (!this.node) {
            const src = MusicCommon.toString() + '\n(' + musicWorkletMain.toString() + ')(MusicCommon());';
            // A page opened straight from disk (file://) may not load blob: modules, so fall back to a data: URL.
            const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
            try { await this.ctx.audioWorklet.addModule(url); }
            catch (e1) { await this.ctx.audioWorklet.addModule('data:text/javascript;charset=utf-8,' + encodeURIComponent(src)); }
            URL.revokeObjectURL(url);
            this.node = new AudioWorkletNode(this.ctx, 'mahjong-music',
              { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { p: this.p } });
            this.analyser = this.ctx.createAnalyser();
            this.analyser.fftSize = 2048;
            this.node.connect(this.analyser);
            this.analyser.connect(this.ctx.destination);
            const wsrc = MusicCommon.toString() + '\n(' + musicWorkerMain.toString() + ')(MusicCommon());';
            const wurl = URL.createObjectURL(new Blob([wsrc], { type: 'text/javascript' }));
            this.worker = new Worker(wurl);
            URL.revokeObjectURL(wurl);
            this.worker.onmessage = (e) => {
              const m = e.data;
              if (m.inst !== this.p.inst) return;                // a note of an instrument no longer chosen
              this.have.add(MUSIC.noteKey(m.inst, m.midi, m.long));
              this.notesReady = this.have.size;
              this.node.port.postMessage({ type: 'note', inst: m.inst, midi: m.midi, long: m.long, data: m.data }, [m.data.buffer]);
            };
          }
          await this.ctx.resume();
          this.sig = null;
          this.node.port.postMessage({ type: 'params', p: this.p });
          this.node.port.postMessage({ type: 'start' });
          this.running = true;
          this.syncBank();
          return true;
        } catch (e) {
          this.error = String((e && e.message) || e);
          this.running = false;
          return false;
        } finally {
          this.starting = null;
        }
      })();
      return this.starting;
    } catch (e) {
      this.error = String((e && e.message) || e);
      return Promise.resolve(false);
    }
  }

  stop() {
    this.running = false;
    if (this.node) this.node.port.postMessage({ type: 'stop' });
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }
}

if (typeof module !== 'undefined') module.exports = { MusicCommon, musicWorkerMain, musicWorkletMain };
