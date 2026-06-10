/**
 * Fully procedural horror audio — every sound is synthesized in WebAudio.
 * Layers: fluorescent hum, room tone, fear drone, heartbeat, footsteps,
 * entity presence, whispers, stingers, the screech.
 */

export interface AudioParams {
  /** 0..1 composite dread level */
  fear: number;
  /** 0..1 how close the nearest LIT fixture is (1 = right under it) */
  humProximity: number;
  /** meters to entity (Infinity when dormant) */
  entityDist: number;
  /** -1..1 stereo direction of the entity relative to look dir */
  entityPan: number;
  chasing: boolean;
}

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private wet!: GainNode;
  private noiseBuf!: AudioBuffer;

  private hum!: GainNode;
  private drone!: GainNode;
  private chaseLayer!: GainNode;
  private breathGain!: GainNode;

  private nextBeat = 0;
  private nextWhisper = 12;
  private params: AudioParams = {
    fear: 0,
    humProximity: 0.5,
    entityDist: Infinity,
    entityPan: 0,
    chasing: false,
  };

  get ready(): boolean {
    return !!this.ctx;
  }

  init() {
    if (this.ctx) return;
    const ctx = new AudioContext();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 18;
    comp.ratio.value = 8;
    this.master.connect(comp);
    comp.connect(ctx.destination);

    // Reverb send — exponentially decaying noise impulse ≈ damp concrete space.
    const convolver = ctx.createConvolver();
    convolver.buffer = this.makeImpulse(1.6, 3.2);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.32;
    this.wet.connect(convolver);
    convolver.connect(this.master);

    this.sfx = ctx.createGain();
    this.sfx.connect(this.master);
    this.sfx.connect(this.wet);

    this.noiseBuf = this.makeNoise(2);

    this.startHum();
    this.startRoomTone();
    this.startDrone();
    this.startBreath();
  }

  async resume() {
    if (this.ctx && this.ctx.state === "suspended") await this.ctx.resume();
  }
  async suspend() {
    if (this.ctx && this.ctx.state === "running") await this.ctx.suspend();
  }

  /* ------------------------- buffer helpers ------------------------- */

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  private makeImpulse(seconds: number, decay: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  private noiseSource(loop = false): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = loop;
    return src;
  }

  /* ------------------------- ambient layers ------------------------- */

  private startHum() {
    const ctx = this.ctx!;
    this.hum = ctx.createGain();
    this.hum.gain.value = 0.0;
    this.hum.connect(this.master);

    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 900;
    lp.connect(this.hum);

    for (const [freq, g] of [[120, 0.5], [240, 0.22], [360, 0.1], [479, 0.05]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      const og = ctx.createGain();
      og.gain.value = g * 0.02;
      osc.connect(og);
      og.connect(lp);
      osc.start();
    }
  }

  private startRoomTone() {
    const ctx = this.ctx!;
    const src = this.noiseSource(true);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 180;
    const g = ctx.createGain();
    g.gain.value = 0.05;
    src.connect(lp);
    lp.connect(g);
    g.connect(this.master);
    src.start();

    // Slow swell so silence never feels safe.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.043;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.02;
    lfo.connect(lfoG);
    lfoG.connect(g.gain);
    lfo.start();
  }

  private startDrone() {
    const ctx = this.ctx!;
    this.drone = ctx.createGain();
    this.drone.gain.value = 0;
    this.drone.connect(this.master);
    this.drone.connect(this.wet);

    // Dissonant cluster — minor second + tritone intervals, slowly beating.
    for (const [freq, g] of [[55, 0.5], [56.7, 0.4], [82.4, 0.2], [110.6, 0.12], [164.2, 0.07]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      const og = ctx.createGain();
      og.gain.value = g * 0.4;
      osc.connect(og);
      og.connect(this.drone);
      osc.start();
    }

    // Chase layer: harsher, pulsing.
    this.chaseLayer = ctx.createGain();
    this.chaseLayer.gain.value = 0;
    this.chaseLayer.connect(this.master);
    const saw = ctx.createOscillator();
    saw.type = "sawtooth";
    saw.frequency.value = 41.2;
    const sawLp = ctx.createBiquadFilter();
    sawLp.type = "lowpass";
    sawLp.frequency.value = 320;
    const trem = ctx.createOscillator();
    trem.frequency.value = 7.3;
    const tremG = ctx.createGain();
    tremG.gain.value = 0.5;
    const tremBase = ctx.createGain();
    tremBase.gain.value = 0.55;
    saw.connect(sawLp);
    sawLp.connect(tremBase);
    trem.connect(tremG);
    tremG.connect(tremBase.gain);
    tremBase.connect(this.chaseLayer);
    saw.start();
    trem.start();
  }

  private startBreath() {
    const ctx = this.ctx!;
    this.breathGain = ctx.createGain();
    this.breathGain.gain.value = 0;
    const src = this.noiseSource(true);
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 600;
    bp.Q.value = 0.7;
    // breath rhythm
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.45;
    const lfoG = ctx.createGain();
    lfoG.gain.value = 0.5;
    const base = ctx.createGain();
    base.gain.value = 0.5;
    src.connect(bp);
    bp.connect(base);
    lfo.connect(lfoG);
    lfoG.connect(base.gain);
    base.connect(this.breathGain);
    this.breathGain.connect(this.master);
    src.start();
    lfo.start();
  }

  /* --------------------------- per-frame --------------------------- */

  setParams(p: AudioParams) {
    this.params = p;
  }

  update(dt: number) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const p = this.params;

    const ramp = (param: AudioParam, v: number, tc = 0.25) =>
      param.setTargetAtTime(v, t, tc);

    ramp(this.hum.gain, 0.25 + p.humProximity * 0.75, 0.4);
    ramp(this.drone.gain, p.fear * 0.34, 0.8);
    ramp(this.chaseLayer.gain, p.chasing ? 0.16 : 0, p.chasing ? 0.15 : 1.2);
    ramp(this.breathGain.gain, Math.max(0, p.fear - 0.45) * 0.1, 0.6);

    // Heartbeat scheduling.
    if (p.fear > 0.18) {
      if (t >= this.nextBeat) {
        const rate = 0.95 + p.fear * 1.25; // Hz
        this.heartbeat(Math.min(1, (p.fear - 0.15) * 1.3));
        this.nextBeat = t + 1 / rate;
      }
    } else {
      this.nextBeat = Math.max(this.nextBeat, t + 0.5);
    }

    // Occasional whisper from the walls when dread is mid-high.
    this.nextWhisper -= dt;
    if (this.nextWhisper <= 0) {
      if (p.fear > 0.25 && p.fear < 0.85 && Math.random() < 0.6) this.whisper();
      this.nextWhisper = 9 + Math.random() * 16;
    }
  }

  /* ----------------------------- one-shots ----------------------------- */

  private heartbeat(vol: number) {
    const ctx = this.ctx!;
    const t = ctx.currentTime;
    const beat = (at: number, gain: number) => {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(52, at);
      osc.frequency.exponentialRampToValueAtTime(30, at + 0.12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(gain, at + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(g);
      g.connect(this.master);
      osc.start(at);
      osc.stop(at + 0.2);
    };
    beat(t, 0.34 * vol);
    beat(t + 0.14, 0.2 * vol);
  }

  playerStep(sprinting: boolean) {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = sprinting ? 0.17 : 0.1;

    // Carpet scuff.
    const src = this.noiseSource();
    src.playbackRate.value = 0.7 + Math.random() * 0.5;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 700 + Math.random() * 500;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.12);

    // Weight thump.
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(82, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.07);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol * 0.8, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(og);
    og.connect(this.sfx);
    osc.start(t);
    osc.stop(t + 0.1);
  }

  entityStep(dist: number, pan: number) {
    if (!this.ctx || dist > 30) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const vol = Math.min(0.5, 6 / (dist + 2));

    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.sfx);

    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(58, t);
    osc.frequency.exponentialRampToValueAtTime(26, t + 0.16);
    const og = ctx.createGain();
    og.gain.setValueAtTime(vol, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(og);
    og.connect(panner);
    osc.start(t);
    osc.stop(t + 0.25);

    const src = this.noiseSource();
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 320;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(lp);
    lp.connect(g);
    g.connect(panner);
    src.start(t, Math.random());
    src.stop(t + 0.15);
  }

  whisper() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const dur = 1.2 + Math.random() * 1.6;

    const src = this.noiseSource();
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.setValueAtTime(900 + Math.random() * 700, t);
    bp.Q.value = 6;
    // formant wobble — makes noise feel like speech just below intelligibility
    const wob = ctx.createOscillator();
    wob.frequency.value = 2.6 + Math.random() * 3;
    const wobG = ctx.createGain();
    wobG.gain.value = 420;
    wob.connect(wobG);
    wobG.connect(bp.frequency);

    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.random() * 1.6 - 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.035, t + dur * 0.4);
    g.gain.linearRampToValueAtTime(0, t + dur);
    src.connect(bp);
    bp.connect(g);
    g.connect(pan);
    pan.connect(this.wet);
    src.start(t, Math.random());
    src.stop(t + dur + 0.1);
    wob.start(t);
    wob.stop(t + dur + 0.1);
  }

  /** Page pickup — dissonant string-ish sting + paper crinkle. */
  pageStinger() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    for (const [f0, f1, g0] of [[440, 466, 0.05], [659, 622, 0.04], [880, 932, 0.025]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(f1, t + 1.1);
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(420, t + 1.3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(g0, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
      osc.connect(lp);
      lp.connect(g);
      g.connect(this.sfx);
      osc.start(t);
      osc.stop(t + 1.5);
    }

    const src = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 2400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.2);
  }

  /** Entity chase screech — THE scare. */
  screech() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const shaper = ctx.createWaveShaper();
    const curve = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const x = (i / 128) - 1;
      curve[i] = Math.tanh(x * 4);
    }
    shaper.curve = curve;
    const sg = ctx.createGain();
    sg.gain.setValueAtTime(0.0001, t);
    sg.gain.exponentialRampToValueAtTime(0.55, t + 0.06);
    sg.gain.setValueAtTime(0.55, t + 0.7);
    sg.gain.exponentialRampToValueAtTime(0.0001, t + 1.9);
    shaper.connect(sg);
    sg.connect(this.master);
    sg.connect(this.wet);

    for (const ratio of [1, 1.93, 2.41]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.setValueAtTime(420 * ratio, t);
      osc.frequency.exponentialRampToValueAtTime(1750 * ratio, t + 0.55);
      osc.frequency.exponentialRampToValueAtTime(900 * ratio, t + 1.6);
      // vibrato panic
      const vib = ctx.createOscillator();
      vib.frequency.value = 23;
      const vibG = ctx.createGain();
      vibG.gain.value = 60 * ratio;
      vib.connect(vibG);
      vibG.connect(osc.frequency);
      const og = ctx.createGain();
      og.gain.value = ratio === 1 ? 0.5 : 0.2;
      osc.connect(og);
      og.connect(shaper);
      osc.start(t);
      osc.stop(t + 2);
      vib.start(t);
      vib.stop(t + 2);
    }

    // Noise blast + sub drop.
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 2600;
    bp.Q.value = 0.5;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.3, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 1.1);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(this.master);
    src.start(t, Math.random());
    src.stop(t + 1.2);

    const sub = ctx.createOscillator();
    sub.frequency.setValueAtTime(64, t);
    sub.frequency.exponentialRampToValueAtTime(24, t + 1.3);
    const subG = ctx.createGain();
    subG.gain.setValueAtTime(0.5, t);
    subG.gain.exponentialRampToValueAtTime(0.001, t + 1.4);
    sub.connect(subG);
    subG.connect(this.master);
    sub.start(t);
    sub.stop(t + 1.5);
  }

  /** Flashlight switch — dry mechanical click. */
  click() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 3100;
    bp.Q.value = 2.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.035);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.05);
  }

  /** Fluorescent fixture dying nearby. */
  zap() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const src = this.noiseSource();
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.16, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    src.connect(hp);
    hp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 0.1);

    const ping = ctx.createOscillator();
    ping.frequency.setValueAtTime(2300, t);
    ping.frequency.exponentialRampToValueAtTime(640, t + 0.4);
    const pg = ctx.createGain();
    pg.gain.setValueAtTime(0.05, t);
    pg.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
    ping.connect(pg);
    pg.connect(this.sfx);
    ping.start(t);
    ping.stop(t + 0.5);
  }

  /** A dead fixture somewhere down the maze arcs back to life — go look. */
  buzz() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // mains hum swelling in — routed through the reverb only, so it sits
    // "somewhere out there" instead of in your ear
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 119;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.value = 850;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.05, t + 0.7);
    og.gain.setValueAtTime(0.05, t + 2.4);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);
    osc.connect(lp);
    lp.connect(og);
    og.connect(this.wet);
    osc.start(t);
    osc.stop(t + 3.7);

    // arc strikes
    for (let i = 0; i < 5; i++) {
      const at = t + 0.15 + Math.random() * 2.6;
      const src = this.noiseSource();
      const bp = ctx.createBiquadFilter();
      bp.type = "bandpass";
      bp.frequency.value = 2200 + Math.random() * 2000;
      bp.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.05, at);
      g.gain.exponentialRampToValueAtTime(0.001, at + 0.05);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.wet);
      src.start(at, Math.random());
      src.stop(at + 0.07);
    }
  }

  /** Almond water going down — three gulps and a swallow. */
  drink() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (let i = 0; i < 3; i++) {
      const at = t + i * 0.27;
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.setValueAtTime(205 - i * 16, at);
      osc.frequency.exponentialRampToValueAtTime(88, at + 0.15);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.085, at + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
      osc.connect(g);
      g.connect(this.sfx);
      osc.start(at);
      osc.stop(at + 0.24);
    }
    const src = this.noiseSource();
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = 680;
    bp.Q.value = 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.035, t + 0.35);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.95);
    src.connect(bp);
    bp.connect(g);
    g.connect(this.sfx);
    src.start(t, Math.random());
    src.stop(t + 1);
  }

  death() {
    if (!this.ctx) return;
    this.screech();
    const ctx = this.ctx;
    const t = ctx.currentTime;
    // Everything collapses into a sub rumble.
    this.master.gain.setValueAtTime(this.master.gain.value, t);
    this.master.gain.linearRampToValueAtTime(0.0, t + 2.6);
  }

  win() {
    if (!this.ctx) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const [f, g0, at] of [[220, 0.07, 0], [277.2, 0.05, 0.3], [329.6, 0.05, 0.6], [440, 0.03, 0.9]] as const) {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = f;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t + at);
      g.gain.linearRampToValueAtTime(g0, t + at + 0.4);
      g.gain.linearRampToValueAtTime(0, t + at + 4);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.wet);
      osc.start(t + at);
      osc.stop(t + at + 4.2);
    }
    this.drone.gain.setTargetAtTime(0, t, 0.4);
    this.chaseLayer.gain.setTargetAtTime(0, t, 0.2);
  }

  dispose() {
    this.ctx?.close();
    this.ctx = null;
  }
}
