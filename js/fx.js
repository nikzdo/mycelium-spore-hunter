// fx.js — toon shading, outlines, procedural textures, noise, particles
import * as THREE from 'three';

/* ---------- value/simplex-ish noise ---------- */
const P = new Uint8Array(512);
{ let s = 1337; const r = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) { const j = (r() * (i + 1)) | 0; [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255]; }
function fade(t){ return t*t*t*(t*(t*6-15)+10); }
function grad(h,x,y){ switch(h&3){case 0:return x+y;case 1:return -x+y;case 2:return x-y;default:return -x-y;} }
export function noise2(x,y){
  const X=Math.floor(x)&255, Y=Math.floor(y)&255; x-=Math.floor(x); y-=Math.floor(y);
  const u=fade(x), v=fade(y);
  const a=P[X]+Y, b=P[X+1]+Y;
  return THREE.MathUtils.lerp(
    THREE.MathUtils.lerp(grad(P[a],x,y), grad(P[b],x-1,y), u),
    THREE.MathUtils.lerp(grad(P[a+1],x,y-1), grad(P[b+1],x-1,y-1), u), v) * 0.7071;
}
export function fbm(x,y,oct=4){
  let v=0, a=0.5, f=1;
  for(let i=0;i<oct;i++){ v+=a*noise2(x*f,y*f); a*=0.5; f*=2.03; }
  return v;
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

/* ---------- particle pool (billboard sprites) ---------- */
export class ParticlePool {
  constructor(scene, max=600){
    this.max = max;
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
    if(!this.free.length) return;
    const i = this.free.pop();
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
