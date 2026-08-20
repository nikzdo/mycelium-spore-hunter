// fx.js — toon shading, outlines, procedural textures, noise, particles
import * as THREE from 'three';

/* ---------- value/simplex-ish noise ---------- */
function fade(t){ return t*t*t*(t*(t*6-15)+10); }
function grad(h,x,y){ switch(h&3){case 0:return x+y;case 1:return -x+y;case 2:return x-y;default:return -x-y;} }
// Fisher-Yates over 0..255, doubled to 512 so the lattice lookup never needs a wrap test.
function buildPerm(rand){
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (rand() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  const P = new Uint8Array(512);
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
  return P;
}
function sample(P,x,y){
  const X=Math.floor(x)&255, Y=Math.floor(y)&255; x-=Math.floor(x); y-=Math.floor(y);
  const u=fade(x), v=fade(y);
  const a=P[X]+Y, b=P[X+1]+Y;
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(grad(P[a],x,y), grad(P[b],x-1,y), u),
    THREE.MathUtils.lerp(grad(P[a+1],x,y-1), grad(P[b+1],x-1,y-1), u), v) * 0.7071;
}

// item 07 — an independent field per caller. The permutation itself comes from the passed
// stream, so seam warp / coastline mask / relief / detail are genuinely different fields and
// tuning one cannot reshape another. Offsetting *where* you sample one shared field can't do
// that: the same ridges just move.
export function makeNoise(rng){
  const P = buildPerm(rng);
  return (x,y)=>sample(P,x,y);
}

// item 08 — normalized fBm. Dividing by the summed amplitude is what keeps output amplitude
// fixed when `oct` changes, so raising detail does not force every downstream height constant
// to be re-tuned.
export function fbmOf(noiseFn, x, y, oct=4, lac=2.02, gain=0.5){
  let v=0, a=0.5, f=1, norm=0;
  for(let i=0;i<oct;i++){ v+=a*noiseFn(x*f,y*f); norm+=a; a*=gain; f*=lac; }
  return norm > 0 ? v/norm : 0;
}

// LEGACY: one module-level default field, seeded exactly as before (LCG from 1337) so every
// existing noise2()/fbm() call site in world.js keeps sampling the identical terrain.
const P = buildPerm((()=>{ let s = 1337; return () => (s = (s * 16807) % 2147483647) / 2147483647; })());
export function noise2(x,y){ return sample(P,x,y); }
export function fbm(x,y,oct=4){
  let v=0, a=0.5, f=1;
  for(let i=0;i<oct;i++){ v+=a*noise2(x*f,y*f); a*=0.5; f*=2.03; }
  return v;
}

/* ---------- palette: linearize once, then only clone and mix (item 41) ---------- */
// THREE.Color already runs hex through sRGB->linear on set() (ColorManagement is on in r160),
// so the trap is never the hex — it is raw float triples and setHSL(), which are taken as
// ALREADY linear. Convert at startup into a table, then only clone/mix the entries: a blend of
// two linear colours stays clean, a blend of two sRGB-encoded ones goes muddy.
const _lin = new Map();
export function linearColor(hex){
  let c = _lin.get(hex);
  if(!c){ c = new THREE.Color(hex); _lin.set(hex, c); }  // shared + frozen by convention: clone before mutating
  return c;
}
// Build the whole table in one pass at module/world load. Values may be hex numbers or nested objects.
export function paletteOf(spec){
  const out = Array.isArray(spec) ? [] : {};
  for(const k in spec){
    const v = spec[k];
    out[k] = (typeof v === 'number') ? new THREE.Color(v)
           : (v && typeof v === 'object') ? paletteOf(v) : v;
  }
  return out;
}
// For colours authored as 0-1 *sRGB* triples (the THEMES grass arrays are): setRGB with an
// explicit colour space converts, plain assignment does not.
export function srgbTriple(r, g, b, out=new THREE.Color()){
  return out.setRGB(r, g, b, THREE.SRGBColorSpace);
}

/* ---------- painterly canvas texture ---------- */
export function paintTexture(base, spots, opts={}){
  const s = opts.size || 256;
  const c = document.createElement('canvas'); c.width = c.height = s;
  const g = c.getContext('2d');
  // vertical gradient base
  const gr = g.createLinearGradient(0,0,0,s);
  gr.addColorStop(0, opts.top || lighten(base, 1.25));
  gr.addColorStop(0.55, base);
  gr.addColorStop(1, opts.bottom || lighten(base, 0.7));
  g.fillStyle = gr; g.fillRect(0,0,s,s);
  // painterly dabs
  for(let i=0;i<(opts.dabs??420);i++){
    const x=Math.random()*s, y=Math.random()*s, r=2+Math.random()*9;
    g.fillStyle = Math.random()<0.5 ? lighten(base,0.85+Math.random()*0.35) : lighten(base,0.65+Math.random()*0.3);
    g.globalAlpha = 0.08+Math.random()*0.14;
    g.beginPath(); g.ellipse(x,y,r,r*0.55,Math.random()*Math.PI,0,7); g.fill();
  }
  g.globalAlpha = 1;
  if(spots){ for(const sp of spots){
    for(let i=0;i<sp.n;i++){
      const x=Math.random()*s, y=Math.random()*s, r=sp.r*(0.5+Math.random());
      g.fillStyle=sp.c; g.globalAlpha=sp.a??0.9;
      g.beginPath(); g.ellipse(x,y,r,r*0.8,Math.random()*3,0,7); g.fill();
    }} g.globalAlpha=1; }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}
function lighten(hex,f){
  const c = new THREE.Color(hex);
  c.r=Math.min(1,c.r*f); c.g=Math.min(1,c.g*f); c.b=Math.min(1,c.b*f);
  return '#'+c.getHexString();
}

/* ---------- state-variant textures (item 37) ---------- */
// Bake every state a prop can be in at load, so the state change at runtime is one
// `mat.map = variants[i]` — no canvas work, no re-upload, no hitch at the moment it flips.
// INVARIANT: assign variants[0] when the material is created. Going from null map to a map
// changes the shader's define set and forces a recompile; swapping one map for another of the
// same type does not.
export function paintStates(base, defs, opts={}){
  // paintTexture wants CSS strings (canvas gradient stops); accept hex numbers too so a caller
  // can hand a palette entry straight through without stringifying at every site.
  const css = (v)=> typeof v === 'number' ? '#'+new THREE.Color(v).getHexString() : v;
  return defs.map(d => paintTexture(css(d.base ?? base), d.spots ?? null, Object.assign({}, opts, d)));
}
// Lower-level: N stages drawn by the caller (crack density, drain level, wear). `t` is 0..1
// across the stages so the draw fn scales one number instead of switching on an index.
export function canvasStates(count, draw, size=256){
  const out = [];
  for(let i=0;i<count;i++){
    const c = document.createElement('canvas'); c.width = c.height = size;
    draw(c.getContext('2d'), size, i, count > 1 ? i/(count-1) : 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    out.push(t);
  }
  return out;
}

/* ---------- toon gradient map (4 bands, soft) ---------- */
let _gradMap = null;
export function gradientMap(){
  if(_gradMap) return _gradMap;
  const bands = [90, 150, 210, 255];
  const data = new Uint8Array(bands.length*4);
  bands.forEach((v,i)=>{ data[i*4]=v; data[i*4+1]=v; data[i*4+2]=v; data[i*4+3]=255; });
  const t = new THREE.DataTexture(data, bands.length, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.LinearFilter; // soft band transitions
  t.generateMipmaps = false; t.needsUpdate = true;
  _gradMap = t; return t;
}

/* ---------- toon material with rim + band tinting ---------- */
export function toonMat(params={}){
  const m = new THREE.MeshToonMaterial({
    color: params.color ?? 0xffffff,
    map: params.map || null,
    gradientMap: gradientMap(),
    emissive: params.emissive ?? 0x000000,
    emissiveIntensity: params.emissiveIntensity ?? 1,
    transparent: !!params.transparent, opacity: params.opacity ?? 1,
    // opt-in, default off: lets shade()'s baked cylindrical highlight multiply into the toon
    // bands while the rim below still adds on top, instead of the two competing for the colour.
    vertexColors: !!params.vertexColors,
  });
  const rimColor = new THREE.Color(params.rimColor ?? 0xfff2cc);
  const rimStrength = params.rim ?? 0.45;
  const cool = new THREE.Color(params.coolTint ?? 0x8fa8ff);
  const warm = new THREE.Color(params.warmTint ?? 0xffd9a0);
  m.onBeforeCompile = (sh)=>{
    sh.uniforms.uRimColor = { value: rimColor };
    sh.uniforms.uRimStrength = { value: rimStrength };
    sh.uniforms.uCool = { value: cool };
    sh.uniforms.uWarm = { value: warm };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform vec3 uRimColor; uniform float uRimStrength; uniform vec3 uCool; uniform vec3 uWarm;`)
      .replace('#include <opaque_fragment>', `
        // warm/cool band tint + fresnel rim
        vec3 nrm = normalize( vNormal );
        vec3 vdir = normalize( vViewPosition );
        float ndl = dot( nrm, normalize( vec3(0.4,0.8,0.3) ) );
        outgoingLight *= mix( uCool*1.15, uWarm*1.15, smoothstep(-0.6, 0.9, ndl) ) ;
        float rim = pow( 1.0 - clamp( dot( nrm, vdir ), 0.0, 1.0 ), 3.0 );
        outgoingLight += uRimColor * rim * uRimStrength;
        #include <opaque_fragment>`);
  };
  return m;
}

/* ---------- inverted hull outline ---------- */
const outlineMat = new THREE.MeshBasicMaterial({ color: 0x1c1410, side: THREE.BackSide });
export function addOutline(mesh, thickness=0.03){
  const o = new THREE.Mesh(mesh.geometry, outlineMat);
  o.scale.setScalar(1 + thickness);
  o.raycast = ()=>{};
  mesh.add(o);
  return o;
}

/* ---------- generated-geometry helpers (items 38, 56) ---------- */
// item 56 — move the geometry so its local origin sits at its own lowest vertex.
// That single translate is why a shrinking prop sinks into the ground instead of contracting
// toward a floating midpoint, and the returned height is ONE number that can drive the collider
// top, the billboard height and where any contents sit — they can't disagree.
export function anchorToBase(geo){
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  geo.translate(0, -bb.min.y, 0);
  return { geo, height: bb.max.y - bb.min.y };
}

// item 38 — fake cylindrical shading baked into vertex colours. The highlight sits at a FIXED
// angle (cos(a - 2.35), the island's), so a stalk or cap reads as hand-drawn from every camera
// angle and under every real light direction. Needs a material with vertexColors:true —
// toonMat({vertexColors:true}) — where it multiplies the lit colour and leaves the rim additive.
export function shade(geo, opts={}){
  const angle  = opts.angle  ?? 2.35;   // radians; where the painted highlight lives
  const amount = opts.amount ?? 0.28;   // highlight/shadow swing around 1.0
  const ao     = opts.ao     ?? 0;      // extra darkening toward the base, 0..1
  const base   = new THREE.Color(opts.color ?? 0xffffff);
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb = geo.boundingBox, spanY = Math.max(1e-6, bb.max.y - bb.min.y);
  const col = new Float32Array(pos.count*3);
  for(let i=0;i<pos.count;i++){
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let f = 1 + amount * Math.cos(Math.atan2(z, x) - angle);
    if(ao > 0) f *= 1 - ao * (1 - (y - bb.min.y)/spanY);
    col[i*3] = base.r*f; col[i*3+1] = base.g*f; col[i*3+2] = base.b*f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col,3));
  return geo;
}

/* ---------- particle pool (billboard sprites) ---------- */
const _puffOpt = {};   // reused so puff() allocates nothing per particle
// Cap for a dedicated puff pool. 44 live puffs is the island's budget: past that a burst
// recycles instead of allocating, which is what turns a boss burst into a soft degrade.
export const PUFF_CAP = 44;
export class ParticlePool {
  constructor(scene, max=600, opts={}){
    this.max = max;
    // Live-particle ceiling, separate from the buffer size. Defaults to `max` so the existing
    // main.js pool (700) behaves exactly as before; pass {cap:PUFF_CAP} for a puff-only pool.
    this.cap = Math.min(opts.cap ?? max, max);
    const geo = new THREE.BufferGeometry();
    this.pos = new Float32Array(max*3);
    this.col = new Float32Array(max*4);
    this.sz  = new Float32Array(max);
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos,3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.col,4));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.sz,1));
    const mat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      vertexShader:`attribute vec4 aColor; attribute float aSize; varying vec4 vC;
        void main(){ vC=aColor; vec4 mv=modelViewMatrix*vec4(position,1.0);
        gl_PointSize = aSize * (300.0 / -mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader:`varying vec4 vC;
        void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d);
        float a = smoothstep(0.5, 0.1, r); gl_FragColor = vec4(vC.rgb, vC.a*a); if(gl_FragColor.a<0.01) discard; }`
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.items = []; // {i, vx,vy,vz, life, maxLife, size, r,g,b, grav, drag}
    this.free = []; for(let i=max-1;i>=0;i--) this.free.push(i);
    for(let i=0;i<max;i++) this.col[i*4+3]=0;
  }
  spawn(x,y,z, opt={}){
    let i;
    if(this.items.length >= this.cap || !this.free.length){
      // item 20 — reuse dead, then steal oldest. INVARIANT: items[] is insertion-ordered
      // (update() rebuilds it in iteration order), so items[0] IS the oldest live particle and
      // the steal is O(1). Dropping the spawn instead would make a boss burst look like a
      // dropped frame; growing the pool would make it one.
      const old = this.items.shift();
      if(!old) return;
      i = old.i;
    } else i = this.free.pop();
    const spread = opt.spread ?? 1;
    this.items.push({ i,
      x,y,z,
      vx:(opt.vx??0)+(Math.random()-0.5)*spread,
      vy:(opt.vy??0)+(Math.random()-0.5)*spread,
      vz:(opt.vz??0)+(Math.random()-0.5)*spread,
      life:0, maxLife: opt.life ?? 1,
      size: opt.size ?? 6,
      r:opt.r??1, g:opt.g??1, b:opt.b??1,
      grav: opt.grav ?? 0, drag: opt.drag ?? 0.98, a0: opt.alpha ?? 1 });
  }
  burst(p, n, opt){ for(let k=0;k<n;k++) this.spawn(p.x,p.y,p.z,opt); }
  // item 20 — THE puff. One signature carries colour/size/life/rise, so hit sparks, steam,
  // frost, pickup flashes, trails and embers are all this call with different numbers instead
  // of six near-identical emitters. `color` is a hex and goes through the linear table once.
  puff(x,y,z, opt={}){
    const o = _puffOpt;
    if(opt.color !== undefined){ const c = linearColor(opt.color); o.r = c.r; o.g = c.g; o.b = c.b; }
    else { o.r = opt.r ?? 1; o.g = opt.g ?? 1; o.b = opt.b ?? 1; }
    o.size  = opt.size  ?? 6;
    o.life  = opt.life  ?? 1;
    o.vy    = opt.rise  ?? opt.vy ?? 0;   // `rise` reads better at the call site than vy
    o.vx    = opt.vx ?? 0; o.vz = opt.vz ?? 0;
    o.spread = opt.spread ?? 1;
    o.grav  = opt.grav  ?? 0;
    o.drag  = opt.drag  ?? 0.98;
    o.alpha = opt.alpha ?? 1;
    const n = opt.n ?? 1;
    for(let k=0;k<n;k++) this.spawn(x,y,z,o);   // one reused opt object: spawn only reads it
  }
  update(dt){
    const alive = [];
    for(const p of this.items){
      p.life += dt;
      if(p.life >= p.maxLife){
        this.col[p.i*4+3]=0; this.sz[p.i]=0; this.free.push(p.i); continue;
      }
      p.vy -= p.grav*dt; p.vx*=p.drag; p.vy*=p.drag; p.vz*=p.drag;
      p.x+=p.vx*dt; p.y+=p.vy*dt; p.z+=p.vz*dt;
      const t = p.life/p.maxLife;
      this.pos[p.i*3]=p.x; this.pos[p.i*3+1]=p.y; this.pos[p.i*3+2]=p.z;
      this.col[p.i*4]=p.r; this.col[p.i*4+1]=p.g; this.col[p.i*4+2]=p.b;
      this.col[p.i*4+3]=p.a0*(1-t)*(1-t);
      this.sz[p.i]=p.size*(1-t*0.6);
      alive.push(p);
    }
    this.items = alive;
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aColor.needsUpdate = true;
    this.points.geometry.attributes.aSize.needsUpdate = true;
  }
}

/* ---------- blob shadow ---------- */
let _blobTex = null;
export function blobTexture(){
  if(_blobTex) return _blobTex;
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d');
  const gr=g.createRadialGradient(64,64,4,64,64,60);
  gr.addColorStop(0,'rgba(15,8,22,0.8)'); gr.addColorStop(1,'rgba(15,8,22,0)');
  g.fillStyle=gr; g.fillRect(0,0,128,128);
  _blobTex = new THREE.CanvasTexture(c); return _blobTex;
}
export function makeBlobShadow(scale=1){
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(scale, scale),
    new THREE.MeshBasicMaterial({ map: blobTexture(), transparent:true, depthWrite:false }));
  m.rotation.x = -Math.PI/2; m.renderOrder = 1;
  return m;
}

/* ---------- soft additive glow, for sprites and billboards ---------- */
// INVARIANT (the bug this exists to prevent): a SpriteMaterial or MeshBasicMaterial with NO map
// is not a soft glow, it is a SOLID SQUARE — alpha is a flat `opacity`, so an additive "glow"
// sprite without a texture renders as a hard-edged, screen-aligned card of colour with no
// falloff at all. Any billboarded glow must carry this map. White, so the material's `color`
// tints it; one cached canvas for the whole scene.
let _glowTex = null;
export function glowTexture(){
  if(_glowTex) return _glowTex;
  const c=document.createElement('canvas'); c.width=c.height=128;
  const g=c.getContext('2d');
  const gr=g.createRadialGradient(64,64,0,64,64,64);
  // a squared falloff, not linear: a linear ramp still reads as a disc with an edge
  gr.addColorStop(0,'rgba(255,255,255,1)');   gr.addColorStop(0.22,'rgba(255,255,255,0.62)');
  gr.addColorStop(0.5,'rgba(255,255,255,0.2)'); gr.addColorStop(0.78,'rgba(255,255,255,0.04)');
  gr.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=gr; g.fillRect(0,0,128,128);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

/* ---------- reward pops (item 19) ---------- */
// The universal "you got paid" beat: fired from every payout path so a coin, an essence tick and
// a contract completion all read as the same event. Pool is owned here and parented to a
// caller-supplied group, so a scene teardown takes the pops with it.
export class RewardPops {
  constructor(scene, opts={}){
    this.geo = opts.geo || (()=>{ const g = new THREE.CylinderGeometry(0.26,0.26,0.07,10);
      g.rotateX(Math.PI/2); return g; })();   // stood upright so the Y spin flashes the face
    this.mat = opts.mat || toonMat({ color:0xffd35c, emissive:0xffae2b, emissiveIntensity:0.55, rim:0.7 });
    this.parent = opts.parent || scene;
    this.grav = opts.grav ?? 26;
    this.life = opts.life ?? 0.85;
    this.rise = opts.rise ?? 9;
    this.items = [];   // INVARIANT: dead entries are reused in place, never spliced — the mesh
                       // stays parented and the array index stays stable for the whole run.
  }
  pop(x, y, z, n=1){
    for(let k=0;k<n;k++){
      let e = null;
      for(const it of this.items){ if(!it.alive){ e = it; break; } }
      if(!e){
        e = { mesh: new THREE.Mesh(this.geo, this.mat), vx:0, vy:0, vz:0, life:0, maxLife:1, spin:0, alive:false };
        e.mesh.castShadow = false;
        this.parent.add(e.mesh);
        this.items.push(e);
      }
      const a = Math.random()*Math.PI*2, sp = 1.6 + Math.random()*2.4;
      e.vx = Math.cos(a)*sp; e.vz = Math.sin(a)*sp;
      e.vy = this.rise*(0.8 + Math.random()*0.5);
      e.spin = (10 + Math.random()*8) * (Math.random()<0.5 ? -1 : 1);
      e.life = 0; e.maxLife = this.life*(0.85 + Math.random()*0.3);
      e.alive = true;
      e.mesh.position.set(x, y, z);
      e.mesh.rotation.set(0, Math.random()*6.28, 0);
      e.mesh.scale.setScalar(1);
      e.mesh.visible = true;
    }
  }
  update(dt){
    for(const e of this.items){
      if(!e.alive) continue;
      e.life += dt;
      if(e.life >= e.maxLife){ e.alive = false; e.mesh.visible = false; continue; }
      e.vy -= this.grav*dt;
      e.mesh.position.x += e.vx*dt; e.mesh.position.y += e.vy*dt; e.mesh.position.z += e.vz*dt;
      e.mesh.rotation.y += e.spin*dt;
      const rem = e.maxLife - e.life;
      e.mesh.scale.setScalar(rem < 0.3 ? Math.max(0.001, rem/0.3) : 1);   // shrink out, last .3s only
    }
  }
  dispose(){
    for(const e of this.items) this.parent.remove(e.mesh);
    this.items.length = 0;
    this.geo.dispose(); this.mat.dispose();
  }
}

/* ---------- billboarded world-space progress bar (item 36) ---------- */
// A bar that lives in the world instead of the HUD, so "how full is this thing" is answered at
// the thing. Caller does group.quaternion.copy(camera.quaternion) each frame — the bar does not
// keep a camera reference, so it works for any number of cameras/passes.
export function makeProgressBar(opts={}){
  const w = opts.width ?? 1.6, h = opts.height ?? 0.2, pad = opts.pad ?? 0.03;
  const order = opts.renderOrder ?? 9990;
  const group = new THREE.Group();

  const bgGeo = new THREE.PlaneGeometry(w, h);
  const bgMat = new THREE.MeshBasicMaterial({ color: opts.bg ?? 0x140e1c,
    transparent:true, opacity: opts.bgOpacity ?? 0.78, depthTest:false, depthWrite:false });
  const bg = new THREE.Mesh(bgGeo, bgMat);
  bg.renderOrder = order;                 // depthTest:false means draw order IS the z-order:
  group.add(bg);                          // explicit renderOrder is the only thing keeping the
                                          // fill in front of its own backing plate.
  const fw = w - pad*2, fh = h - pad*2;
  const fillGeo = new THREE.PlaneGeometry(fw, fh);
  fillGeo.translate(fw/2, 0, 0);          // left edge at local x=0, so a plain scale.x grows the
                                          // bar rightward and no caller has to nudge position.x
                                          // to compensate — that mistake is invisible at 100%.
  const fillMat = new THREE.MeshBasicMaterial({ color: opts.tint ?? 0x7ce0a0,
    transparent:true, depthTest:false, depthWrite:false });
  const fill = new THREE.Mesh(fillGeo, fillMat);
  fill.position.set(-fw/2, 0, 0.001);
  fill.renderOrder = order + 1;
  group.add(fill);

  return {
    group,
    set(progress01, tintHex){
      const p = progress01 < 0 ? 0 : progress01 > 1 ? 1 : progress01;
      fill.scale.x = Math.max(1e-4, p);   // exact 0 gives a degenerate matrix; 1e-4 is invisible
      fill.visible = p > 0;
      if(tintHex !== undefined) fillMat.color.set(tintHex);
    },
    dispose(){
      group.parent?.remove(group);
      bgGeo.dispose(); bgMat.dispose(); fillGeo.dispose(); fillMat.dispose();
    }
  };
}

/* ---------- frame-claim pool for transient visuals (item 54) ---------- */
// Nothing here has a lifetime: each frame re-declares the whole visible set, so the marks match
// this frame's targets exactly. No timers to expire, no despawn path to forget, nothing to leak.
export class FrameMarks {
  constructor(scene, makeMesh){
    this.scene = scene;
    this.makeMesh = makeMesh;
    this.pool = [];
    this.n = 0;
  }
  // INVARIANT: begin() must run on EVERY active frame, whatever ability/element is equipped,
  // or swapping mid-hold strands a mark that nothing will ever claim again.
  begin(){ this.n = 0; }
  mark(x, y, z, progress01=1){
    let m = this.pool[this.n];
    if(!m){                                  // allocate only when the pool is short — the pool
      m = this.makeMesh();                   // then stays at the high-water mark for the run
      m.frustumCulled = false;
      this.scene.add(m);
      this.pool.push(m);
    }
    m.visible = true;
    m.position.set(x, y, z);
    m.userData.progress = progress01;
    if(m.setProgress) m.setProgress(progress01);   // optional hook defined by makeMesh()
    this.n++;
    return m;
  }
  // INVARIANT: the not-active early-return still calls begin() then end(). That is what makes
  // releasing the input clear the visuals — end() hides from the claim index onward, so a frame
  // that claims nothing hides everything.
  end(){ for(let i=this.n;i<this.pool.length;i++) this.pool[i].visible = false; }
  dispose(){
    for(const m of this.pool){ this.scene.remove(m); m.geometry?.dispose(); }
    this.pool.length = 0; this.n = 0;
  }
}
