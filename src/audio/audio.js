// Fully synthesized audio (Web Audio API): generative ambient soundtrack with
// mood layers, plus structure-borne spacecraft sound effects. No samples.
//
//   const audio = new AudioEngine();
//   button.onclick = () => audio.unlock();   // must happen in a user gesture
//   audio.setMood('cruise');
//   audio.update(dt, { throttle, thrustActive, rcs, dynPressure, heatFlux, ... });
//   audio.play('score', { intensity: 0.5 });

const MOODS = ['menu', 'cruise', 'tension', 'reentry', 'victory', 'defeat'];

// Chord progressions (MIDI notes). Bright lydian-flavoured for calm moods,
// minor/suspended for tension.
const PROGRESSIONS = {
  calm: [
    [50, 57, 62, 66, 69, 76], // Dmaj9-ish
    [47, 54, 59, 62, 66, 73], // Bm11
    [43, 50, 55, 59, 61, 66], // Gmaj7#11 (lydian colour)
    [45, 52, 57, 61, 64, 71], // A add9
    [42, 49, 54, 57, 61, 64], // F#m7
    [43, 50, 57, 59, 62, 69], // Gmaj9
  ],
  dark: [
    [50, 57, 60, 65, 69, 72], // Dm9
    [46, 53, 58, 62, 65, 69], // Bbmaj7
    [43, 50, 55, 58, 62, 65], // Gm9
    [45, 52, 57, 59, 64, 67], // A7sus
  ],
};
// arpeggio scales (pentatonic over the chord root family)
const SCALE_CALM = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83, 86];
const SCALE_DARK = [62, 65, 67, 69, 72, 74, 77, 79, 81, 84];

const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// layer levels per mood (pad, sub, arp probability, bass, hats, drums, swell)
const MOOD_MIX = {
  menu: { pad: 0.55, sub: 0.35, arp: 0.22, bass: 0, hat: 0, drum: 0, swell: 0, dark: false, cutoff: 1400 },
  cruise: { pad: 0.45, sub: 0.3, arp: 0.32, bass: 0, hat: 0.15, drum: 0, swell: 0, dark: false, cutoff: 1700 },
  tension: { pad: 0.38, sub: 0.4, arp: 0.42, bass: 0.55, hat: 0.5, drum: 0, swell: 0.15, dark: true, cutoff: 1200 },
  reentry: { pad: 0.35, sub: 0.55, arp: 0.18, bass: 0.45, hat: 0.25, drum: 0.75, swell: 0.6, dark: true, cutoff: 900 },
  victory: { pad: 0.6, sub: 0.3, arp: 0.45, bass: 0, hat: 0.2, drum: 0, swell: 0, dark: false, cutoff: 2600 },
  defeat: { pad: 0.4, sub: 0.45, arp: 0.08, bass: 0, hat: 0, drum: 0, swell: 0, dark: true, cutoff: 700 },
};

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.volumes = { master: 0.8, music: 0.6, sfx: 0.85 };
    this.muted = false;
    this.mood = 'menu';
    this.pendingMood = 'menu';
    this.mix = { ...MOOD_MIX.menu };
    this.chordIndex = 0;
    this.step = 0;
    this.nextStepTime = 0;
    this.stepsUntilChord = 32;
    this.timer = null;
    this.analyser = null;
    this.lastHover = 0;
  }

  get ready() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /** Create / resume the AudioContext. Call from a user gesture; idempotent. */
  unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC({ latencyHint: 'playback' });
        this.build();
      }
      if (this.ctx.state !== 'running') this.ctx.resume?.();
      // iOS: play a silent buffer inside the gesture to fully unlock output
      if (!this._iosUnlocked) {
        const b = this.ctx.createBuffer(1, 1, 22050);
        const s = this.ctx.createBufferSource();
        s.buffer = b;
        s.connect(this.ctx.destination);
        s.start(0);
        this._iosUnlocked = true;
      }
    } catch (e) {
      console.warn('Audio unavailable', e);
    }
  }

  setVolumes({ master, music, sfx } = {}) {
    if (master !== undefined) this.volumes.master = clamp01(master);
    if (music !== undefined) this.volumes.music = clamp01(music);
    if (sfx !== undefined) this.volumes.sfx = clamp01(sfx);
    this.applyVolumes();
  }

  setMuted(m) {
    this.muted = !!m;
    this.applyVolumes();
  }

  applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.masterGain.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.05);
    this.musicGain.gain.setTargetAtTime(this.volumes.music * 0.55, t, 0.1);
    this.sfxGain.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
  }

  // ------------------------------------------------------------------ graph
  build() {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.masterGain = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -10;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.masterGain.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    this.musicGain = ctx.createGain();
    this.sfxGain = ctx.createGain();
    this.musicGain.connect(this.masterGain);
    this.sfxGain.connect(this.masterGain);

    // reverb (generated impulse) and feedback delay
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.makeImpulse(4.5, 2.6);
    this.reverbOut = ctx.createGain();
    this.reverbOut.gain.value = 0.9;
    this.reverb.connect(this.reverbOut);
    this.reverbOut.connect(this.musicGain);
    this.reverbSend = ctx.createGain();
    this.reverbSend.connect(this.reverb);

    this.delay = ctx.createDelay(2);
    this.delay.delayTime.value = 0.45;
    this.delayFb = ctx.createGain();
    this.delayFb.gain.value = 0.42;
    this.delayLp = ctx.createBiquadFilter();
    this.delayLp.type = 'lowpass';
    this.delayLp.frequency.value = 2600;
    this.delaySend = ctx.createGain();
    this.delaySend.connect(this.delay);
    this.delay.connect(this.delayLp);
    this.delayLp.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayLp.connect(this.musicGain);
    this.delayLp.connect(this.reverbSend);

    // sfx reverb send (shares the convolver but bypasses music volume)
    this.sfxVerb = ctx.createConvolver();
    this.sfxVerb.buffer = this.makeImpulse(2.2, 3);
    this.sfxVerb.connect(this.sfxGain);
    this.sfxVerbSend = ctx.createGain();
    this.sfxVerbSend.gain.value = 0.35;
    this.sfxVerbSend.connect(this.sfxVerb);

    // noise sources
    this.whiteBuf = this.makeNoise('white', 2);
    this.brownBuf = this.makeNoise('brown', 3);

    this.buildMusic();
    this.buildContinuous();
    this.applyVolumes();
    this.masterGain.gain.setValueAtTime(0, t);
    this.masterGain.gain.linearRampToValueAtTime(this.muted ? 0 : this.volumes.master, t + 1.5);

    this.nextStepTime = ctx.currentTime + 0.1;
    const tick = () => {
      this.schedule();
      this.timer = setTimeout(tick, 60);
    };
    tick();
  }

  makeImpulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const x = i / len;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - x, decay) * (x < 0.01 ? x / 0.01 : 1);
      }
    }
    return buf;
  }

  makeNoise(kind, seconds) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'brown') {
        last = (last + 0.02 * w) / 1.02;
        d[i] = last * 3.5;
      } else d[i] = w;
    }
    return buf;
  }

  loopNoise(buf) {
    const s = this.ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start();
    return s;
  }

  // ------------------------------------------------------------------ music
  buildMusic() {
    const ctx = this.ctx;
    // pad: 4 voices x 2 detuned saws, shared lowpass with slow LFO
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 1400;
    this.padFilter.Q.value = 0.7;
    this.padLevel = ctx.createGain();
    this.padLevel.gain.value = 0;
    this.padFilter.connect(this.padLevel);
    this.padLevel.connect(this.musicGain);
    this.padLevel.connect(this.reverbSend);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 500;
    lfo.connect(lfoAmt);
    lfoAmt.connect(this.padFilter.frequency);
    lfo.start();
    this.padVoices = [];
    const chord = PROGRESSIONS.calm[0];
    for (let v = 0; v < 4; v++) {
      const g = ctx.createGain();
      g.gain.value = 0.09;
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      const oscs = [-7, 7].map((det) => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = mtof(chord[v + 1]);
        o.detune.value = det + (Math.random() - 0.5) * 4;
        o.connect(g);
        o.start();
        return o;
      });
      // slow per-voice amplitude drift
      const vl = ctx.createOscillator();
      vl.frequency.value = 0.03 + Math.random() * 0.05;
      const vla = ctx.createGain();
      vla.gain.value = 0.035;
      vl.connect(vla);
      vla.connect(g.gain);
      vl.start();
      if (pan) {
        pan.pan.value = [-0.6, -0.2, 0.25, 0.6][v];
        g.connect(pan);
        pan.connect(this.padFilter);
      } else g.connect(this.padFilter);
      this.padVoices.push({ oscs, g });
    }
    // sub drone
    this.sub = ctx.createOscillator();
    this.sub.type = 'sine';
    this.sub.frequency.value = mtof(chord[0] - 12);
    this.subLevel = ctx.createGain();
    this.subLevel.gain.value = 0;
    this.sub.connect(this.subLevel);
    this.subLevel.connect(this.musicGain);
    this.sub.start();
    // swell: filtered noise with sweeping bandpass
    this.swellSrc = this.loopNoise(this.whiteBuf);
    this.swellFilter = ctx.createBiquadFilter();
    this.swellFilter.type = 'bandpass';
    this.swellFilter.Q.value = 3;
    this.swellFilter.frequency.value = 400;
    this.swellLevel = ctx.createGain();
    this.swellLevel.gain.value = 0;
    this.swellSrc.connect(this.swellFilter);
    this.swellFilter.connect(this.swellLevel);
    this.swellLevel.connect(this.musicGain);
    this.swellLevel.connect(this.reverbSend);
    this.applyMood(true);
  }

  setMood(mood) {
    if (!MOODS.includes(mood) || mood === this.mood) return;
    this.mood = mood;
    if (!this.ctx) return;
    if (mood === 'victory') this.victoryMotif();
    if (mood === 'defeat') this.defeatMotif();
    this.applyMood(false);
    clearTimeout(this._moodReturn);
    if (mood === 'victory' || mood === 'defeat') {
      this._moodReturn = setTimeout(() => {
        if (this.mood === mood) {
          this.mood = 'cruise';
          this.applyMood(false);
        }
      }, 9000);
    }
  }

  applyMood(immediate) {
    const m = MOOD_MIX[this.mood];
    const prevDark = this.mix.dark;
    this.mix = { ...m };
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const tc = immediate ? 0.01 : 1.0; // ~3 s to settle
    this.padLevel.gain.setTargetAtTime(m.pad, t, tc);
    this.subLevel.gain.setTargetAtTime(m.sub * 0.35, t, tc);
    this.swellLevel.gain.setTargetAtTime(m.swell * 0.05, t, tc);
    this.padFilter.frequency.setTargetAtTime(m.cutoff, t, tc);
    if (prevDark !== m.dark) {
      this.chordIndex = 0;
      this.changeChord(t + 0.05, tc * 1.5);
    }
  }

  progression() {
    return this.mix.dark ? PROGRESSIONS.dark : PROGRESSIONS.calm;
  }

  changeChord(time, glide = 1.2) {
    const prog = this.progression();
    const chord = prog[this.chordIndex % prog.length];
    this.currentChord = chord;
    this.padVoices.forEach((v, i) => {
      const note = chord[i + 1] + (Math.random() < 0.2 ? 12 : 0) * (i === 3 ? 1 : 0);
      for (const o of v.oscs) o.frequency.setTargetAtTime(mtof(note), time, glide * 0.4);
    });
    this.sub.frequency.setTargetAtTime(mtof(chord[0] - 12), time, glide * 0.4);
  }

  /** Lookahead scheduler: eighth notes at ~100 bpm. */
  schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const stepDur = 0.3;
    if (this.nextStepTime < ctx.currentTime - 0.2) this.nextStepTime = ctx.currentTime + 0.05;
    while (this.nextStepTime < ctx.currentTime + 0.25) {
      this.playStep(this.step, this.nextStepTime);
      this.nextStepTime += stepDur;
      this.step++;
    }
  }

  playStep(step, t) {
    const m = this.mix;
    if (--this.stepsUntilChord <= 0) {
      this.chordIndex = (this.chordIndex + 1 + (Math.random() < 0.25 ? 1 : 0)) % this.progression().length;
      this.changeChord(t);
      this.stepsUntilChord = 24 + Math.floor(Math.random() * 3) * 8;
      if (m.swell > 0) this.swellSweep(t);
    }
    // arpeggio / bells
    const beatStrong = step % 4 === 0;
    if (Math.random() < m.arp * (beatStrong ? 1.4 : 0.8)) {
      const scale = m.dark ? SCALE_DARK : SCALE_CALM;
      const ch = this.currentChord || this.progression()[0];
      // prefer chord tones
      let note;
      if (Math.random() < 0.55) note = ch[2 + Math.floor(Math.random() * 4)] + 12;
      else note = scale[Math.floor(Math.random() * scale.length)];
      this.bell(note, t + (Math.random() < 0.15 ? 0.15 : 0), 0.06 + Math.random() * 0.05, this.musicGain, true);
    }
    // bass pulse
    if (m.bass > 0) {
      const ch = this.currentChord || this.progression()[0];
      const root = ch[0] - 12 + (step % 8 === 6 ? 7 : 0);
      this.bassNote(root, t, m.bass * 0.22);
    }
    // ticking hats (offbeats) / clock
    if (m.hat > 0 && (step % 2 === 1 || (this.mood === 'tension' && Math.random() < 0.3))) {
      this.hat(t, m.hat * (step % 2 ? 0.05 : 0.025));
    }
    // taiko-like drums
    if (m.drum > 0) {
      const pattern = [1, 0, 0, 0.5, 0, 0.7, 0, 0, 1, 0, 0.4, 0, 0.8, 0, 0.6, 0.5];
      const v = pattern[step % 16];
      if (v > 0) this.taiko(t, v * m.drum * 0.55);
    }
  }

  bell(midi, t, level, dest, send) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 2.8);
    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sine';
    o2.frequency.value = f * 2.756; // inharmonic partial → bell timbre
    const g2 = ctx.createGain();
    g2.gain.setValueAtTime(0.35, t);
    g2.gain.exponentialRampToValueAtTime(0.001, t + 0.8);
    o1.connect(g);
    o2.connect(g2);
    g2.connect(g);
    g.connect(dest);
    if (send) {
      g.connect(this.delaySend);
      g.connect(this.reverbSend);
    }
    o1.start(t);
    o2.start(t);
    o1.stop(t + 3);
    o2.stop(t + 3);
    o1.onended = () => g.disconnect();
  }

  bassNote(midi, t, level) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = mtof(midi);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(120, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.28);
    o.connect(f);
    f.connect(g);
    g.connect(this.musicGain);
    o.start(t);
    o.stop(t + 0.3);
    o.onended = () => g.disconnect();
  }

  hat(t, level) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.whiteBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    s.connect(f);
    f.connect(g);
    g.connect(this.musicGain);
    s.start(t, Math.random() * 1.5, 0.06);
    s.onended = () => g.disconnect();
  }

  taiko(t, level) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 0.7);
    o.connect(g);
    g.connect(this.musicGain);
    g.connect(this.reverbSend);
    o.start(t);
    o.stop(t + 0.75);
    o.onended = () => g.disconnect();
    // skin noise
    this.noiseHit(t, 'lowpass', 600, 0.08, level * 0.6, this.musicGain);
  }

  swellSweep(t) {
    const f = this.swellFilter.frequency;
    f.cancelScheduledValues(t);
    f.setValueAtTime(250, t);
    f.exponentialRampToValueAtTime(3200, t + 7);
    f.exponentialRampToValueAtTime(300, t + 10);
  }

  arpeggio(notes, t0, spacing, level, dest = this.musicGain) {
    notes.forEach((n, i) => this.bell(n, t0 + i * spacing, level, dest, true));
  }

  victoryMotif() {
    const t = this.ctx.currentTime + 0.05;
    this.arpeggio([62, 66, 69, 74, 78, 81, 86], t, 0.11, 0.12);
    this.padFilter.frequency.setTargetAtTime(3200, t, 0.4);
    // major chord glide
    const chord = [50, 57, 62, 66, 69];
    this.padVoices.forEach((v, i) => v.oscs.forEach((o) => o.frequency.setTargetAtTime(mtof(chord[i + 1]), t, 0.3)));
  }

  defeatMotif() {
    const t = this.ctx.currentTime + 0.05;
    this.arpeggio([74, 70, 67, 62, 58], t, 0.32, 0.09);
    const chord = [50, 57, 60, 65, 69];
    this.padVoices.forEach((v, i) => v.oscs.forEach((o) => o.frequency.setTargetAtTime(mtof(chord[i + 1] - 12 * (i === 0)), t, 0.6)));
  }

  // ------------------------------------------------------------------ continuous SFX
  buildContinuous() {
    const ctx = this.ctx;
    const mk = (buf, type, freq, q = 0.7) => {
      const src = this.loopNoise(buf);
      const f = ctx.createBiquadFilter();
      f.type = type;
      f.frequency.value = freq;
      f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f);
      f.connect(g);
      g.connect(this.sfxGain);
      return { src, f, g };
    };
    // engine: brown-noise rumble + low saw, muffled (structure-borne)
    this.engine = mk(this.brownBuf, 'lowpass', 160, 0.9);
    this.engineOsc = ctx.createOscillator();
    this.engineOsc.type = 'sawtooth';
    this.engineOsc.frequency.value = 38;
    const eof = ctx.createBiquadFilter();
    eof.type = 'lowpass';
    eof.frequency.value = 110;
    this.engineOscGain = ctx.createGain();
    this.engineOscGain.gain.value = 0;
    this.engineOsc.connect(eof);
    eof.connect(this.engineOscGain);
    this.engineOscGain.connect(this.sfxGain);
    this.engineOsc.start();
    // RCS hiss
    this.rcs = mk(this.whiteBuf, 'bandpass', 1100, 1.2);
    // atmospheric wind/roar
    this.wind = mk(this.whiteBuf, 'bandpass', 350, 0.8);
    // plasma crackle
    this.plasma = mk(this.whiteBuf, 'highpass', 2200, 0.7);
    this.rcsPulseTimer = 0;
    this.crackleTimer = 0;
  }

  update(dt, s = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime;
    const paused = !!s.paused;
    const set = (param, v, tc = 0.06) => param.setTargetAtTime(paused ? 0 : v, t, tc);
    const atmo = s.inAtmosphere ? clamp01((s.dynPressure || 0) / 20000) : 0;

    // engine
    const th = s.thrustActive ? clamp01(s.throttle || 0) : 0;
    set(this.engine.g.gain, th * (0.55 + atmo * 0.6));
    set(this.engine.f.frequency, 140 + th * 90 + atmo * 900, 0.2);
    set(this.engineOscGain.gain, th * 0.22);
    this.engineOsc.frequency.setTargetAtTime(34 + th * 10 + Math.random() * 2, t, 0.1);

    // RCS: muffled hiss with stochastic pulse-modulation (valve chatter)
    const rcs = clamp01(s.rcs || 0);
    this.rcsPulseTimer -= dt;
    if (rcs > 0.05 && this.rcsPulseTimer <= 0 && !paused) {
      this.rcsPulseTimer = 0.06 + Math.random() * 0.08;
      this.noiseHit(t, 'lowpass', 300, 0.05, 0.12 * rcs, this.sfxGain);
    }
    set(this.rcs.g.gain, rcs * (0.08 + Math.random() * 0.05), 0.03);

    // wind / roar by dynamic pressure (log-ish response)
    const q = s.dynPressure || 0;
    const windLvl = q > 1 ? clamp01(Math.log10(q) / 4.5) : 0;
    set(this.wind.g.gain, windLvl * 0.5, 0.15);
    set(this.wind.f.frequency, 220 + windLvl * 900 + (s.chute === 'main' ? -100 : 0), 0.3);

    // plasma crackle
    const hf = clamp01((s.heatFlux || 0) / 8e5);
    set(this.plasma.g.gain, hf * (0.06 + Math.random() * 0.12), 0.02);
    this.crackleTimer -= dt;
    if (hf > 0.05 && this.crackleTimer <= 0 && !paused) {
      this.crackleTimer = 0.02 + Math.random() * (0.25 - hf * 0.2);
      this.noiseHit(t, 'bandpass', 1500 + Math.random() * 3000, 0.02, 0.15 * hf, this.sfxGain);
    }
  }

  // ------------------------------------------------------------------ one-shots
  noiseHit(t, type, freq, dur, level, dest, sweepTo) {
    const ctx = this.ctx;
    const s = ctx.createBufferSource();
    s.buffer = this.whiteBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + Math.min(0.01, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(dest);
    s.start(t, Math.random() * 1.0, dur + 0.05);
    s.onended = () => g.disconnect();
    return g;
  }

  tone(freq, t, dur, level, type = 'sine', dest = this.sfxGain, glideTo, attack = 0.005) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0005, t + dur);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + dur + 0.02);
    o.onended = () => g.disconnect();
    return g;
  }

  chime(notes, t, spacing, level) {
    notes.forEach((n, i) => {
      const g = this.tone(mtof(n), t + i * spacing, 1.4, level, 'sine');
      g.connect(this.sfxVerbSend);
      const h = this.tone(mtof(n) * 2.01, t + i * spacing, 0.5, level * 0.3, 'triangle');
      h.connect(this.sfxVerbSend);
    });
  }

  play(name, opts = {}) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const t = this.ctx.currentTime + 0.01;
    const k = clamp01(opts.intensity ?? 0.5);
    const S = this.sfxGain;
    switch (name) {
      case 'click':
        this.tone(1800, t, 0.04, 0.12, 'sine');
        this.tone(900, t, 0.03, 0.06, 'triangle');
        break;
      case 'hover': {
        const now = performance.now();
        if (now - this.lastHover < 60) return;
        this.lastHover = now;
        this.tone(2600, t, 0.025, 0.035, 'sine');
        break;
      }
      case 'score': {
        // rising pentatonic chime — pitch climbs with intensity
        const base = 74 + Math.round(k * 7);
        this.chime([base, base + 4, base + 7], t, 0.07, 0.11);
        break;
      }
      case 'bigscore': {
        const base = 72 + Math.round(k * 5);
        this.chime([base, base + 4, base + 7, base + 12, base + 16], t, 0.065, 0.12);
        this.noiseHit(t + 0.3, 'highpass', 6000, 0.6, 0.05, this.sfxVerbSend);
        break;
      }
      case 'achievement': {
        this.chime([67, 71, 74, 79, 83, 86], t, 0.09, 0.12);
        [55, 62, 67, 71].forEach((n) => {
          const g = this.tone(mtof(n), t + 0.5, 2.2, 0.05, 'triangle', S, null, 0.25);
          g.connect(this.sfxVerbSend);
        });
        for (let i = 0; i < 8; i++) this.tone(mtof(91 + (i % 4) * 2), t + 0.55 + i * 0.05, 0.25, 0.03, 'sine').connect(this.sfxVerbSend);
        break;
      }
      case 'levelup': {
        this.tone(220, t, 0.9, 0.08, 'sawtooth', S, 880, 0.3);
        this.chime([69, 73, 76, 81, 85, 88], t + 0.55, 0.06, 0.12);
        break;
      }
      case 'warning':
        this.tone(880, t, 0.12, 0.12, 'square');
        this.tone(880, t + 0.2, 0.12, 0.12, 'square');
        break;
      case 'alarm':
        for (let i = 0; i < 4; i++) {
          this.tone(620, t + i * 0.5, 0.24, 0.1, 'square');
          this.tone(820, t + i * 0.5 + 0.25, 0.24, 0.1, 'square');
        }
        break;
      case 'dock': {
        // heavy clunk + metallic ring + latch clicks
        this.tone(70, t, 0.6, 0.6, 'sine', S, 32);
        this.noiseHit(t, 'lowpass', 400, 0.3, 0.5, S);
        [310, 523, 887, 1370].forEach((f, i) => this.tone(f, t, 1.6 - i * 0.25, 0.06 / (i + 1), 'sine').connect(this.sfxVerbSend));
        for (let i = 0; i < 4; i++) this.noiseHit(t + 0.45 + i * 0.12 + Math.random() * 0.04, 'bandpass', 2500, 0.03, 0.18, S);
        this.tone(55, t + 0.9, 0.4, 0.25, 'sine', S, 40);
        break;
      }
      case 'undock':
        this.noiseHit(t, 'bandpass', 1800, 0.6, 0.12, S, 600);
        this.tone(90, t + 0.1, 0.4, 0.25, 'sine', S, 45);
        break;
      case 'stage':
        this.tone(60, t, 0.5, 0.7, 'sine', S, 28);
        this.noiseHit(t, 'lowpass', 1200, 0.5, 0.6, S, 200);
        for (let i = 0; i < 5; i++) this.noiseHit(t + 0.15 + Math.random() * 0.4, 'bandpass', 800 + Math.random() * 2000, 0.05, 0.08, S);
        break;
      case 'chute':
        this.noiseHit(t, 'bandpass', 300, 0.7, 0.3, S, 2500);
        this.noiseHit(t + 0.65, 'lowpass', 900, 0.15, 0.5, S);
        this.tone(80, t + 0.65, 0.3, 0.4, 'sine', S, 40);
        break;
      case 'splash':
        this.noiseHit(t, 'lowpass', 2500, 1.6, 0.6, S, 200);
        this.tone(55, t, 0.5, 0.4, 'sine', S, 30);
        for (let i = 0; i < 10; i++) this.tone(300 + Math.random() * 700, t + 0.3 + Math.random() * 1.2, 0.06, 0.03, 'sine', S, 900 + Math.random() * 600);
        break;
      case 'bump':
        this.tone(90, t, 0.25, 0.4 + k * 0.3, 'sine', S, 45);
        this.noiseHit(t, 'lowpass', 600, 0.12, 0.3, S);
        break;
      case 'countdown':
        this.tone(1000, t, 0.14, 0.12, 'sine');
        break;
      case 'go':
        this.tone(1500, t, 0.45, 0.14, 'sine');
        this.tone(750, t, 0.45, 0.07, 'triangle');
        break;
      case 'success':
        this.chime([62, 66, 69, 74, 78], t, 0.1, 0.12);
        break;
      case 'fail':
        [69, 65, 62, 57].forEach((n, i) => this.tone(mtof(n), t + i * 0.18, 0.5, 0.1, 'triangle').connect(this.sfxVerbSend));
        break;
      case 'radio':
        // Quindar tone (2525 Hz) as used on Apollo-era comms loops
        this.tone(2525, t, 0.25, 0.08, 'sine', S, null, 0.002);
        this.noiseHit(t + 0.25, 'bandpass', 1800, 0.15, 0.03, S);
        break;
      case 'whoosh':
        this.noiseHit(t, 'bandpass', 200, 0.8, 0.25, S, 3000);
        break;
      default:
        break;
    }
  }

  dispose() {
    clearTimeout(this.timer);
    clearTimeout(this._moodReturn);
    this.ctx?.close();
    this.ctx = null;
  }
}

export const SOUND_NAMES = [
  'click', 'hover', 'score', 'bigscore', 'achievement', 'levelup', 'warning', 'alarm', 'dock', 'undock',
  'stage', 'chute', 'splash', 'bump', 'countdown', 'go', 'success', 'fail', 'radio', 'whoosh',
];
export const MOOD_NAMES = MOODS;
