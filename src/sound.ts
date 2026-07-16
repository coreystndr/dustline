// === DUSTLINE Audio — layered procedural SFX (Web Audio) ===

class SoundSystem {
  private ctx: AudioContext | null = null;
  private buffers: Map<string, AudioBuffer> = new Map();
  private initialized = false;
  private muted = false;
  private masterGain: GainNode | null = null;

  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      this.ctx = new AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = 0.55;
      this.masterGain.connect(this.ctx.destination);
      await this.buildBank();
      this.initialized = true;
    } catch (e) {
      console.warn('Audio unavailable:', e);
    }
  }

  private ensure(): AudioContext | null {
    if (!this.ctx) return null;
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
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

  play(name: string, x?: number, _y?: number): void {
    if (this.muted) return;
    const ctx = this.ensure();
    if (!ctx || !this.masterGain) return;
    const buffer = this.buffers.get(name);
    if (!buffer) return;

    const src = ctx.createBufferSource();
    src.buffer = buffer;

    if (x !== undefined) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, (x / 1280) * 2 - 1));
      src.connect(pan);
      pan.connect(this.masterGain);
    } else {
      src.connect(this.masterGain);
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
  }

  isMuted(): boolean {
    return this.muted;
  }
}

export const soundSystem = new SoundSystem();
