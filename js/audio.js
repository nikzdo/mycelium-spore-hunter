// audio.js — fully synthesized WebAudio BGM + SFX
const MASTER_GAIN = 0.55; // one number, so mute/unmute can't drift from init
export class GameAudio {
  constructor(){
    this.ctx = null; this.muted = false; this.started = false;
  }
  init(){
    if(this.ctx) return;
    // Audio is a nicety, never a blocker: a missing/blocked API leaves ctx null and every
    // sound below turns into a no-op instead of throwing into someone's update loop.
    try {
      const C = window.AudioContext || window.webkitAudioContext;
      this.ctx = new C();
      this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
      // gentle lowpass "storybook" warmth
      this.filter = this.ctx.createBiquadFilter();
      this.filter.type = 'lowpass'; this.filter.frequency.value = 5200;
      this.master.connect(this.filter); this.filter.connect(this.ctx.destination);
      this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.9; this.sfxGain.connect(this.master);
      this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = 0.4; this.bgmGain.connect(this.master);
    } catch(e){ this.ctx = null; }
  }
  resume(){ try { if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch(e){} }
  toggleMute(){
    this.muted = !this.muted;
    if(this.master) this.master.gain.value = this.muted ? 0 : MASTER_GAIN;
    return this.muted;
  }
  now(){ return this.ctx ? this.ctx.currentTime : 0; }
  /* ---------- primitive helpers ---------- */
  // The two leaves below are the only places that touch the WebAudio graph for SFX, so the
  // ctx guard and the try/catch live here once instead of on every sound.
  osc(type, freq, t0, dur, vol, dest, freqEnd=null){
    if(!this.ctx) return;
    try {
      const c = this.ctx;
      const o = c.createOscillator(), g = c.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t0);
      if(freqEnd !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1,freqEnd), t0+dur);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0+0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
      o.connect(g); g.connect(dest || this.sfxGain);
      o.start(t0); o.stop(t0+dur+0.05);
    } catch(e){}
  }
  noise(t0, dur, vol, fLo=400, fHi=4000, dest=null){
    if(!this.ctx) return;
    try {
      const c = this.ctx;
      const len = Math.ceil(c.sampleRate*dur);
      const buf = c.createBuffer(1, len, c.sampleRate);
      const d = buf.getChannelData(0);
      for(let i=0;i<len;i++) d[i] = Math.random()*2-1;
      const src = c.createBufferSource(); src.buffer = buf;
      const bp = c.createBiquadFilter(); bp.type='bandpass';
      bp.frequency.value = Math.sqrt(fLo*fHi); bp.Q.value = 0.8;
      const g = c.createGain();
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
      src.connect(bp); bp.connect(g); g.connect(dest || this.sfxGain);
      src.start(t0); src.stop(t0+dur);
    } catch(e){}
  }
  /* ---------- the three shapes every sound is made of ---------- */
  // A pitched tone. `slideTo` makes it a whoosh (exponential glide over the whole duration)
  // instead of a fixed pitch — that glide is what separates a dash from a UI blip.
  // `at` is an absolute ctx time; 0 means "now".
  beep(freq, dur=0.12, type='sine', vol=0.2, slideTo=null, at=0){
    this.osc(type, freq, at || this.now(), dur, vol, null, slideTo);
  }
  // Band-limited noise: impacts, whooshes, shimmer.
  hiss(dur=0.12, vol=0.2, fLo=400, fHi=4000, at=0){
    this.noise(at || this.now(), dur, vol, fLo, fHi, null);
  }
  // Ascending run. A single beep reads as a UI click; a run reads as "you gained something".
  // Per-note vol stays at single-beep level — notes overlap ~2-3 deep, not 4x loud.
  arp(freqs, type='sine', dur=0.18, vol=0.16, step=0.07, at=0){
    const t = at || this.now();
    for(let i=0;i<freqs.length;i++) this.beep(freqs[i], dur, type, vol, null, t+i*step);
  }
  /* ---------- SFX: one line each, so adding a sound is a line and retuning a family is one edit ---------- */
  /* combat */
  swing(combo=1){ this.hiss(0.14, 0.25, 800+combo*400, 5000); this.beep(300+combo*120, 0.12, 'sine', 0.12, 90); }
  hit(){ this.beep(220, 0.08, 'square', 0.2, 110); this.hiss(0.1, 0.3, 500, 3000); }
  pop(rarity=0){ const f = 500 - rarity*60; const t = this.now();
    this.beep(f, 0.25, 'sine', 0.35, f*0.3, t); this.beep(f*2, 0.15, 'triangle', 0.15, f, t); this.hiss(0.25, 0.25, 300, 2500, t); }
  hurt(){ this.beep(180, 0.25, 'sawtooth', 0.25, 60); this.hiss(0.2, 0.3, 200, 1200); }
  spit(){ this.beep(700, 0.12, 'square', 0.1, 250); }
  lunge(){ this.hiss(0.18, 0.2, 300, 1800); }
  shieldBreak(){ this.hiss(0.3, 0.3, 2000, 8000); this.beep(900, 0.3, 'sine', 0.15, 300); }
  roar(big=1){ const t = this.now();
    this.beep(90, 0.8*big+0.3, 'sawtooth', 0.35, 45, t); this.beep(65, 0.7*big+0.2, 'square', 0.25, 38, t+0.05); this.hiss(0.7, 0.3, 100, 900, t); }
  bossSpawn(){ const t = this.now(); this.roar(1.4);
    [110,110,165,110].forEach((f,i)=> this.beep(f, 0.28, 'sawtooth', 0.2, null, t+i*0.3)); }
  // Rising slide: pitch climbing toward an unseen ceiling is the wind-up cue.
  telegraph(big=1){ this.beep(160, 0.5*big, 'square', 0.13, 780); this.hiss(0.4*big, 0.1, 300, 2600); }
  /* movement — whooshes, all pitch slides rather than fixed tones */
  dash(){ this.hiss(0.22, 0.3, 1200, 6000); this.beep(600, 0.2, 'sine', 0.1, 1400); }
  jump(){ this.beep(280, 0.16, 'sine', 0.18, 620); }
  warp(){ this.hiss(0.32, 0.22, 500, 4200); this.beep(220, 0.34, 'sine', 0.14, 980); }
  /* rewards — every one of these is an ascending run, not a beep */
  pickup(){ this.arp([523,659,784,1046], 'sine', 0.18, 0.19, 0.065); }
  powerup(){ this.arp([392,523,659,880], 'triangle', 0.2, 0.16, 0.07); }
  unlock(){ this.arp([523,659,784,1046], 'triangle', 0.24, 0.17, 0.075); this.hiss(0.35, 0.05, 4500, 9000, this.now()+0.1); }
  gearUp(stars=1){ const b = 440*Math.pow(1.06, Math.min(stars,5)); this.arp([b,b*1.26,b*1.5,b*2], 'triangle', 0.22, 0.14, 0.06); }
  levelup(){ this.arp([392,523,659,784,1047,1319], 'triangle', 0.3, 0.18, 0.07); }
  mutate(){ this.arp([330,415,494,659,830], 'sine', 0.35, 0.16, 0.08); this.hiss(0.5, 0.06, 4000, 9000, this.now()+0.1); }
  contract(){ this.arp([523,659,880,1047,1319], 'triangle', 0.3, 0.15, 0.075); this.hiss(0.45, 0.05, 4000, 9000, this.now()+0.12); }
  // Soft chime for a collected spore essence — quietest run in the table because it fires often.
  essence(rarity=0){ const f = 620 + rarity*140; this.arp([f, f*1.25, f*1.5], 'sine', 0.2, 0.09, 0.045); }
  victory(){ this.arp([523,659,784,1047,784,1047,1319], 'triangle', 0.4, 0.22, 0.15); }
  /* ui */
  click(){ this.beep(800, 0.07, 'sine', 0.15, 500); }
  /* ---------- BGM sequencer ---------- */
  startBGM(){
    if(!this.ctx || this.started) return;
    this.started = true;
    // Am – F – C – G adventurous loop, 8th notes at 112bpm
    const bpm = 112, beat = 60/bpm, bar = beat*4;
    const chords = [
      [220.0, 261.63, 329.63], // Am
      [174.61, 220.0, 261.63], // F
      [196.0, 261.63, 329.63], // C
      [196.0, 246.94, 293.66], // G
    ];
    const melody = [ // [note, startBeat, lenBeats] over 4 bars
      [440,0,1],[523.25,1,0.5],[659.25,1.5,1.5],[587.33,3,1],
      [523.25,4,1],[440,5,1],[349.23,6,2],
      [523.25,8,1],[659.25,9,1],[783.99,10,1.5],[659.25,11.5,0.5],
      [587.33,12,1],[493.88,13,1],[392,14,2],
    ];
    let barCount = 0;
    const scheduleBar = (t0)=>{
      const chord = chords[barCount % 4];
      // pad
      for(const f of chord){
        this.osc('triangle', f, t0, bar*1.05, 0.06, this.bgmGain);
        this.osc('sine', f/2, t0, bar*1.05, 0.07, this.bgmGain);
      }
      // plucky arp
      for(let i=0;i<8;i++){
        const f = chord[i%3]*2;
        this.osc('square', f, t0+i*beat*0.5, 0.12, 0.028, this.bgmGain);
      }
      // soft shaker
      for(let i=0;i<8;i++) this.noise(t0+i*beat*0.5+beat*0.25, 0.05, 0.02, 6000, 9000, this.bgmGain);
      // melody
      for(const [f, sb, lb] of melody){
        const bs = barCount*4;
        if(sb >= bs && sb < bs+4){
          const tt = t0 + (sb-bs)*beat;
          this.osc('sine', f, tt, lb*beat*0.95, 0.09, this.bgmGain);
          this.osc('triangle', f*2, tt, lb*beat*0.5, 0.03, this.bgmGain);
        }
      }
      barCount++;
    };
    let nextT = this.ctx.currentTime + 0.1;
    this.bgmTimer = setInterval(()=>{
      if(!this.ctx) return;
      while(nextT < this.ctx.currentTime + bar*1.5){
        scheduleBar(nextT); nextT += bar;
      }
    }, 300);
  }
}
