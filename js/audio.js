// audio.js — fully synthesized WebAudio BGM + SFX
export class GameAudio {
  constructor(){
    this.ctx = null; this.muted = false; this.started = false;
  }
  init(){
    if(this.ctx) return;
    const C = window.AudioContext || window.webkitAudioContext;
    this.ctx = new C();
    this.master = this.ctx.createGain(); this.master.gain.value = 0.55;
    // gentle lowpass "storybook" warmth
    this.filter = this.ctx.createBiquadFilter();
    this.filter.type = 'lowpass'; this.filter.frequency.value = 5200;
    this.master.connect(this.filter); this.filter.connect(this.ctx.destination);
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.9; this.sfxGain.connect(this.master);
    this.bgmGain = this.ctx.createGain(); this.bgmGain.gain.value = 0.4; this.bgmGain.connect(this.master);
  }
  resume(){ if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }
  toggleMute(){
    this.muted = !this.muted;
    if(this.master) this.master.gain.value = this.muted ? 0 : 0.55;
    return this.muted;
  }
  /* ---------- primitive helpers ---------- */
  osc(type, freq, t0, dur, vol, dest, freqEnd=null){
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if(freqEnd !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1,freqEnd), t0+dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(vol, t0+0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t0+dur);
    o.connect(g); g.connect(dest || this.sfxGain);
    o.start(t0); o.stop(t0+dur+0.05);
  }
  noise(t0, dur, vol, fLo=400, fHi=4000, dest=null){
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
  }
  /* ---------- SFX ---------- */
  swing(combo=1){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.noise(t, 0.14, 0.25, 800+combo*400, 5000);
    this.osc('sine', 300+combo*120, t, 0.12, 0.12, null, 90); }
  hit(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('square', 220, t, 0.08, 0.2, null, 110);
    this.noise(t, 0.1, 0.3, 500, 3000); }
  pop(rarity=0){ if(!this.ctx) return; const t=this.ctx.currentTime;
    const f = 500 - rarity*60;
    this.osc('sine', f, t, 0.25, 0.35, null, f*0.3);
    this.osc('triangle', f*2, t, 0.15, 0.15, null, f);
    this.noise(t, 0.25, 0.25, 300, 2500); }
  pickup(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    [523,659,784,1047].forEach((f,i)=> this.osc('sine', f, t+i*0.06, 0.18, 0.2)); }
  levelup(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    [392,523,659,784,1047,1319].forEach((f,i)=> this.osc('triangle', f, t+i*0.07, 0.3, 0.18)); }
  hurt(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('sawtooth', 180, t, 0.25, 0.25, null, 60);
    this.noise(t, 0.2, 0.3, 200, 1200); }
  dash(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.noise(t, 0.22, 0.3, 1200, 6000);
    this.osc('sine', 600, t, 0.2, 0.1, null, 1400); }
  jump(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('sine', 280, t, 0.16, 0.18, null, 620); }
  spit(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('square', 700, t, 0.12, 0.1, null, 250); }
  lunge(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.noise(t, 0.18, 0.2, 300, 1800); }
  roar(big=1){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('sawtooth', 90, t, 0.8*big+0.3, 0.35, null, 45);
    this.osc('square', 65, t+0.05, 0.7*big+0.2, 0.25, null, 38);
    this.noise(t, 0.7, 0.3, 100, 900); }
  shieldBreak(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.noise(t, 0.3, 0.3, 2000, 8000);
    this.osc('sine', 900, t, 0.3, 0.15, null, 300); }
  mutate(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    // mystical rising arpeggio + shimmer for alchemy purchases
    [330,415,494,659,830].forEach((f,i)=> this.osc('sine', f, t+i*0.08, 0.35, 0.16));
    this.noise(t+0.1, 0.5, 0.06, 4000, 9000); }
  essence(rarity=0){ if(!this.ctx) return; const t=this.ctx.currentTime;
    // soft chime when a spore essence is collected (pitch rises with rarity)
    const f = 620 + rarity*140;
    this.osc('sine', f, t, 0.22, 0.10, null, f*1.5);
    this.osc('triangle', f*2, t+0.04, 0.18, 0.05); }
  click(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.osc('sine', 800, t, 0.07, 0.15, null, 500); }
  bossSpawn(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    this.roar(1.4);
    [110,110,165,110].forEach((f,i)=> this.osc('sawtooth', f, t+i*0.3, 0.28, 0.2)); }
  victory(){ if(!this.ctx) return; const t=this.ctx.currentTime;
    [523,659,784,1047,784,1047,1319].forEach((f,i)=> this.osc('triangle', f, t+i*0.15, 0.4, 0.22)); }
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
