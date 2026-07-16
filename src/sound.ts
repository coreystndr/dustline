// === DUSTLINE Audio — layered procedural SFX + ambient music (Web Audio) ===

class SoundSystem {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private initialized = false;
  private muted = false;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicPlaying = false;
  private musicVolume = 0.28;
  private unlockBound = false;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.55;
      this.masterGain.connect(this.ctx.destination);

      this.sfxGain = this.ctx.createGain();
      this.sfxGain.gain.value = 1;
      this.sfxGain.connect(this.masterGain);

      this.musicGain = this.ctx.createGain();
      this.musicGain.gain.value = 0;
      this.musicGain.connect(this.masterGain);

      await this.buildBank();
      this.buffers.set('music_ambient', this.buildAmbientLoop());
      this.initialized = true;
      this.bindUnlock();
      this.startMusic();
    } catch (e) {
      console.warn('Audio unavailable:', e);
    }
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) return null;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  /** Browser autoplay: resume context + music on first user gesture. */
  private bindUnlock(): void {
    if (this.unlockBound) return;
    this.unlockBound = true;
    const unlock = () => {
      void this.ctx?.resume();
      if (!this.musicPlaying) this.startMusic();
      else this.fadeMusic(this.muted ? 0 : this.musicVolume, 0.8);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  private async buildBank(): Promise<void> {
    if (!this.ctx) return;
    this.buffers.set('pistol', this.gunshot(180, 0.09, 0.45));
    this.buffers.set('shotgun', this.shotgun());
    this.buffers.set('smg', this.gunshot(260, 0.045, 0.28));
    this.buffers.set('ar', this.gunshot(220, 0.06, 0.35));
    this.buffers.set('sniper', this.sniper());
    this.buffers.set('hit', this.impact());
    this.buffers.set('death', this.death());
    this.buffers.set('pickup', this.chirp(480, 920, 0.12, 0.35));
    this.buffers.set('round_start', this.chirp(220, 660, 0.35, 0.4));
    this.buffers.set('round_end', this.chirp(500, 180, 0.4, 0.4));
    this.buffers.set('reload', this.reload());
    this.buffers.set('dash', this.whoosh());
    this.buffers.set('zone', this.zoneWarn());
    this.buffers.set('grenade_throw', this.whoosh());
    this.buffers.set('explosion', this.explosion());
  }

  private explosion(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.45;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 7);
      const boom = Math.sin(2 * Math.PI * (55 + t * 40) * t) * Math.exp(-t * 5);
      const crack = (Math.random() * 2 - 1) * Math.exp(-t * 18);
      d[i] = (boom * 0.55 + crack * 0.55) * env * 0.7;
    }
    return buf;
  }

  private gunshot(baseFreq: number, dur: number, vol: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 38);
      const noise = (Math.random() * 2 - 1) * 0.55;
      const body = Math.sin(2 * Math.PI * baseFreq * t) * Math.exp(-t * 50);
      const click = Math.sin(2 * Math.PI * 1800 * t) * Math.exp(-t * 120) * 0.4;
      d[i] = (noise + body + click) * env * vol;
    }
    return buf;
  }

  private shotgun(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.18;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 18);
      const noise = (Math.random() * 2 - 1);
      const low = Math.sin(2 * Math.PI * 90 * t) * Math.exp(-t * 25);
      d[i] = (noise * 0.7 + low * 0.5) * env * 0.5;
    }
    return buf;
  }

  private sniper(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.28;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 12);
      const crack = Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-t * 80);
      const boom = Math.sin(2 * Math.PI * 120 * t) * Math.exp(-t * 10);
      const noise = (Math.random() * 2 - 1) * Math.exp(-t * 30) * 0.4;
      d[i] = (crack * 0.5 + boom * 0.4 + noise) * env * 0.55;
    }
    return buf;
  }

  private impact(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.1;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.exp(-t * 40);
      d[i] = (Math.sin(2 * Math.PI * 280 * t) + (Math.random() * 2 - 1) * 0.5) * env * 0.4;
    }
    return buf;
  }

  private death(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.35;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const freq = 220 - t * 280;
      const env = Math.exp(-t * 6);
      d[i] = Math.sin(2 * Math.PI * Math.max(40, freq) * t) * env * 0.45;
    }
    return buf;
  }

  private chirp(f0: number, f1: number, dur: number, vol: number): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const p = t / dur;
      const f = f0 + (f1 - f0) * p;
      const env = Math.sin(Math.PI * p) * Math.exp(-t * 4);
      d[i] = Math.sin(2 * Math.PI * f * t) * env * vol;
    }
    return buf;
  }

  private reload(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.22;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const click1 = t < 0.04 ? Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t * 60) : 0;
      const click2 = t > 0.1 && t < 0.15 ? Math.sin(2 * Math.PI * 700 * (t - 0.1)) * Math.exp(-(t - 0.1) * 50) : 0;
      d[i] = (click1 + click2) * 0.35;
    }
    return buf;
  }

  private whoosh(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.14;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.sin(Math.PI * (t / dur));
      d[i] = (Math.random() * 2 - 1) * env * 0.25 * Math.sin(2 * Math.PI * (400 + t * 800) * t);
    }
    return buf;
  }

  private zoneWarn(): AudioBuffer {
    const ctx = this.ctx!;
    const dur = 0.5;
    const n = Math.floor(ctx.sampleRate * dur);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / ctx.sampleRate;
      const env = Math.sin(Math.PI * (t / dur));
      d[i] = Math.sin(2 * Math.PI * 180 * t) * env * 0.3
        + Math.sin(2 * Math.PI * 270 * t) * env * 0.15;
    }
    return buf;
  }

  /**
   * "Dustline Drop" — action combat loop (~132 BPM).
   * Kick/snare/hats, pulsing bass, tense pads, sharp lead. Seamless 32s stereo loop.
   */
  private buildAmbientLoop(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const bpm = 132;
    const beat = 60 / bpm;
    const bars = 16; // 16 bars × 4 beats
    const dur = bars * 4 * beat;
    const n = Math.floor(sr * dur);
    const buf = ctx.createBuffer(2, n, sr);
    const L = buf.getChannelData(0);
    const R = buf.getChannelData(1);

    const notes = {
      D1: 36.71, A1: 55.0, Bb1: 58.27, C2: 65.41, D2: 73.42, F2: 87.31, G2: 98.0, A2: 110.0,
      C3: 130.81, D3: 146.83, F3: 174.61, G3: 196.0, A3: 220.0, Bb3: 233.08, C4: 261.63,
      D4: 293.66, E4: 329.63, F4: 349.23, G4: 392.0, A4: 440.0, Bb4: 466.16, C5: 523.25,
      D5: 587.33, E5: 659.25, F5: 698.46, G5: 783.99, A5: 880.0,
    };

    // Power-minor progression (2 bars each): Dm | Bb | F | C | Dm | Gm | Bb | A
    const chords: number[][] = [
      [notes.D3, notes.F3, notes.A3, notes.C4],
      [notes.Bb3, notes.D4, notes.F4, notes.A4],
      [notes.F3, notes.A3, notes.C4, notes.E4],
      [notes.C3, notes.E4, notes.G4, notes.Bb4],
      [notes.D3, notes.F3, notes.A3, notes.C4],
      [notes.G3, notes.Bb3, notes.D4, notes.F4],
      [notes.Bb3, notes.D4, notes.F4, notes.G4],
      [notes.A2, notes.C4, notes.E4, notes.G4],
    ];
    const bassRoots = [
      notes.D1, notes.Bb1, notes.F2, notes.C2,
      notes.D1, notes.G2 / 2, notes.Bb1, notes.A1,
    ];

    // Lead hooks (8th-note patterns)
    const hook = [notes.D5, notes.F5, notes.A5, notes.G5, notes.F5, notes.D5, notes.C5, notes.A4];
    const hook2 = [notes.A4, notes.C5, notes.D5, notes.F5, notes.E5, notes.D5, notes.C5, notes.A4];

    // Deterministic noise
    let seed = 4242;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return (seed / 2147483647) * 2 - 1;
    };
    let noiseLp = 0;
    let noiseHp = 0;

    const twoPi = Math.PI * 2;
    const barSec = 4 * beat;
    const leadLen = 0.32; // beats

    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const edge = 0.08;
      let loopEnv = 1;
      if (t < edge) loopEnv = t / edge;
      else if (t > dur - edge) loopEnv = (dur - t) / edge;

      const totalBeats = t / beat;
      const beatInBar = totalBeats % 4;
      const bar = Math.min(bars - 1, Math.floor(t / barSec));
      const chordIdx = Math.floor(bar / 2) % 8;
      const nextChord = (chordIdx + 1) % 8;
      const xfade = bar % 2 === 1 && beatInBar > 3.2 ? (beatInBar - 3.2) / 0.8 : 0;

      // --- Drums ---
      const kickBeats = [0, 2];
      if (bar % 4 === 3) kickBeats.push(1);
      if (bar % 2 === 1) kickBeats.push(2.5);
      let kick = 0;
      for (const kb of kickBeats) {
        const d = beatInBar - kb;
        if (d >= 0 && d < 0.14) {
          const env = Math.exp(-d * 38);
          const f = 150 * Math.exp(-d * 28) + 42;
          kick += Math.sin(twoPi * f * d) * env * 0.72;
          kick += rnd() * env * 0.08;
        }
      }

      // Snare on 2 and 4
      let snare = 0;
      for (const sb of [1, 3]) {
        const d = beatInBar - sb;
        if (d >= 0 && d < 0.12) {
          const env = Math.exp(-d * 32);
          noiseLp = noiseLp * 0.6 + rnd() * 0.4;
          snare += noiseLp * env * 0.42;
          snare += Math.sin(twoPi * 180 * d) * env * 0.15;
        }
      }

      // Hats on 8ths (open on offbeats)
      let hat = 0;
      const hatStep = beatInBar * 2;
      const hatPos = hatStep - Math.floor(hatStep);
      if (hatPos < 0.08) {
        const env = Math.exp(-hatPos * 90);
        noiseHp = noiseHp * 0.3 + rnd() * 0.7;
        const open = Math.floor(hatStep) % 2 === 1 ? 0.22 : 0.12;
        hat = noiseHp * env * open;
      }

      // Ghost clap on the "and" of 4 every other bar
      let clap = 0;
      if (bar % 2 === 1) {
        const d = beatInBar - 3.5;
        if (d >= 0 && d < 0.08) {
          clap = rnd() * Math.exp(-d * 50) * 0.18;
        }
      }

      const drumsL = kick * 0.95 + snare * 0.9 + hat * 0.85 + clap;
      const drumsR = kick * 0.95 + snare * 1.0 + hat * 1.05 + clap * 1.1;

      // Sidechain-style duck on kicks
      let duck = 1;
      for (const kb of [0, 2]) {
        const d = beatInBar - kb;
        if (d >= 0 && d < 0.2) duck = Math.min(duck, 0.35 + 0.65 * (d / 0.2));
      }

      // --- Driving bass ---
      const root = bassRoots[chordIdx] * (1 - xfade) + bassRoots[nextChord] * xfade;
      const bassPulse = beatInBar % 1;
      const pulseEnv =
        bassPulse < 0.45
          ? Math.exp(-bassPulse * 6) * (0.55 + 0.45 * Math.sin(bassPulse * Math.PI * 2))
          : 0.12;
      const accent = Math.floor(beatInBar * 4) % 4 === 0 ? 1.15 : 0.85;
      const saw = 2 * ((root * t) % 1) - 1;
      const square = Math.sin(twoPi * root * t) > 0 ? 1 : -1;
      const sub = Math.sin(twoPi * root * t);
      const bass =
        (sub * 0.55 + saw * 0.22 + square * 0.12) * pulseEnv * accent * 0.22 * duck;

      // Run-up fill every 4 bars
      let bassFill = 0;
      if (bar % 4 === 3 && beatInBar >= 2) {
        const ft = beatInBar - 2;
        const steps = [notes.D2, notes.F2, notes.G2, notes.A2, notes.C3, notes.D3, notes.F3, notes.A3];
        const si = Math.min(7, Math.floor(ft * 4));
        const local = (ft * 4) % 1;
        const env = local < 0.7 ? Math.exp(-local * 4) : 0;
        bassFill = Math.sin(twoPi * steps[si] * t) * env * 0.12;
      }

      // --- Tense pad ---
      const chord = chords[chordIdx];
      const chordB = chords[nextChord];
      let padL = 0;
      let padR = 0;
      const mixChord = (ch: number[], w: number) => {
        for (let c = 0; c < ch.length; c++) {
          const f = ch[c] * (1 + (c - 1.5) * 0.002);
          const s = Math.sin(twoPi * f * t);
          const sawP = 2 * ((f * t) % 1) - 1;
          const tone = s * 0.45 + sawP * 0.35;
          const pan = (c / Math.max(1, ch.length - 1)) * 2 - 1;
          padL += tone * (0.5 - pan * 0.3) * w;
          padR += tone * (0.5 + pan * 0.3) * w;
        }
      };
      mixChord(chord, 1 - xfade);
      if (xfade > 0) mixChord(chordB, xfade);
      const padFilter = 0.7 + 0.3 * Math.sin(twoPi * 0.15 * t);
      padL *= 0.055 * duck * padFilter;
      padR *= 0.055 * duck * padFilter;

      // --- Staccato lead (O(1) per sample) ---
      let leadL = 0;
      let leadR = 0;
      {
        const eighthIdx = Math.floor(totalBeats * 2);
        const localB = (totalBeats * 2) % 1; // 0..1 within current 8th
        const localBeats = localB * 0.5;
        const barForLead = Math.floor(eighthIdx / 8);
        const step = eighthIdx % 8;
        const skip = (step + barForLead) % 5 === 3;
        if (!skip && localBeats < leadLen) {
          const line = barForLead % 4 < 2 ? hook : hook2;
          const freq = line[step];
          const local = localBeats * beat;
          const atk = Math.min(1, local / 0.012);
          const rel = Math.min(1, (leadLen * beat - local) / 0.05);
          const env = atk * rel;
          const ph = twoPi * freq * local;
          const tone =
            (Math.sin(ph) > 0 ? 0.55 : -0.55) +
            Math.sin(ph) * 0.35 +
            Math.sin(ph * 2) * 0.2;
          const sample = tone * env * 0.07;
          const pan = ((eighthIdx * 0.37) % 2) - 1;
          leadL = sample * (0.7 - pan * 0.25);
          leadR = sample * (0.7 + pan * 0.25);
        }
      }

      // --- 16th arp ---
      let arp = 0;
      const step16 = Math.floor(totalBeats * 4) % 16;
      const local16 = (totalBeats * 4) % 1;
      if (local16 < 0.35 && step16 % 2 === 0) {
        const af = chord[step16 % chord.length] * 2;
        const aenv = Math.exp(-local16 * 14);
        arp = Math.sin(twoPi * af * t) * aenv * 0.04;
      }

      // --- Riser into drop every 8 bars ---
      let riser = 0;
      if (bar % 8 === 7) {
        const p = beatInBar / 4;
        noiseHp = noiseHp * 0.85 + rnd() * 0.15;
        riser = noiseHp * p * p * 0.2;
      }

      // --- Drop impact ---
      let impact = 0;
      if ((bar === 0 || bar === 8) && beatInBar < 0.25) {
        impact = Math.sin(twoPi * (55 + beatInBar * 40) * t) * Math.exp(-beatInBar * 12) * 0.35;
        impact += rnd() * Math.exp(-beatInBar * 20) * 0.12;
      }

      let outL =
        drumsL + bass + bassFill + padL + leadL + arp * 0.9 + riser * 0.8 + impact * 0.9;
      let outR =
        drumsR + bass + bassFill + padR + leadR + arp * 1.1 + riser * 1.0 + impact * 0.9;

      outL = Math.tanh(outL * 1.15) * loopEnv;
      outR = Math.tanh(outR * 1.15) * loopEnv;

      L[i] = outL;
      R[i] = outR;
    }

    return buf;
  }

  startMusic(): void {
    if (this.musicPlaying || this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.musicGain) return;
    const buffer = this.buffers.get('music_ambient');
    if (!buffer) return;

    try {
      this.musicSource?.stop();
    } catch {
      /* already stopped */
    }

    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.connect(this.musicGain);
    src.start(0);
    this.musicSource = src;
    this.musicPlaying = true;
    this.fadeMusic(this.musicVolume, 1.0);
  }

  stopMusic(fadeSec = 1.2): void {
    if (!this.musicPlaying || !this.musicGain || !this.ctx) return;
    this.fadeMusic(0, fadeSec);
    const src = this.musicSource;
    window.setTimeout(() => {
      try {
        src?.stop();
      } catch {
        /* ignore */
      }
      if (this.musicSource === src) {
        this.musicSource = null;
        this.musicPlaying = false;
      }
    }, fadeSec * 1000 + 50);
  }

  private fadeMusic(target: number, seconds: number): void {
    if (!this.musicGain || !this.ctx) return;
    const g = this.musicGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    g.linearRampToValueAtTime(target, now + Math.max(0.05, seconds));
  }

  setMusicVolume(v: number): void {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicPlaying && !this.muted) {
      this.fadeMusic(this.musicVolume, 0.3);
    }
  }

  play(name: string, x?: number, _y?: number): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.sfxGain) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    if (x !== undefined) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (x / 1280) * 2 - 1));
      src.connect(pan);
      pan.connect(this.sfxGain);
    } else {
      src.connect(this.sfxGain);
    }
    src.start();
  }

  playWeaponFired(weaponType: string, x?: number, y?: number): void {
    const map: Record<string, string> = {
      Pistol: 'pistol',
      Shotgun: 'shotgun',
      SMG: 'smg',
      AR: 'ar',
      Sniper: 'sniper',
    };
    this.play(map[weaponType] || 'pistol', x, y);
  }

  toggleMute(): void {
    this.muted = !this.muted;
    if (this.muted) {
      this.fadeMusic(0, 0.4);
    } else {
      if (!this.musicPlaying) this.startMusic();
      else this.fadeMusic(this.musicVolume, 0.6);
    }
  }

  isMuted(): boolean {
    return this.muted;
  }
}

export const soundSystem = new SoundSystem();
