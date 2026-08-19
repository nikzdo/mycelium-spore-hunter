// world.js — terrain, sky, vegetation, atmosphere
import * as THREE from 'three';
import { fbm, noise2, paintTexture, toonMat, addOutline } from './fx.js';
import { mulberry32, deriveSeed } from './rng.js';
import { MUSHROOM_SPECIES, SPECIES_BY_ID } from './mushrooms.js';

export const WORLD_SIZE = 420;

// seed-driven noise offsets, set by buildWorld before terrain is sampled
let OFF = { x:0, z:0 };
// seeded ravine (gully) for this world — null if this world doesn't have one.
// a 2-segment bent path {ax,az -> bx,bz -> cx,cz} with a width/depth.
let RAVINE = null;

// cheap 2D point-to-segment distance — no allocations, called from groundHeight (runs every frame per entity)
function distToSeg(px, pz, ax, az, bx, bz){
  const abx = bx-ax, abz = bz-az;
  const len2 = abx*abx + abz*abz || 1;
  const t = Math.max(0, Math.min(1, ((px-ax)*abx + (pz-az)*abz) / len2));
  const cx = ax + abx*t, cz = az + abz*t;
  return Math.hypot(px-cx, pz-cz);
}
function ravineDepth(x, z){
  if(!RAVINE) return 0;
  const d = Math.min(
    distToSeg(x, z, RAVINE.ax, RAVINE.az, RAVINE.bx, RAVINE.bz),
    distToSeg(x, z, RAVINE.bx, RAVINE.bz, RAVINE.cx, RAVINE.cz));
  const t = 1 - THREE.MathUtils.smoothstep(d, RAVINE.width*0.35, RAVINE.width);
  return t*t*RAVINE.depth;
}

/* ---------------- curated palette themes ---------------- */
export const THEMES = [
  { name:'Golden Meadow',
    skyTop:0x2a6bc7, skyMid:0x9e8cb8, skyBot:0xffb86b, fog:0xf2c08e,
    sun:0xffe0b0, hemiSky:0xbcd8ff, hemiGround:0x6b4a2f,
    grassBase:[0.30,0.55,0.20, 0.38,0.52,0.24], grassTip:[0.66,0.84,0.34, 0.85,0.80,0.40],
    terraHue:0, terraSat:0, canopyHue:0, canopySat:0.55, canopyBase:0x69b043 },
  { name:'Teal Dusk',
    skyTop:0x1d5f8f, skyMid:0x6f8fae, skyBot:0x7fe0c8, fog:0xa8d8c8,
    sun:0xd8f0e0, hemiSky:0x9fd8e8, hemiGround:0x3f5a4a,
    grassBase:[0.16,0.46,0.34, 0.20,0.44,0.38], grassTip:[0.42,0.78,0.52, 0.62,0.82,0.58],
    terraHue:0.32, terraSat:0.04, canopyHue:0.10, canopySat:0.5, canopyBase:0x3fae7a },
  { name:'Blossom Spring',
    skyTop:0x4a6fd0, skyMid:0xc89cc8, skyBot:0xffc8d8, fog:0xf0c8d0,
    sun:0xffe8d8, hemiSky:0xd8c8ff, hemiGround:0x7a5a5f,
    grassBase:[0.34,0.56,0.26, 0.42,0.54,0.30], grassTip:[0.72,0.86,0.44, 0.88,0.84,0.52],
    terraHue:-0.03, terraSat:0.05, canopyHue:-0.16, canopySat:0.58, canopyBase:0x8fc85a },
  { name:'Ember Autumn',
    skyTop:0x35458f, skyMid:0xb07a8c, skyBot:0xff9a52, fog:0xe8a878,
    sun:0xffc890, hemiSky:0xc8a8c8, hemiGround:0x7a4a2f,
    grassBase:[0.44,0.44,0.16, 0.48,0.40,0.20], grassTip:[0.88,0.70,0.28, 0.92,0.62,0.30],
    terraHue:-0.06, terraSat:0.06, canopyHue:-0.19, canopySat:0.62, canopyBase:0xc8882e },
];

// terrain height *without* the ravine carve — this is "where the ground used to be" before the
// gully cut through it, which is what a bridge deck should rest at (and what a ravine is measured
// relative to). Exported so a bridge landmark can query it directly.
export function baseTerrainHeight(x, z){
  const d = Math.sqrt(x*x + z*z);
  let h = fbm(x*0.012+7.3+OFF.x, z*0.012+2.1+OFF.z, 4) * 10;
  h += fbm(x*0.05+OFF.x*0.5, z*0.05+OFF.z*0.5, 2) * 1.2;
  // rolling hills: broad, gentle, low-frequency bumps — masked so only some regions turn hilly,
  // and the mask itself is seed-offset, so which regions are hilly differs every world
  const hillMask = THREE.MathUtils.smoothstep(fbm(x*0.006+OFF.x*0.3+40, z*0.006+OFF.z*0.3+40, 2), 0.02, 0.32);
  h += fbm(x*0.022+OFF.x*0.6+90, z*0.022+OFF.z*0.6+90, 3) * 15 * hillMask;
  // flatten spawn clearing, raise edges into valley walls
  h *= THREE.MathUtils.smoothstep(d, 8, 40);
  h += THREE.MathUtils.smoothstep(d, 150, 210) * 26;
  return h;
}
export function groundHeight(x, z){
  return baseTerrainHeight(x, z) - ravineDepth(x, z);
}

export function buildWorld(scene, quality=1, seed=1){
  const rng = mulberry32(deriveSeed(seed, 0x51ed));
  OFF = { x: (rng()*2-1)*180, z: (rng()*2-1)*180 };
  const theme = THEMES[(rng()*THEMES.length)|0];
  const world = { updaters: [], seed, theme };
  // seeded ravine: ~60% of worlds get one, giving a bridge-crossing layout feature; the rest don't
  RAVINE = null;
  if(rng() < 0.6){
    const a0 = rng()*Math.PI*2, d0 = 45 + rng()*70;
    const ax = Math.cos(a0)*d0, az = Math.sin(a0)*d0;
    const curveA = a0 + (rng()-0.5)*1.6, segLen = 30 + rng()*30;
    const bx = ax + Math.cos(curveA)*segLen, bz = az + Math.sin(curveA)*segLen;
    const curveB = curveA + (rng()-0.5)*1.6;
    const cx = bx + Math.cos(curveB)*segLen, cz = bz + Math.sin(curveB)*segLen;
    RAVINE = { ax, az, bx, bz, cx, cz, width: 5+rng()*3, depth: 5+rng()*3 };
  }

  // ---- seeded regional "pockets": optional themed clusters so each world's zones read
  // as distinct places worth remembering, not just a uniform prop scatter with a palette
  // swap. each is independently rolled — a world can have none, some, or all of them. ----
  const POCKETS = {};
  const rollPocket = (minD, maxD)=>{
    const a = rng()*Math.PI*2, d = minD + rng()*(maxD-minD);
    return { x: Math.cos(a)*d, z: Math.sin(a)*d, r: 14 + rng()*10 };
  };
  if(rng() < 0.55) POCKETS.crystalHollow = rollPocket(30, 165);
  if(rng() < 0.55) POCKETS.fungalWarren = { ...rollPocket(20, 150), species: MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0].id };
  if(rng() < 0.5) POCKETS.witheredHollow = rollPocket(20, 100);
  // corruption used to be a perfect ring around the origin — same every world. now a
  // witheredHollow pocket can push a patch of it much closer to spawn, unpredictably.
  function corruptionAt(x, z){
    let c = THREE.MathUtils.smoothstep(Math.hypot(x, z), 65, 195);
    const wh = POCKETS.witheredHollow;
    if(wh){
      const pd = Math.hypot(x-wh.x, z-wh.z);
      c = Math.max(c, (1 - THREE.MathUtils.smoothstep(pd, wh.r*0.4, wh.r)) * 0.85);
    }
    return c;
  }
  // which "big" set-piece landmarks this world gets — not all of them every time, so the
  // landmark *set itself* reads as different between worlds, not just repositioned.
  // guaranteed >=2 so no world ends up feeling like a bare field.
  const BIG_LANDMARKS = ['tower','stones','geysers','pond'];
  let landmarkRoll = BIG_LANDMARKS.filter(()=> rng() < 0.62);
  if(landmarkRoll.length < 2){
    const missing = BIG_LANDMARKS.filter(id=>!landmarkRoll.includes(id));
    while(landmarkRoll.length < 2 && missing.length) landmarkRoll.push(missing.splice((rng()*missing.length)|0, 1)[0]);
  }
  const hasLandmark = id => landmarkRoll.includes(id);

  // seeded 2D-noise helpers (offset so terrain + groves vary per seed)
  const n2 = (x,y)=>noise2(x+OFF.x, y+OFF.z);
  const fb = (x,y,o)=>fbm(x+OFF.x, y+OFF.z, o);

  /* ----- fog + lighting ----- */
  scene.fog = new THREE.FogExp2(theme.fog, 0.0030);
  scene.background = new THREE.Color(theme.fog);
  const sun = new THREE.DirectionalLight(theme.sun, 2.9);
  sun.position.set(60, 90, 30);
  scene.add(sun);
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 0.85);
  scene.add(hemi);

  /* ----- sky dome ----- */
  const skyGeo = new THREE.SphereGeometry(900, 32, 20);
  const sunBaseDir = new THREE.Vector3(0.55,0.38,0.28).normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false, fog:false,
    uniforms:{ uTime:{value:0},
      uTop:{value:new THREE.Color(theme.skyTop)},
      uMid:{value:new THREE.Color(theme.skyMid)},
      uBot:{value:new THREE.Color(theme.skyBot)},
      uSunDir:{value:sunBaseDir.clone()} },
    vertexShader:`varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vP; uniform float uTime;
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBot; uniform vec3 uSunDir;
      void main(){
        float h = normalize(vP).y;
        vec3 top = uTop;
        vec3 mid = uMid;
        vec3 bot = uBot;
        vec3 col = mix(bot, mid, smoothstep(-0.05,0.22,h));
        col = mix(col, top, smoothstep(0.16,0.7,h));
        // BIG stylized sun with halo — direction slowly sweeps (set from JS via uSunDir)
        vec3 sunDir = normalize(uSunDir);
        float s = dot(normalize(vP), sunDir);
        col += vec3(1.0,0.92,0.65) * smoothstep(0.9970,0.9985,s) * 2.2;   // disc
        col += vec3(1.0,0.80,0.45) * pow(max(s,0.0), 90.0) * 0.9;          // inner halo
        col += vec3(1.0,0.62,0.30) * pow(max(s,0.0), 12.0) * 0.35;         // wide glow
        col += vec3(1.0,0.85,0.55) * smoothstep(0.9982,0.9986,s) * (1.0-smoothstep(0.9987,0.9990,s)) * 1.4; // rim ring
        gl_FragColor = vec4(col,1.0);
      }`
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  // slow day-cycle sweep: rotate the sun direction + light together, dip warmth at low sun angle
  const sunDist = Math.hypot(60,90,30);
  const sunAxisZ = new THREE.Vector3(0,0,1), sunAxisY = new THREE.Vector3(0,1,0);
  const sunDir = new THREE.Vector3(); // reused every frame — no per-frame allocation
  world.updaters.push((dt,t)=>{
    const cycle = t*0.05; // ~126s per full sweep
    sunDir.copy(sunBaseDir).applyAxisAngle(sunAxisZ, Math.sin(cycle)*0.5).applyAxisAngle(sunAxisY, cycle*0.6);
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    sun.position.copy(sunDir).multiplyScalar(sunDist);
    const elevation = sunDir.y;
    sun.intensity = 2.2 + Math.max(0, elevation)*1.2;
    hemi.intensity = 0.7 + Math.max(0, elevation)*0.25;
  });

  /* ----- terrain ----- */
  const segs = 160;
  const tg = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segs, segs);
  tg.rotateX(-Math.PI/2);
  const tp = tg.attributes.position;
  const colors = new Float32Array(tp.count*3);
  const tint = (hex)=>{ const c = new THREE.Color(hex); c.offsetHSL(theme.terraHue, theme.terraSat, 0); return c; };
  const cGrass = tint(0x5fa838), cEmerald = tint(0x2e7d33);
  const cDry = tint(0xb99b41), cMoss = tint(0x27572a);
  const cDirt = tint(0x9c6b3d), cRock = tint(0x7d7488);
  const cClear = tint(0xc9a35c), cPath = tint(0xc98f52);
  const cCorruptGround = tint(0x3a2a48);
  const tmpC = new THREE.Color();
  // worn dirt paths radiating from spawn (directions seeded)
  const pathRot = rng()*Math.PI*2;
  const pathDirs = [0, 2.2, 4.3].map(a=>{
    const t = a + pathRot;
    return new THREE.Vector2(Math.cos(t), Math.sin(t));
  });
  for(let i=0;i<tp.count;i++){
    const x=tp.getX(i), z=tp.getZ(i);
    const h = groundHeight(x,z);
    tp.setY(i,h);
    const d = Math.sqrt(x*x+z*z);
    // multi-scale painterly blotches
    const b1 = fb(x*0.018+99, z*0.018, 3);
    const b2 = fb(x*0.07+31, z*0.07+11, 2);
    const grove = THREE.MathUtils.smoothstep(n2(x*0.05, z*0.05), 0.02, 0.4);
    tmpC.copy(cGrass);
    tmpC.lerp(cEmerald, THREE.MathUtils.smoothstep(b1, 0.05, 0.45));       // deep emerald patches
    tmpC.lerp(cDry, THREE.MathUtils.smoothstep(-b1, 0.18, 0.5)*0.85);      // warm dry-grass patches
    tmpC.lerp(cMoss, THREE.MathUtils.smoothstep(-b2, 0.15, 0.45)*0.6);     // dark moss speckle
    tmpC.lerp(cMoss, grove*0.55);                                          // dark forest floor under groves
    // worn dirt paths from spawn
    let pathW = 0;
    for(const pd of pathDirs){
      const perp = Math.abs(x*(-pd.y) - z*pd.x) + fb(x*0.1, z*0.1, 2)*2.2;
      pathW = Math.max(pathW, (1 - THREE.MathUtils.smoothstep(perp, 1.8, 4.2)) * THREE.MathUtils.smoothstep(d, 6, 14));
    }
    tmpC.lerp(cPath, Math.min(0.85, pathW));
    if(h > 9) tmpC.lerp(cRock, THREE.MathUtils.smoothstep(h,9,20));
    // steep hillsides read as bare rock rather than grass, like a real slope would
    const slope = (Math.abs(groundHeight(x+1.4,z)-h) + Math.abs(groundHeight(x,z+1.4)-h)) / 1.4;
    tmpC.lerp(cRock, Math.min(0.6, THREE.MathUtils.smoothstep(slope, 0.4, 1.15)*0.6));
    tmpC.lerp(cCorruptGround, corruptionAt(x,z)*0.5); // ground itself sickens along with the trees/rocks
    if(d < 9) tmpC.lerp(cClear, (1-d/9)*0.6);
    // painterly variation
    tmpC.offsetHSL(n2(x*0.15,z*0.15)*0.015, 0.05, n2(x*0.3,z*0.3)*0.045);
    colors[i*3]=tmpC.r; colors[i*3+1]=tmpC.g; colors[i*3+2]=tmpC.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors,3));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, toonMat({ color:0xffffff, rim:0.12, coolTint:0xa8c8a0, warmTint:0xfff0c0 }));
  terrain.material.vertexColors = true;
  scene.add(terrain);

  /* ----- distant mountains (3 hazy purple-blue layers) ----- */
  const mGeo = new THREE.ConeGeometry(1,1,5);
  const mRings = [
    { col:0x6a5490, op:0.95, dist:430, h:170 },
    { col:0x8d76b0, op:0.7,  dist:580, h:200 },
    { col:0xbaa9cf, op:0.45, dist:740, h:240 },
  ];
  for(let ring=0; ring<3; ring++){
    const R = mRings[ring];
    for(let i=0;i<8;i++){
      const a = (i/8)*Math.PI*2 + ring*0.35 + n2(i,3+ring)*0.4;
      const dist = R.dist + n2(i,9)*50;
      const m = new THREE.Mesh(mGeo, new THREE.MeshBasicMaterial({ color:R.col, fog:false, transparent:true, opacity:R.op }));
      m.material.color.offsetHSL(n2(i,7)*0.02 + theme.terraHue*0.5, 0, n2(i,5)*0.05);
      m.position.set(Math.cos(a)*dist, 8, Math.sin(a)*dist);
      m.scale.set(150+rng()*110, R.h*(0.7+rng()*0.6), 150);
      scene.add(m);
    }
  }

  /* ----- toon clouds (billboards) ----- */
  const cloudTex = makeCloudTexture();
  const clouds = [];
  for(let i=0;i<20;i++){
    const sm = new THREE.SpriteMaterial({ map:cloudTex, transparent:true, opacity:0.9, depthWrite:false, fog:false });
    const s = new THREE.Sprite(sm);
    s.position.set((rng()-0.5)*800, 70+rng()*90, (rng()-0.5)*800);
    const sc = 80+rng()*120; s.scale.set(sc, sc*0.5, 1);
    scene.add(s); clouds.push(s);
  }
  world.updaters.push((dt)=>{
    for(const c of clouds){ c.position.x += dt*1.5; if(c.position.x>400) c.position.x=-400; }
  });

  /* ----- trees (instanced trunks + canopies) ----- */
  const treePos = [];
  for(let i=0;i<520 && treePos.length<110;i++){
    const x=(rng()-0.5)*WORLD_SIZE*0.92, z=(rng()-0.5)*WORLD_SIZE*0.92;
    const d=Math.hypot(x,z);
    if(d<16 || d>195) continue;
    if(n2(x*0.05, z*0.05) < -0.05) continue; // groves
    treePos.push([x, groundHeight(x,z), z]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.7, 6, 6);
  trunkGeo.translate(0,3,0);
  // bend the trunk
  { const p=trunkGeo.attributes.position;
    for(let i=0;i<p.count;i++){ const y=p.getY(i); p.setX(i, p.getX(i)+Math.sin(y*0.4)*0.8); } }
  const trunkMat = toonMat({ color:0x8a5a35, map:paintTexture('#8a5a35', null, {dabs:200}), rim:0.25 });
  const canGeo = new THREE.IcosahedronGeometry(3.4, 1);
  { const p=canGeo.attributes.position;
    for(let i=0;i<p.count;i++){
      const v=new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i));
      const n = 1 + noise2(v.x*0.8+v.y, v.z*0.8)*0.25;
      p.setXYZ(i, v.x*n, v.y*n*0.8, v.z*n); } }
  const canBase = new THREE.Color(theme.canopyBase);
  const canDark = canBase.clone().offsetHSL(0, 0.05, -0.10);
  const canMat = toonMat({ color:theme.canopyBase,
    map:paintTexture('#'+canBase.getHexString(),[{c:'#'+canDark.getHexString(),n:60,r:14,a:0.25}],{dabs:300}), rim:0.6, rimColor:0xe8ffb0 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treePos.length);
  const cans = new THREE.InstancedMesh(canGeo, canMat, treePos.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3();
  const canColor = new THREE.Color();
  const corruptCol = new THREE.Color(0x2a1a3a);
  const trunkColor = new THREE.Color();
  const trunkCorrupt = new THREE.Color(0x241826);
  treePos.forEach(([x,y,z],i)=>{
    const s = 0.8+rng()*0.9;
    Q.setFromEuler(new THREE.Euler(0, rng()*7, (rng()-0.5)*0.12));
    M.compose(V.set(x,y-0.3,z), Q, S.set(s,s,s));
    trunks.setMatrixAt(i,M);
    M.compose(V.set(x+Math.sin(2.4)*0.8*s, y+6.1*s, z), Q, S.set(s*(0.9+rng()*0.5), s, s*(0.9+rng()*0.5)));
    cans.setMatrixAt(i,M);
    // corruption gradient: healthy near spawn, twisted/dark deep in the Heart of the Bloom
    const corrupt = corruptionAt(x,z);
    canColor.setHSL(((0.26+rng()*0.08+theme.canopyHue)%1+1)%1, theme.canopySat, 0.42+rng()*0.12);
    canColor.lerp(corruptCol, corrupt*0.85);
    cans.setColorAt(i, canColor);
    trunkColor.setRGB(1,1,1).lerp(trunkCorrupt, corrupt*0.7);
    trunks.setColorAt(i, trunkColor);
  });
  scene.add(trunks, cans);
  // ink outline hulls for canopies (instanced BackSide)
  const hullMat = new THREE.MeshBasicMaterial({ color:0x241a12, side:THREE.BackSide });
  const canHull = new THREE.InstancedMesh(canGeo, hullMat, treePos.length);
  // copy canopy matrices with ~8% larger local scale
  const P2 = new THREE.Vector3(), Q2 = new THREE.Quaternion(), S2 = new THREE.Vector3();
  for(let i=0;i<treePos.length;i++){
    cans.getMatrixAt(i, M);
    M.decompose(P2, Q2, S2);
    canHull.setMatrixAt(i, M.compose(P2, Q2, S2.multiplyScalar(1.08)));
  }
  scene.add(canHull);
  world.treePos = treePos;

  /* ----- rocks (dry grey + mossy variants) ----- */
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  { const p = rockGeo.attributes.position; // knock off the perfect-solid look
    for(let i=0;i<p.count;i++){
      const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
      const j = 1 + noise2(x*1.6+y, z*1.6)*0.16;
      p.setXYZ(i, x*j, y*j, z*j);
    }
    rockGeo.computeVertexNormals(); }
  function makeStrataTexture(){
    const c=document.createElement('canvas'); c.width=64; c.height=64;
    const g=c.getContext('2d');
    const bands = ['#9a8f96','#877c84','#726a78','#8a7460','#6d6068','#94897c'];
    let y=0;
    while(y<64){
      const h = 5+Math.random()*8;
      g.fillStyle = bands[(Math.random()*bands.length)|0];
      g.beginPath(); g.moveTo(0,y);
      for(let x=0;x<=64;x+=8) g.lineTo(x, y+Math.sin(x*0.4+y)*1.5);
      g.lineTo(64,y+h); g.lineTo(0,y+h); g.fill();
      y += h;
    }
    const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace;
    t.wrapS=t.wrapT=THREE.RepeatWrapping; return t;
  }
  const rockMat = toonMat({ color:0xffffff, map: makeStrataTexture(), rim:0.3 });
  // build ALL rock placements — ambient scatter, dramatic formations, and cave-mound walls —
  // into one list so it's still exactly one InstancedMesh draw call no matter how much variety we add
  const rockPlacements = [];
  // ambient scatter (unchanged density from before)
  for(let i=0;i<70;i++){
    const x=(rng()-0.5)*WORLD_SIZE*0.9, z=(rng()-0.5)*WORLD_SIZE*0.9;
    const s=0.5+rng()*2.2;
    rockPlacements.push({ x, z, s, sy:s*0.75, rx:rng(), ry:rng()*7, rz:rng() });
  }
  // dramatic rock formations: small dense clusters of bigger rocks, so some places read as
  // a deliberate outcrop/cliff rather than scattered clutter — 3-5 per world, unique each time
  const formationCount = 3 + ((rng()*3)|0);
  for(let f=0; f<formationCount; f++){
    const fa=rng()*Math.PI*2, fd=20+rng()*165;
    const fx=Math.cos(fa)*fd, fz=Math.sin(fa)*fd;
    const memberCount = 4 + ((rng()*5)|0);
    for(let m=0;m<memberCount;m++){
      const oa=rng()*Math.PI*2, od=rng()*3.5;
      const x=fx+Math.cos(oa)*od, z=fz+Math.sin(oa)*od;
      const s = 1.2+rng()*2.6;
      rockPlacements.push({ x, z, s, sy:s*(0.7+rng()*0.5), rx:rng()*0.4, ry:rng()*7, rz:rng()*0.4 });
    }
  }
  // cave mouths: pick 1-2 spots, wall them in with big rocks on every side but the mouth
  // direction. actual cave interior (void/light/glow) is built later once decorative-mushroom
  // geometry is available to reuse; here we just reserve the spots + build the rock walls.
  const caveSpots = [];
  const caveCount = 1 + (rng()<0.5 ? 1 : 0);
  for(let c=0;c<caveCount;c++){
    const ca=rng()*Math.PI*2, cd=50+rng()*110;
    const cx=Math.cos(ca)*cd, cz=Math.sin(ca)*cd, cy=groundHeight(cx,cz);
    const mouthDir = rng()*Math.PI*2;
    caveSpots.push({ cx, cz, cy, mouthDir });
    for(let k=0;k<8;k++){
      const ang = mouthDir + Math.PI + (rng()-0.5)*2.6; // wall rocks opposite the mouth opening
      const rad = 2.6+rng()*2.4;
      const x = cx+Math.cos(ang)*rad, z = cz+Math.sin(ang)*rad;
      const s = 2.2+rng()*1.8;
      rockPlacements.push({ x, z, s, sy:s*(0.9+rng()*0.4), rx:rng()*0.3, ry:rng()*7, rz:rng()*0.3 });
    }
  }
  world.caveSpots = caveSpots;
  const rockCount = rockPlacements.length;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  const rockDry = new THREE.Color(0xb0a8a0), rockMoss = new THREE.Color(0x6d8a52), rockCorrupt = new THREE.Color(0x241a30);
  rockPlacements.forEach((rp,i)=>{
    Q.setFromEuler(new THREE.Euler(rp.rx, rp.ry, rp.rz));
    M.compose(V.set(rp.x, groundHeight(rp.x,rp.z)+rp.s*0.2, rp.z), Q, S.set(rp.s, rp.sy, rp.s));
    rocks.setMatrixAt(i, M);
    const mossAmt = rng() < 0.4 ? 0.35+rng()*0.5 : rng()*0.12;
    const corrupt = corruptionAt(rp.x,rp.z);
    rocks.setColorAt(i, rockDry.clone().lerp(rockMoss, mossAmt).lerp(rockCorrupt, corrupt*0.75));
  });
  scene.add(rocks);
  const rockHull = new THREE.InstancedMesh(rockGeo, hullMat, rockCount);
  { const P3 = new THREE.Vector3(), Q3 = new THREE.Quaternion(), S3 = new THREE.Vector3();
    for(let i=0;i<rockCount;i++){
      rocks.getMatrixAt(i, M);
      M.decompose(P3, Q3, S3);
      rockHull.setMatrixAt(i, M.compose(P3, Q3, S3.multiplyScalar(1.09)));
    } }
  scene.add(rockHull);

  /* ----- LANDMARK: rune boulder ----- */
  {
    const ba = rng()*Math.PI*2, bd = 30 + rng()*140;
    const bx = Math.cos(ba)*bd, bz = Math.sin(ba)*bd, by = groundHeight(bx, bz);
    const boulder = new THREE.Mesh(rockGeo, rockMat.clone());
    boulder.material.color.set(rockMoss.clone().lerp(rockDry, 0.3));
    const bs = 3.2 + rng()*1.2;
    boulder.scale.set(bs, bs*0.8, bs);
    boulder.rotation.set(rng(), rng()*7, rng()*0.3);
    boulder.position.set(bx, by+bs*0.35, bz);
    addOutline(boulder, 0.03);
    scene.add(boulder);
    const runeMat2 = new THREE.MeshBasicMaterial({ color:0x7de8ff, transparent:true, opacity:0.85,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });
    const rune2 = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.9, 3), runeMat2);
    rune2.position.set(bx + Math.cos(ba+1.6)*bs*0.75, by+bs*0.55, bz + Math.sin(ba+1.6)*bs*0.75);
    rune2.lookAt(bx, by+bs*0.55, bz); rune2.rotateY(Math.PI);
    scene.add(rune2);
    const pl3 = new THREE.PointLight(0x7de8ff, 8, 14); pl3.position.set(bx, by+bs*0.6, bz);
    scene.add(pl3);
    world.updaters.push((dt,t)=>{ runeMat2.opacity = 0.6+Math.sin(t*1.5)*0.25; rune2.rotation.z = t*0.3; });
  }

  /* ----- LANDMARK: ravine bridge (only in worlds that got a ravine) ----- */
  if(RAVINE){
    const bx = RAVINE.bx, bz = RAVINE.bz;
    // tangent direction along the ravine's path at the crossing point (average of both segments)
    const t1x=RAVINE.bx-RAVINE.ax, t1z=RAVINE.bz-RAVINE.az, t1l=Math.hypot(t1x,t1z)||1;
    const t2x=RAVINE.cx-RAVINE.bx, t2z=RAVINE.cz-RAVINE.bz, t2l=Math.hypot(t2x,t2z)||1;
    let dirX=t1x/t1l+t2x/t2l, dirZ=t1z/t1l+t2z/t2l;
    const dirLen=Math.hypot(dirX,dirZ)||1; dirX/=dirLen; dirZ/=dirLen;
    const baseY = baseTerrainHeight(bx, bz); // deck sits at the pre-ravine ground level
    const spanLen = RAVINE.width*2.4;
    const deckMat = toonMat({ color:0x8a5a35,
      map: paintTexture('#6a4525', [{c:'#4a3018', n:24, r:5, a:0.45}], {dabs:220}), rim:0.25 });
    const railMat = toonMat({ color:0x5a3a1f, rim:0.3 });
    const group = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, spanLen), deckMat);
    addOutline(deck, 0.04);
    group.add(deck);
    for(const side of [-1,1]){
      const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, spanLen, 6), railMat);
      rail.rotation.x = Math.PI/2;
      rail.position.set(0.8*side, 0.55, 0);
      addOutline(rail, 0.08);
      group.add(rail);
      for(const k of [-1,0,1]){
        const post = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.75, 5), railMat);
        post.position.set(0.8*side, 0.28, k*spanLen*0.47);
        group.add(post);
      }
    }
    group.position.set(bx, baseY-0.22, bz);
    group.rotation.y = Math.atan2(dirX, dirZ);
    scene.add(group);
  }

  /* ----- bushes (mid-height clutter between grass and trees) ----- */
  const bushGeo = new THREE.IcosahedronGeometry(0.85, 1);
  { const p = bushGeo.attributes.position;
    for(let i=0;i<p.count;i++){
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const n = 1 + noise2(v.x*0.9+v.y, v.z*0.9)*0.22;
      p.setXYZ(i, v.x*n, v.y*n*0.72, v.z*n);
    } }
  const bushBase = new THREE.Color(0x4a7a2e).offsetHSL(theme.canopyHue*0.6, 0, 0);
  const bushMat = toonMat({ color:0xffffff,
    map: paintTexture('#'+bushBase.getHexString(), [{c:'#2f5a1c', n:40, r:12, a:0.3}], {dabs:220}),
    rim:0.45, rimColor:0xc8ffb0 });
  const bushCount = 70;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushCount);
  for(let i=0;i<bushCount;i++){
    const a=rng()*Math.PI*2, r=9+rng()*160;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const s = 0.5+rng()*0.7;
    Q.setFromEuler(new THREE.Euler(0, rng()*7, 0));
    M.compose(V.set(x, groundHeight(x,z)+0.3*s, z), Q, S.set(s, s*0.85, s));
    bushes.setMatrixAt(i, M);
  }
  scene.add(bushes);
  const bushHull = new THREE.InstancedMesh(bushGeo, hullMat, bushCount);
  { const Pb=new THREE.Vector3(), Qb=new THREE.Quaternion(), Sb=new THREE.Vector3();
    for(let i=0;i<bushCount;i++){
      bushes.getMatrixAt(i, M);
      M.decompose(Pb, Qb, Sb);
      bushHull.setMatrixAt(i, M.compose(Pb, Qb, Sb.multiplyScalar(1.08)));
    } }
  scene.add(bushHull);

  /* ----- fallen logs (knotted, moss-grown forest-floor debris) ----- */
  function makeRingTexture(){
    const c=document.createElement('canvas'); c.width=c.height=128;
    const g=c.getContext('2d');
    g.fillStyle='#e8d4a8'; g.fillRect(0,0,128,128);
    const rings=['#c9a86c','#a8824a','#8a6234','#c9a86c','#b08a52'];
    for(let r=58;r>4;r-=6+Math.random()*3){
      g.strokeStyle=rings[(r/6)|0 % rings.length]; g.lineWidth=1.6+Math.random();
      g.beginPath(); g.ellipse(64,64,r,r*(0.94+Math.random()*0.1),Math.random()*0.3,0,7); g.stroke();
    }
    // a couple of hairline cracks
    g.strokeStyle='rgba(90,60,30,0.5)'; g.lineWidth=1;
    for(let i=0;i<3;i++){ g.beginPath(); g.moveTo(64,64);
      const a=Math.random()*7; g.lineTo(64+Math.cos(a)*60, 64+Math.sin(a)*60); g.stroke(); }
    const t=new THREE.CanvasTexture(c); t.colorSpace=THREE.SRGBColorSpace; return t;
  }
  const logGeo = new THREE.CylinderGeometry(0.4, 0.5, 3.4, 9, 5, true); // openEnded — the textured cap disc is the only end face, avoids z-fighting
  { const p = logGeo.attributes.position; // knock the perfect-tube look into something knotted/irregular
    for(let i=0;i<p.count;i++){
      const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
      const bulge = 1 + noise2(y*1.3, Math.atan2(z,x)*1.4)*0.16 + Math.sin(y*2.1)*0.04;
      p.setXYZ(i, x*bulge, y, z*bulge);
    }
    logGeo.computeVertexNormals(); }
  const logMat = toonMat({ color:0x8a5a35,
    map: paintTexture('#6a4525', [{c:'#4a3018', n:30, r:5, a:0.45}, {c:'#3a2818', n:14, r:3, a:0.5}], {dabs:260}), rim:0.25 });
  const capMatLog = toonMat({ color:0xffffff, map: makeRingTexture(), rim:0.2 });
  const logCount = 22;
  const logs = new THREE.InstancedMesh(logGeo, logMat, logCount);
  const logCaps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.5, 14), capMatLog, logCount*2);
  const logData = [];
  for(let i=0;i<logCount;i++){
    const a=rng()*Math.PI*2, r=14+rng()*165;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const s = 0.7+rng()*0.7;
    const yaw = rng()*7, roll = (rng()-0.5)*0.2;
    Q.setFromEuler(new THREE.Euler(Math.PI/2, yaw, roll));
    const y = groundHeight(x,z)+0.42*s;
    M.compose(V.set(x, y, z), Q, S.set(s, s, s));
    logs.setMatrixAt(i, M);
    logData.push({x, y, z, s, yaw, q:Q.clone()});
    // end caps: offset along the log's local +/-Y (length) axis, each facing outward from its own end
    const axis = new THREE.Vector3(0,1,0).applyQuaternion(Q);
    for(const dir of [-1,1]){
      const capQ = Q.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(dir<0?Math.PI/2:-Math.PI/2,0,0)));
      const cp = new THREE.Vector3(x,y,z).addScaledVector(axis, dir*1.7*s);
      M.compose(cp, capQ, S.set(s*0.85,s*0.85,s*0.85));
      logCaps.setMatrixAt(logData.length*2 - (dir===-1?2:1), M);
    }
  }
  scene.add(logs, logCaps);
  const logHull = new THREE.InstancedMesh(logGeo, hullMat, logCount);
  { const Pl=new THREE.Vector3(), Ql=new THREE.Quaternion(), Sl=new THREE.Vector3();
    for(let i=0;i<logCount;i++){
      logs.getMatrixAt(i, M);
      M.decompose(Pl, Ql, Sl);
      logHull.setMatrixAt(i, M.compose(Pl, Ql, Sl.multiplyScalar(1.07)));
    } }
  scene.add(logHull);
  // moss patches + tiny mushroom sprouts on ~half the logs — batched into at most
  // 3 InstancedMesh draws total (was 1 individual mesh/group per patch)
  const mossBlobGeo = new THREE.IcosahedronGeometry(0.22, 0);
  { const p = mossBlobGeo.attributes.position;
    for(let i=0;i<p.count;i++) p.setY(i, Math.max(-0.06, p.getY(i)*0.55)); }
  const mossBlobMat = toonMat({ color:0x4a7a2e, rim:0.5, rimColor:0xc8ffb0 });
  const sproutStemMat = toonMat({ color:0xe8dcc0, rim:0.25 });
  const sproutCapMat = toonMat({ color:0xd97a4a, rim:0.4, rimColor:0xffcfa0 });
  const sproutStemGeo = new THREE.CylinderGeometry(0.03, 0.045, 0.16, 5);
  const sproutCapGeo = new THREE.SphereGeometry(0.09, 7, 5, 0, Math.PI*2, 0, Math.PI*0.6);
  const logBits = [];
  for(const ld of logData){
    const along = new THREE.Vector3(0,1,0).applyQuaternion(ld.q);
    const up = new THREE.Vector3(0,0,-1).applyQuaternion(ld.q); // top of the cylinder in world space
    const nBits = 2 + ((rng()*3)|0);
    for(let k=0;k<nBits;k++){
      const t = (rng()-0.5)*3.0*ld.s;
      const base = new THREE.Vector3(ld.x, ld.y, ld.z).addScaledVector(along, t).addScaledVector(up, 0.46*ld.s);
      logBits.push({ pos:base, scale:0.7+rng()*0.9, ry:rng()*7, isBlob: rng()<0.6 });
    }
  }
  const blobBits = logBits.filter(b=>b.isBlob);
  const sproutBits = logBits.filter(b=>!b.isBlob);
  if(blobBits.length){
    const mossBlobs = new THREE.InstancedMesh(mossBlobGeo, mossBlobMat, blobBits.length);
    blobBits.forEach((b,i)=>{
      Q.setFromEuler(new THREE.Euler(0,b.ry,0));
      M.compose(b.pos, Q, S.set(b.scale,b.scale,b.scale));
      mossBlobs.setMatrixAt(i, M);
    });
    scene.add(mossBlobs);
  }
  if(sproutBits.length){
    const sproutStems = new THREE.InstancedMesh(sproutStemGeo, sproutStemMat, sproutBits.length);
    const sproutCaps = new THREE.InstancedMesh(sproutCapGeo, sproutCapMat, sproutBits.length);
    const upY = new THREE.Vector3(0,1,0);
    sproutBits.forEach((b,i)=>{
      Q.setFromEuler(new THREE.Euler(0,b.ry,0));
      M.compose(V.copy(b.pos).addScaledVector(upY, 0.08*b.scale), Q, S.set(b.scale,b.scale,b.scale));
      sproutStems.setMatrixAt(i, M);
      M.compose(V.copy(b.pos).addScaledVector(upY, 0.16*b.scale), Q, S.set(b.scale,b.scale,b.scale));
      sproutCaps.setMatrixAt(i, M);
    });
    scene.add(sproutStems, sproutCaps);
  }

  /* ----- instanced grass with wind sway ----- */
  const bladeGeo = new THREE.PlaneGeometry(0.16, 1.1, 1, 3);
  bladeGeo.translate(0, 0.55, 0);
  { const p = bladeGeo.attributes.position; // taper to a point
    for(let i=0;i<p.count;i++){ const t = p.getY(i)/1.1; p.setX(i, p.getX(i)*(1-t*0.95)); } }
  const grassCount = Math.floor(22000*quality);
  const grassMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog:false,
    uniforms:{ uTime:{value:0}, uFog:{value:new THREE.Color(theme.fog)},
      uGB1:{value:new THREE.Vector3(...theme.grassBase.slice(0,3))},
      uGB2:{value:new THREE.Vector3(...theme.grassBase.slice(3,6))},
      uGT1:{value:new THREE.Vector3(...theme.grassTip.slice(0,3))},
      uGT2:{value:new THREE.Vector3(...theme.grassTip.slice(3,6))} },
    vertexShader:`
      uniform float uTime; varying float vY; varying float vFog; varying float vTint;
      void main(){
        vY = clamp(position.y / 1.1, 0.0, 1.0);
        vec4 wp = instanceMatrix * vec4(position,1.0);
        // traveling gust band: a wide diagonal wave that sweeps across the whole field,
        // stacked on top of the constant per-blade sway
        float gustFront = (wp.x*0.045 + wp.z*0.035) - uTime*0.9;
        float gust = smoothstep(0.3,1.0, sin(gustFront)) * (0.6+0.4*sin(uTime*0.13));
        float sway = sin(uTime*1.8 + wp.x*0.35 + wp.z*0.27) * 0.18 * vY * (1.0+gust*2.2);
        wp.x += sway; wp.z += sway*0.6;
        vTint = fract(sin(dot(wp.xz, vec2(12.9898,78.233))) * 43758.5453);
        vec4 mv = viewMatrix * modelMatrix * wp;
        vFog = smoothstep(70.0, 230.0, -mv.z);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader:`
      varying float vY; varying float vFog; varying float vTint; uniform vec3 uFog;
      uniform vec3 uGB1; uniform vec3 uGB2; uniform vec3 uGT1; uniform vec3 uGT2;
      void main(){
        vec3 base = mix(uGB1, uGB2, vTint);
        vec3 tip  = mix(uGT1, uGT2, vTint);
        vec3 col = mix(base, tip, vY*vY);
        col *= 0.85 + 0.3*vY; // fake AO at root
        col = mix(col, uFog, vFog*0.85);
        gl_FragColor = vec4(col,1.0);
      }`
  });
  const grass = new THREE.InstancedMesh(bladeGeo, grassMat, grassCount);
  grass.frustumCulled = false;
  for(let i=0;i<grassCount;i++){
    const a=rng()*Math.PI*2, r=4+Math.pow(rng(),0.8)*150;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    Q.setFromEuler(new THREE.Euler(0, rng()*7, (rng()-0.5)*0.3));
    const s=0.6+rng()*0.9;
    M.compose(V.set(x, groundHeight(x,z), z), Q, S.set(s,s,s));
    grass.setMatrixAt(i,M);
  }
  scene.add(grass);
  world.updaters.push((dt,t)=>{ grassMat.uniforms.uTime.value = t; });

  /* ----- flowers ----- */
  const flowerGeo = new THREE.ConeGeometry(0.16, 0.22, 6);
  const flowerMat = new THREE.MeshBasicMaterial({ color:0xffffff });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, 300);
  const fCols = [0xff7ab8, 0xffe066, 0xff9a5c, 0xc9a0ff, 0xffffff];
  for(let i=0;i<300;i++){
    const a=rng()*Math.PI*2, r=6+rng()*160;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    M.compose(V.set(x, groundHeight(x,z)+0.22, z), Q.identity(), S.set(1,1,1));
    flowers.setMatrixAt(i,M);
    flowers.setColorAt(i, new THREE.Color(fCols[(rng()*fCols.length)|0]));
  }
  scene.add(flowers);

  /* ----- decorative glowing mushrooms (harvestable — see world.harvestMushroom) ----- */
  const deco = [];
  const capMats = {};
  for(const sp of MUSHROOM_SPECIES) capMats[sp.id] = toonMat({ color: sp.color, emissive: sp.emissive, emissiveIntensity:0.85, rim:0.5 });
  const stemGeo = new THREE.CylinderGeometry(0.12,0.2,0.7,5);
  const capGeo = new THREE.SphereGeometry(0.4, 8, 6, 0, Math.PI*2, 0, Math.PI/2);
  const stemMat = toonMat({ color:0xf2e4c8, rim:0.2 });
  function placeMushroom(x, z, sp, sMin=0.6, sMax=2.2){
    const y = groundHeight(x,z);
    const g = new THREE.Group();
    const s = sMin+rng()*(sMax-sMin);
    const st = new THREE.Mesh(stemGeo, stemMat); st.position.y=0.35;
    const cp = new THREE.Mesh(capGeo, capMats[sp.id]); cp.position.y=0.65;
    g.add(st,cp); g.position.set(x,y,z); g.scale.setScalar(s);
    g.rotation.y = rng()*7;
    scene.add(g);
    const entry = { g, ph:rng()*7, species:sp.id, alive:true, respawnT:0, baseScale:s };
    deco.push(entry);
    return entry;
  }
  for(let i=0;i<90;i++){
    const a=rng()*Math.PI*2, r=8+rng()*170;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
    placeMushroom(x, z, sp);
  }
  // Fungal Warren pocket: one species dominates a concentrated patch — an emergent "go
  // here for this contract" spot, on top of the baseline global scatter above.
  if(POCKETS.fungalWarren){
    const fw = POCKETS.fungalWarren;
    const dom = SPECIES_BY_ID[fw.species];
    const extra = 24 + ((rng()*14)|0);
    for(let i=0;i<extra;i++){
      const a=rng()*Math.PI*2, r=rng()*fw.r;
      const x=fw.x+Math.cos(a)*r, z=fw.z+Math.sin(a)*r;
      const sp = rng() < 0.7 ? dom : MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
      placeMushroom(x, z, sp);
    }
  }
  world.updaters.push((dt,t)=>{
    for(const d of deco){
      if(d.alive) d.g.scale.y = d.g.scale.x * (1 + Math.sin(t*2+d.ph)*0.06);
      else if((d.respawnT -= dt) <= 0){ d.alive = true; d.g.visible = true; }
    }
  });

  /* ----- LANDMARK: cave mouths — dark alcoves in the rock walls built earlier ----- */
  if(world.caveSpots && world.caveSpots.length){
    const voidMat = new THREE.MeshBasicMaterial({ color:0x0a0810, side:THREE.BackSide, fog:false });
    for(const spot of world.caveSpots){
      const { cx, cz, cy, mouthDir } = spot;
      const mouthX = Math.cos(mouthDir), mouthZ = Math.sin(mouthDir);
      // dark cavity, recessed behind the entrance so it never coincides with the wall rocks' surfaces
      const cavity = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 8), voidMat);
      cavity.scale.set(1, 0.7, 0.85);
      cavity.position.set(cx - mouthX*1.6, cy+1.7, cz - mouthZ*1.6);
      scene.add(cavity);
      // hanging stalactites over the mouth
      for(let k=0;k<4;k++){
        const along = (k-1.5)*0.7;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.25+rng()*0.15, 0.9+rng()*0.6, 6), rockMat);
        spike.rotation.x = Math.PI;
        spike.position.set(cx - mouthX*0.8 + mouthZ*along, cy+3.2+rng()*0.4, cz - mouthZ*0.8 - mouthX*along);
        scene.add(spike);
      }
      // warm light spilling from inside, out through the mouth
      const pl = new THREE.PointLight(0xffa855, 7, 13);
      pl.position.set(cx - mouthX*1.1, cy+1.6, cz - mouthZ*1.1);
      scene.add(pl);
      // a few glowing mushrooms just inside for atmosphere — reuses the deco system above (same
      // geometry/materials, same shared pulse updater, zero new draw-call types)
      for(let k=0;k<4;k++){
        const a = mouthDir + Math.PI + (rng()-0.5)*1.8, r = 0.8+rng()*1.8;
        const gx = cx+Math.cos(a)*r, gz = cz+Math.sin(a)*r;
        const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
        placeMushroom(gx, gz, sp, 0.5, 1.0);
      }
    }
  }

  /* ----- LANDMARK: withered hollow — a patch of visibly corrupted growth that isn't tied
     to distance-from-spawn, so early exploration can still stumble into somewhere unsettling ----- */
  if(POCKETS.witheredHollow){
    const wh = POCKETS.witheredHollow;
    const witherMat = toonMat({ color:0x2a1a30, emissive:0x140a1c, emissiveIntensity:0.5, rim:0.3, rimColor:0x8a5ac8 });
    const spikeCount = 4 + ((rng()*4)|0);
    for(let i=0;i<spikeCount;i++){
      const a = rng()*Math.PI*2, r = rng()*wh.r*0.7;
      const sx = wh.x+Math.cos(a)*r, sz = wh.z+Math.sin(a)*r, sy = groundHeight(sx,sz);
      const h = 2+rng()*2.5;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.3+rng()*0.35, h, 6), witherMat);
      spike.position.set(sx, sy+h*0.5, sz);
      spike.rotation.set((rng()-0.5)*0.3, rng()*7, (rng()-0.5)*0.3);
      addOutline(spike, 0.03);
      scene.add(spike);
    }
    const whY = groundHeight(wh.x, wh.z);
    const pl4 = new THREE.PointLight(0x8a5ac8, 6, 16);
    pl4.position.set(wh.x, whY+3, wh.z);
    scene.add(pl4);
  }

  // exposed for main.js: proximity checks read world.harvestables directly,
  // harvesting goes through world.harvestMushroom so respawn timing stays owned by world.js
  world.harvestables = deco;
  world.harvestMushroom = (entry)=>{
    if(!entry || !entry.alive) return false;
    entry.alive = false;
    entry.g.visible = false;
    entry.respawnT = 45 + Math.random()*35;
    return true;
  };

  /* ----- crystal formations (faceted glowing clusters) -----
     batched: 2 shard shapes x 2 colors = at most 4 InstancedMesh draws total
     for every shard on the map (was up to ~90 individual mesh+outline draws) */
  function makeCrystalShardGeo(seed){
    const geo = new THREE.OctahedronGeometry(0.5, 1); // subdivided so facet jitter reads as cut gem faces
    const p = geo.attributes.position;
    for(let i=0;i<p.count;i++){
      const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
      const j = 1 + noise2(x*2.6+seed, z*2.6-seed)*0.22;
      p.setXYZ(i, x*j, y*(2.3+noise2(y*1.5+seed, x*1.5)*0.5), z*j);
    }
    geo.computeVertexNormals();
    return geo;
  }
  const crystalPalette = [
    { color:0x4dc8ff, emissive:0x1a5a8f, rgb:[0.3,0.78,1] },
    { color:0xc77dff, emissive:0x5a1a8f, rgb:[0.78,0.49,1] },
  ];
  const crystalMats = crystalPalette.map(pal=>
    toonMat({ color:pal.color, emissive:pal.emissive, emissiveIntensity:0.9, rim:0.65, rimColor:pal.color }));
  const shardGeoVariants = [makeCrystalShardGeo(1.3), makeCrystalShardGeo(9.7)];
  const clusterCount = 8;
  const crystalClusters = []; // {cx,cy,cz,pal,ph} — drives the core sprites + mote system below
  const shardPlacements = [[],[],[],[]]; // bucketed by variant*2 + colorIdx
  for(let ci=0; ci<clusterCount; ci++){
    const a=rng()*Math.PI*2, r=12+rng()*168;
    const cx=Math.cos(a)*r, cz=Math.sin(a)*r, cy=groundHeight(cx,cz);
    const colorIdx = ci%2;
    crystalClusters.push({ cx, cy: cy+0.5, cz, pal:crystalPalette[colorIdx], ph: rng()*7 });
    const shardCount = 3 + ((rng()*2)|0);
    for(let k=0;k<shardCount;k++){
      const variant = (rng()*2)|0;
      const s = 0.28 + rng()*0.42;
      shardPlacements[variant*2+colorIdx].push({
        x:cx+(rng()-0.5)*0.5, y:cy+s*(0.9+rng()*0.3), z:cz+(rng()-0.5)*0.5,
        sx:s, sy:s*(0.8+rng()*0.7), sz:s, rx:(rng()-0.5)*0.6, ry:rng()*7, rz:(rng()-0.5)*0.6,
      });
    }
  }
  // Crystal Hollow pocket: extra clusters concentrated in one region instead of scattered
  // uniformly, so a lucky world has a real "crystal cave" set-piece to remember. reuses the
  // exact same crystalClusters/shardPlacements arrays, so cores/motes/draw-calls below pick
  // these up automatically — zero additional draw calls no matter how many worlds get one.
  if(POCKETS.crystalHollow){
    const ch = POCKETS.crystalHollow;
    const extraClusters = 5 + ((rng()*3)|0);
    for(let ci=0; ci<extraClusters; ci++){
      const a=rng()*Math.PI*2, r=rng()*ch.r;
      const cx=ch.x+Math.cos(a)*r, cz=ch.z+Math.sin(a)*r, cy=groundHeight(cx,cz);
      const colorIdx = (rng()*2)|0;
      crystalClusters.push({ cx, cy: cy+0.5, cz, pal:crystalPalette[colorIdx], ph: rng()*7 });
      const shardCount = 3 + ((rng()*3)|0); // slightly denser than ambient clusters
      for(let k=0;k<shardCount;k++){
        const variant = (rng()*2)|0;
        const s = 0.3 + rng()*0.5;
        shardPlacements[variant*2+colorIdx].push({
          x:cx+(rng()-0.5)*0.5, y:cy+s*(0.9+rng()*0.3), z:cz+(rng()-0.5)*0.5,
          sx:s, sy:s*(0.8+rng()*0.7), sz:s, rx:(rng()-0.5)*0.6, ry:rng()*7, rz:(rng()-0.5)*0.6,
        });
      }
    }
  }
  for(let variant=0; variant<2; variant++){
    for(let colorIdx=0; colorIdx<2; colorIdx++){
      const placements = shardPlacements[variant*2+colorIdx];
      if(!placements.length) continue;
      const mesh = new THREE.InstancedMesh(shardGeoVariants[variant], crystalMats[colorIdx], placements.length);
      placements.forEach((p,i)=>{
        Q.setFromEuler(new THREE.Euler(p.rx,p.ry,p.rz));
        M.compose(V.set(p.x,p.y,p.z), Q, S.set(p.sx,p.sy,p.sz));
        mesh.setMatrixAt(i, M);
      });
      scene.add(mesh);
    }
  }
  // inner glow cores — one lightweight sprite per cluster (sprites are cheap: always-billboarded, no outline)
  const clusterCores = crystalClusters.map(c=>{
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ color:c.pal.color, transparent:true, opacity:0.5,
      blending:THREE.AdditiveBlending, depthWrite:false }));
    core.scale.setScalar(0.9); core.position.set(c.cx, c.cy-0.1, c.cz);
    scene.add(core);
    return core;
  });
  world.updaters.push((dt,t)=>{
    for(let i=0;i<clusterCores.length;i++){
      const c = crystalClusters[i], core = clusterCores[i];
      const pulse = 0.4 + Math.sin(t*1.6+c.ph)*0.15;
      core.material.opacity = pulse;
      core.scale.setScalar(0.7+pulse*0.6);
    }
  });
  // orbiting spore motes shared across every cluster (one draw call)
  const moteCount = crystalClusters.length * 5;
  const moteGeo = new THREE.BufferGeometry();
  const motePos = new Float32Array(moteCount*3), moteSeed = new Float32Array(moteCount), moteCol = new Float32Array(moteCount*3);
  { let mi=0;
    for(const c of crystalClusters){
      for(let k=0;k<5;k++){
        motePos[mi*3]=c.cx; motePos[mi*3+1]=c.cy; motePos[mi*3+2]=c.cz;
        moteSeed[mi]=rng()*100;
        moteCol[mi*3]=c.pal.rgb[0]; moteCol[mi*3+1]=c.pal.rgb[1]; moteCol[mi*3+2]=c.pal.rgb[2];
        mi++;
      }
    } }
  moteGeo.setAttribute('position', new THREE.BufferAttribute(motePos,3));
  moteGeo.setAttribute('aSeed', new THREE.BufferAttribute(moteSeed,1));
  moteGeo.setAttribute('aColor', new THREE.BufferAttribute(moteCol,3));
  const moteMat = new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    uniforms:{ uTime:{value:0} },
    vertexShader:`uniform float uTime; attribute float aSeed; attribute vec3 aColor; varying vec3 vCol; varying float vA;
      void main(){
        vec3 p = position;
        float orb = uTime*0.6+aSeed;
        p.x += cos(orb)*(0.5+0.3*sin(aSeed)); p.z += sin(orb)*(0.5+0.3*cos(aSeed));
        p.y += 0.3+sin(uTime*1.1+aSeed*2.0)*0.3;
        vCol = aColor; vA = 0.5+0.5*sin(uTime*2.0+aSeed*3.0);
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = 60.0/-mv.z; gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader:`varying vec3 vCol; varying float vA;
      void main(){ float r=length(gl_PointCoord-0.5);
        float a=smoothstep(0.5,0.05,r)*vA;
        gl_FragColor=vec4(vCol,a); if(a<0.02) discard; }`
  });
  const crystalMotes = new THREE.Points(moteGeo, moteMat);
  crystalMotes.frustumCulled = false;
  scene.add(crystalMotes);
  world.updaters.push((dt,t)=>{ moteMat.uniforms.uTime.value = t; });

  /* ----- god-ray shafts in groves ----- */
  const rayTex = makeRayTexture();
  const rayMat = new THREE.MeshBasicMaterial({ map:rayTex, transparent:true, opacity:0.35,
    blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false });
  for(let i=0;i<8;i++){
    const [tx,ty,tz] = treePos[(rng()*treePos.length)|0] || [30,0,30];
    const geo = new THREE.PlaneGeometry(6, 30);
    const ray = new THREE.Mesh(geo, rayMat);
    ray.position.set(tx+3, ty+14, tz+2);
    ray.rotation.z = 0.35; ray.rotation.y = rng()*3;
    scene.add(ray);
  }

  /* ----- fireflies / ambient spores ----- */
  const fCount = 240;
  const fGeo = new THREE.BufferGeometry();
  const fPos = new Float32Array(fCount*3);
  const fSeed = new Float32Array(fCount);
  for(let i=0;i<fCount;i++){
    const a=rng()*Math.PI*2, r=rng()*180;
    fPos[i*3]=Math.cos(a)*r; fPos[i*3+1]=2+rng()*14; fPos[i*3+2]=Math.sin(a)*r;
    fSeed[i]=rng()*100;
  }
  fGeo.setAttribute('position', new THREE.BufferAttribute(fPos,3));
  fGeo.setAttribute('aSeed', new THREE.BufferAttribute(fSeed,1));
  const fMat = new THREE.ShaderMaterial({
    transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
    uniforms:{ uTime:{value:0} },
    vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
      void main(){
        vec3 p = position;
        p.x += sin(uTime*0.5+aSeed)*2.5; p.y += sin(uTime*0.8+aSeed*2.0)*1.5; p.z += cos(uTime*0.4+aSeed)*2.5;
        vA = 0.4+0.6*abs(sin(uTime*1.4+aSeed*3.0));
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = 90.0/-mv.z; gl_Position = projectionMatrix*mv;
      }`,
    fragmentShader:`varying float vA;
      void main(){ float r=length(gl_PointCoord-0.5);
        float a=smoothstep(0.5,0.05,r)*vA;
        gl_FragColor=vec4(1.0,0.85,0.45,a); if(a<0.02) discard; }`
  });
  const fireflies = new THREE.Points(fGeo, fMat);
  fireflies.frustumCulled = false;
  scene.add(fireflies);
  world.updaters.push((dt,t)=>{ fMat.uniforms.uTime.value = t; });

  /* ----- ground pollen (dense, slow, low-altitude drift distinct from the fireflies) ----- */
  {
    const pCount = 200;
    const pGeo = new THREE.BufferGeometry();
    const pPos = new Float32Array(pCount*3), pSeed = new Float32Array(pCount);
    for(let i=0;i<pCount;i++){
      const a=rng()*Math.PI*2, r=rng()*140;
      pPos[i*3]=Math.cos(a)*r; pPos[i*3+1]=0.3+rng()*2.2; pPos[i*3+2]=Math.sin(a)*r;
      pSeed[i]=rng()*100;
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(pPos,3));
    pGeo.setAttribute('aSeed', new THREE.BufferAttribute(pSeed,1));
    const pMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          p.x += sin(uTime*0.12+aSeed)*4.0; p.z += cos(uTime*0.1+aSeed*1.3)*4.0;
          p.y += sin(uTime*0.4+aSeed*2.0)*0.4;
          vA = 0.25+0.25*sin(uTime*0.8+aSeed*4.0);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 26.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`varying float vA;
        void main(){ float r=length(gl_PointCoord-0.5);
          float a=smoothstep(0.5,0.1,r)*vA;
          gl_FragColor=vec4(1.0,0.96,0.82,a); if(a<0.015) discard; }`
    });
    const pollen = new THREE.Points(pGeo, pMat);
    pollen.frustumCulled = false;
    scene.add(pollen);
    world.updaters.push((dt,t)=>{ pMat.uniforms.uTime.value = t; });
  }

  /* ----- drifting petals (near flowers, gentle falling flutter) ----- */
  {
    const petShape = new THREE.Shape();
    petShape.moveTo(0,0); petShape.quadraticCurveTo(0.08,0.06,0.05,0.16); petShape.quadraticCurveTo(0.02,0.2,-0.03,0.14); petShape.quadraticCurveTo(-0.06,0.05,0,0);
    const petGeo = new THREE.ShapeGeometry(petShape);
    const petCols = [0xff9adf, 0xffe066, 0xffffff, 0xc9a0ff];
    const petMats = petCols.map(color => new THREE.MeshBasicMaterial({ color, side:THREE.DoubleSide,
      transparent:true, opacity:0.85, fog:false })); // 4 shared materials, not one per petal
    const petCount = 24;
    const petals = [];
    for(let i=0;i<petCount;i++){
      const mat = petMats[i%petMats.length];
      const m = new THREE.Mesh(petGeo, mat);
      const a=rng()*Math.PI*2, r=rng()*130;
      m.userData = { x:Math.cos(a)*r, z:Math.sin(a)*r, y0:4+rng()*10, ph:rng()*7, spd:0.3+rng()*0.3, spin:(rng()-0.5)*2 };
      scene.add(m); petals.push(m);
    }
    world.updaters.push((dt,t)=>{
      for(const m of petals){
        const u = m.userData;
        const fall = ((t*u.spd+u.ph*3) % 6.0);
        m.position.set(u.x+Math.sin(t*0.4+u.ph)*2.2, u.y0-fall*u.y0/6.0, u.z+Math.cos(t*0.35+u.ph)*2.2);
        m.rotation.set(t*u.spin*0.3, t*u.spin, t*u.spin*0.5);
      }
    });
  }

  /* ----- LANDMARK: ancient mother-mushroom tower (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('tower')){
    const lm = new THREE.Group();
    // seeded: always a far, visible landmark (130–175 from spawn)
    const la = rng()*Math.PI*2, ld = 130 + rng()*45;
    const lx = Math.cos(la)*ld, lz = Math.sin(la)*ld, ly = groundHeight(lx, lz);
    const stemMat2 = toonMat({ color:0xe8d8b8, map:paintTexture('#e8d8b8',[{c:'#c9b58f',n:14,r:8,a:0.4}],{dabs:300}), rim:0.4 });
    const capMat2 = toonMat({ color:0x3fa8cc, map:paintTexture('#3fa8cc',[{c:'#bfefff',n:16,r:12,a:0.9},{c:'#bfefff',n:8,r:6,a:0.8}],{dabs:260}),
      emissive:0x1a5a77, emissiveIntensity:0.7, rim:0.7, rimColor:0xbfefff });
    const stem2 = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 8, 42, 10), stemMat2);
    { const p = stem2.geometry.attributes.position;
      for(let i=0;i<p.count;i++){ const y=p.getY(i); p.setX(i, p.getX(i)+Math.sin(y*0.08)*4); } }
    stem2.position.y = 21; addOutline(stem2, 0.02);
    const cap2 = new THREE.Mesh(new THREE.SphereGeometry(17, 18, 12, 0, Math.PI*2, 0, Math.PI*0.52), capMat2);
    cap2.position.y = 42; cap2.scale.set(1.25, 0.85, 1.25); addOutline(cap2, 0.015);
    const halo2 = new THREE.Mesh(new THREE.SphereGeometry(24, 16, 12),
      new THREE.MeshBasicMaterial({ color:0x66d8ff, transparent:true, opacity:0.12, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide }));
    halo2.position.y = 44;
    const pl = new THREE.PointLight(0x66d8ff, 60, 90); pl.position.y = 40;
    lm.add(stem2, cap2, halo2, pl);
    lm.position.set(lx, ly, lz);
    scene.add(lm);
    world.motherShroom = lm;
    world.updaters.push((dt,t)=>{ halo2.material.opacity = 0.10+Math.sin(t*1.2)*0.04; });
  }

  /* ----- LANDMARK: standing stones (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('stones')){
    const sa = rng()*Math.PI*2, sd = 85 + rng()*55;
    const sx = Math.cos(sa)*sd, sz = Math.sin(sa)*sd, sy = groundHeight(sx, sz);
    const stoneMat = toonMat({ color:0x8d86a0, map:paintTexture('#8d86a0',[{c:'#6d6580',n:10,r:10,a:0.5}],{dabs:200}), rim:0.4 });
    const runeMat = new THREE.MeshBasicMaterial({ color:0x7de8ff, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false });
    for(let i=0;i<7;i++){
      const a = (i/7)*Math.PI*2;
      const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, 7+rng()*3, 1.4), stoneMat);
      st.position.set(sx+Math.cos(a)*10, sy+3, sz+Math.sin(a)*10);
      st.rotation.set((rng()-0.5)*0.15, a, (rng()-0.5)*0.15);
      addOutline(st, 0.04);
      const rune = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3), runeMat);
      rune.position.set(st.position.x*1.001, sy+3.5, st.position.z*1.001);
      rune.lookAt(sx, sy+3.5, sz); rune.rotateY(Math.PI);
      scene.add(st, rune);
    }
    const pl2 = new THREE.PointLight(0x7de8ff, 20, 30); pl2.position.set(sx, sy+4, sz);
    scene.add(pl2);
  }

  /* ----- LANDMARK: spore geysers (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('geysers')){
    world.geysers = [];
    // seeded: 4 geysers spread around the ring, kept out of the spawn clearing
    const gSpots = [];
    for(let i=0;i<4;i++){
      const a = i*(Math.PI/2) + rng()*1.1;
      const d = 45 + rng()*115;
      gSpots.push([Math.cos(a)*d, Math.sin(a)*d]);
    }
    for(const [gx, gz] of gSpots){
      const gy = groundHeight(gx, gz);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, 26, 8, 1, true),
        new THREE.MeshBasicMaterial({ color:0xaef2c8, transparent:true, opacity:0.10, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false }));
      col.position.set(gx, gy+13, gz);
      scene.add(col);
      // rising spore points
      const N = 26;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N*3); const seed = new Float32Array(N);
      for(let i=0;i<N;i++){ seed[i]=rng(); pos[i*3]=gx; pos[i*3+1]=gy; pos[i*3+2]=gz; }
      geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
      const mat = new THREE.PointsMaterial({ color:0xc8ffd8, size:1.6, transparent:true, opacity:0.8,
        blending:THREE.AdditiveBlending, depthWrite:false, sizeAttenuation:true });
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
      scene.add(pts);
      world.geysers.push({gx, gy, gz, geo, seed, N});
    }
    world.updaters.push((dt,t)=>{
      for(const g of world.geysers){
        const pos = g.geo.attributes.position.array;
        for(let i=0;i<g.N;i++){
          const ph = (t*0.25 + g.seed[i]) % 1;
          pos[i*3]   = g.gx + Math.sin(ph*12+g.seed[i]*9)*(1+ph*3);
          pos[i*3+1] = g.gy + ph*26;
          pos[i*3+2] = g.gz + Math.cos(ph*10+g.seed[i]*7)*(1+ph*3);
        }
        g.geo.attributes.position.needsUpdate = true;
      }
    });
  }

  /* ----- LANDMARK: watering hole (animated water + waterfall; not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('pond')){
    const wa = rng()*Math.PI*2, wd = 55 + rng()*90;
    const wx = Math.cos(wa)*wd, wz = Math.sin(wa)*wd, wy = groundHeight(wx, wz);
    world.pondPos = { x:wx, y:wy, z:wz };
    const waterDeep = new THREE.Color(0x0f4a5f), waterShallow = new THREE.Color(0x6fd8e8), waterFoam = new THREE.Color(0xeafffc);
    function makeWaterMat(){
      return new THREE.ShaderMaterial({
        transparent:true, side:THREE.DoubleSide, fog:false,
        uniforms:{ uTime:{value:0}, uDeep:{value:waterDeep}, uShallow:{value:waterShallow}, uFoam:{value:waterFoam}, uCircle:{value:0} },
        vertexShader:`uniform float uTime; varying vec2 vUv; varying float vWave;
          void main(){
            vUv = uv;
            vec3 pos = position;
            float d = length(pos.xy);
            float w = sin(d*1.5 - uTime*1.7)*0.07 + sin(pos.x*0.7+pos.y*0.5+uTime*1.1)*0.045;
            pos.z += w;
            vWave = w;
            vec4 mv = modelViewMatrix*vec4(pos,1.0);
            gl_Position = projectionMatrix*mv;
          }`,
        fragmentShader:`varying vec2 vUv; varying float vWave;
          uniform vec3 uDeep; uniform vec3 uShallow; uniform vec3 uFoam; uniform float uTime; uniform float uCircle;
          void main(){
            float d = length(vUv-0.5)*2.0;
            if(uCircle > 0.5 && d > 1.0) discard;
            vec3 col = mix(uShallow, uDeep, smoothstep(0.05,0.95,d));
            float sparkle = pow(max(0.0, sin(vUv.x*46.0+uTime*2.2)*sin(vUv.y*46.0-uTime*1.8)), 10.0);
            col = mix(col, uFoam, sparkle*0.65 + max(0.0,vWave)*0.5);
            float alpha = mix(0.6, 0.88, d);
            gl_FragColor = vec4(col, alpha);
          }`
      });
    }
    const pondMat = makeWaterMat();
    pondMat.uniforms.uCircle = { value: 1 };
    const pond = new THREE.Mesh(new THREE.PlaneGeometry(18, 18, 40, 40), pondMat);
    pond.rotation.x = -Math.PI/2; pond.position.set(wx, wy+0.1, wz);
    scene.add(pond);
    // lily pads + reeds around the rim
    const padMat = toonMat({ color:0x3f8a3a, rim:0.4, rimColor:0xc8ffb0 });
    const padGeo = new THREE.CircleGeometry(0.6, 10);
    const reedMat = toonMat({ color:0x5fa848, rim:0.3 });
    const reedGeo = new THREE.CylinderGeometry(0.05, 0.08, 1.4, 5);
    for(let i=0;i<9;i++){
      const a = rng()*Math.PI*2, r = 3+rng()*5.5;
      const px = wx+Math.cos(a)*r, pz = wz+Math.sin(a)*r;
      if(rng() < 0.5){
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.rotation.x = -Math.PI/2; pad.rotation.z = rng()*7;
        pad.position.set(px, wy+0.16, pz);
        scene.add(pad);
      } else {
        const reed = new THREE.Mesh(reedGeo, reedMat);
        reed.position.set(wx+Math.cos(a)*9.4, wy+0.7, wz+Math.sin(a)*9.4);
        reed.rotation.z = (rng()-0.5)*0.2;
        scene.add(reed);
      }
    }
    // little waterfall feeding the pool from a rock ledge
    const fallAngle = rng()*Math.PI*2;
    const ledgeX = wx+Math.cos(fallAngle)*9.5, ledgeZ = wz+Math.sin(fallAngle)*9.5;
    const ledgeH = 6 + rng()*3;
    const ledge = new THREE.Mesh(rockGeo, rockMat.clone());
    ledge.scale.set(3.4, ledgeH*0.5, 2.6);
    ledge.position.set(ledgeX, wy+ledgeH*0.5, ledgeZ);
    ledge.lookAt(wx, wy, wz);
    addOutline(ledge, 0.03);
    scene.add(ledge);
    const fallMat = makeWaterMat();
    fallMat.uniforms.uShallow.value = waterFoam;
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(2.2, ledgeH, 6, 14), fallMat);
    fall.position.set(ledgeX + (wx-ledgeX)*0.06, wy+ledgeH*0.5, ledgeZ + (wz-ledgeZ)*0.06);
    fall.lookAt(wx, fall.position.y, wz);
    scene.add(fall);
    // mist at the base of the falls
    const mistN = 22;
    const mistGeo = new THREE.BufferGeometry();
    const mistPos = new Float32Array(mistN*3), mistSeed = new Float32Array(mistN);
    for(let i=0;i<mistN;i++){ mistPos[i*3]=ledgeX; mistPos[i*3+1]=wy+0.4; mistPos[i*3+2]=ledgeZ; mistSeed[i]=rng()*100; }
    mistGeo.setAttribute('position', new THREE.BufferAttribute(mistPos,3));
    mistGeo.setAttribute('aSeed', new THREE.BufferAttribute(mistSeed,1));
    const mistMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          float ph = fract(uTime*0.3+aSeed);
          p.x += sin(aSeed*7.0)*1.4*ph; p.z += cos(aSeed*5.0)*1.4*ph; p.y += ph*2.2;
          vA = (1.0-ph)*0.5;
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 130.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`varying float vA; void main(){ float r=length(gl_PointCoord-0.5);
        float a=smoothstep(0.5,0.1,r)*vA; gl_FragColor=vec4(0.85,0.97,1.0,a); if(a<0.02) discard; }`
    });
    const mist = new THREE.Points(mistGeo, mistMat); mist.frustumCulled = false;
    scene.add(mist);
    world.updaters.push((dt,t)=>{
      pondMat.uniforms.uTime.value = t;
      fallMat.uniforms.uTime.value = t*2.2;
      mistMat.uniforms.uTime.value = t;
    });
  }

  /* ----- birds ----- */
  {
    const birdMat = new THREE.MeshBasicMaterial({ color:0x2c2233, side:THREE.DoubleSide, fog:false });
    const birds = [];
    for(let i=0;i<6;i++){
      const b = new THREE.Group();
      const w1 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), birdMat);
      const w2 = w1.clone();
      w1.position.x = -1.1; w2.position.x = 1.1;
      b.add(w1, w2);
      b.userData = { a: rng()*7, r: 90+rng()*120, h: 55+rng()*40, sp: 0.05+rng()*0.06, w1, w2 };
      scene.add(b); birds.push(b);
    }
    world.updaters.push((dt,t)=>{
      for(const b of birds){
        const u = b.userData; u.a += dt*u.sp;
        b.position.set(Math.cos(u.a)*u.r, u.h + Math.sin(t+u.a*3)*3, Math.sin(u.a)*u.r);
        b.rotation.y = -u.a;
        const flap = Math.sin(t*7+u.a*10)*0.7;
        u.w1.rotation.z = flap; u.w2.rotation.z = -flap;
      }
    });
  }

  /* ----- butterflies (low-altitude flutter near flowers) ----- */
  {
    function makeWingShape(){
      const s = new THREE.Shape();
      s.moveTo(0,0);
      s.quadraticCurveTo(0.05,0.16, 0.24,0.22);
      s.quadraticCurveTo(0.34,0.24, 0.30,0.10);
      s.quadraticCurveTo(0.28,-0.02, 0.14,-0.06);
      s.quadraticCurveTo(0.04,-0.06, 0,0);
      return s;
    }
    const wingGeo = new THREE.ShapeGeometry(makeWingShape(), 8);
    wingGeo.computeBoundingBox();
    { const uv = wingGeo.attributes.uv, pos = wingGeo.attributes.position;
      const bb = wingGeo.boundingBox;
      for(let i=0;i<uv.count;i++){
        uv.setXY(i, (pos.getX(i)-bb.min.x)/(bb.max.x-bb.min.x), (pos.getY(i)-bb.min.y)/(bb.max.y-bb.min.y));
      } }
    function makeWingTexture(hex){
      const c = document.createElement('canvas'); c.width=c.height=64;
      const g = c.getContext('2d');
      const base = new THREE.Color(hex);
      const gr = g.createRadialGradient(14,50,2,44,10,60);
      gr.addColorStop(0, '#'+base.clone().offsetHSL(0,0,0.22).getHexString());
      gr.addColorStop(0.6, '#'+base.getHexString());
      gr.addColorStop(1, '#'+base.clone().offsetHSL(0,0,-0.18).getHexString());
      g.fillStyle = gr; g.fillRect(0,0,64,64);
      g.strokeStyle = 'rgba(30,20,15,0.35)'; g.lineWidth = 1.4;
      g.beginPath(); g.moveTo(6,58); g.quadraticCurveTo(30,40,50,8); g.stroke();
      const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
    }
    const wingCols = [0xff7ab8, 0xffe066, 0xc9a0ff, 0x9be26e, 0xff9a5c];
    const wingMats = wingCols.map(hex => new THREE.MeshBasicMaterial({ map:makeWingTexture(hex),
      side:THREE.DoubleSide, fog:false, transparent:true, opacity:0.95 })); // 5 shared materials, not one per butterfly
    const bodyMat = toonMat({ color:0x2c2233, rim:0.3 });
    const bodyGeo = new THREE.CapsuleGeometry(0.02, 0.14, 3, 5);
    const flies = [];
    for(let i=0;i<8;i++){
      const wingMat = wingMats[i%wingMats.length];
      const b = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bodyMat); body.rotation.x = Math.PI/2; b.add(body);
      const wPivotL = new THREE.Group(), wPivotR = new THREE.Group();
      const w1 = new THREE.Mesh(wingGeo, wingMat);
      const w2 = new THREE.Mesh(wingGeo, wingMat); w2.scale.x = -1;
      wPivotL.add(w1); wPivotR.add(w2);
      b.add(wPivotL, wPivotR);
      const a0=rng()*Math.PI*2, r=6+rng()*150;
      b.userData = { cx:Math.cos(a0)*r, cz:Math.sin(a0)*r, ph:rng()*7, spd:0.5+rng()*0.5, rad:1.5+rng()*2.5, h:1.2+rng()*1.6, wPivotL, wPivotR };
      scene.add(b); flies.push(b);
    }
    world.updaters.push((dt,t)=>{
      for(const b of flies){
        const u = b.userData;
        const a = t*u.spd + u.ph;
        const x = u.cx + Math.cos(a)*u.rad + Math.sin(a*2.3)*0.6;
        const z = u.cz + Math.sin(a*1.3)*u.rad;
        b.position.set(x, groundHeight(x,z)+u.h+Math.sin(t*3+u.ph)*0.3, z);
        b.rotation.y = -a + Math.PI/2;
        b.rotation.z = Math.sin(t*2+u.ph)*0.2;
        const flap = Math.abs(Math.sin(t*16+u.ph*5))*1.3;
        u.wPivotL.rotation.y = flap; u.wPivotR.rotation.y = -flap;
      }
    });
  }

  /* ----- ambient critters: frogs at the pond, rabbits in the meadow ----- */
  {
    // frogs — small hopping bodies with bulging eyes, ringed around the watering hole
    if(world.pondPos){
      const frogMat = toonMat({ color:0x5fa848, rim:0.4, rimColor:0xe8ffb0 });
      const eyeMat = new THREE.MeshBasicMaterial({ color:0x1c1410 });
      const bodyGeo = new THREE.SphereGeometry(0.22, 8, 6);
      const eyeGeo = new THREE.SphereGeometry(0.06, 6, 5); // dark all the way through — no separate pupil mesh
      const frogs = [];
      for(let i=0;i<3;i++){
        const g = new THREE.Group();
        const body = new THREE.Mesh(bodyGeo, frogMat); body.scale.set(1,0.7,1.2); addOutline(body,0.08);
        g.add(body);
        for(const s of [-1,1]){
          const eye = new THREE.Mesh(eyeGeo, eyeMat);
          eye.position.set(0.09*s, 0.15, 0.14); g.add(eye);
        }
        const a = rng()*Math.PI*2, r = 3+rng()*5;
        const px = world.pondPos.x+Math.cos(a)*r, pz = world.pondPos.z+Math.sin(a)*r;
        g.position.set(px, groundHeight(px,pz)+0.15, pz);
        g.userData = { baseX:px, baseZ:pz, ph:rng()*7, dir:rng()*Math.PI*2 };
        scene.add(g); frogs.push(g);
      }
      world.updaters.push((dt,t)=>{
        for(const f of frogs){
          const u = f.userData;
          const hopCycle = (t*0.7+u.ph) % 3.0;
          const hop = hopCycle < 1.0 ? Math.sin(hopCycle*Math.PI) : 0;
          if(hopCycle < 1.0){
            const px = u.baseX + Math.cos(u.dir)*hopCycle*0.6, pz = u.baseZ + Math.sin(u.dir)*hopCycle*0.6;
            f.position.x = px; f.position.z = pz;
            f.position.y = groundHeight(px,pz)+0.15+hop*0.35;
            f.rotation.y = u.dir;
          } else if(hopCycle > 2.7){ u.dir = u.ph*1.7 + t; u.baseX=f.position.x; u.baseZ=f.position.z; }
          f.scale.set(1+hop*0.1, 1-hop*0.15, 1+hop*0.1);
        }
      });
    }
    // rabbits — tall-eared hoppers scattered through the meadow near spawn
    const rabbitMat = toonMat({ color:0xe8d8c0, rim:0.4, rimColor:0xffffff });
    // one stretched blob for body+head (was a separate head sphere — not worth its own draw call at this scale)
    const rabBodyGeo = new THREE.SphereGeometry(0.17, 8, 6);
    { const p = rabBodyGeo.attributes.position;
      for(let i=0;i<p.count;i++){ const z=p.getZ(i); if(z>0) p.setY(i, p.getY(i)+z*0.5); } } // nose end tapers up
    const rabEarGeo = new THREE.ConeGeometry(0.03, 0.22, 5);
    const rabbits = [];
    for(let i=0;i<4;i++){
      const g = new THREE.Group();
      const body = new THREE.Mesh(rabBodyGeo, rabbitMat); body.scale.set(1,0.9,1.5); addOutline(body,0.08);
      g.add(body);
      for(const s of [-1,1]){
        const ear = new THREE.Mesh(rabEarGeo, rabbitMat);
        ear.position.set(0.05*s, 0.24, 0.14); ear.rotation.x = -0.2; ear.rotation.z = 0.15*s;
        g.add(ear);
      }
      const a=rng()*Math.PI*2, r=8+rng()*32;
      const px = Math.cos(a)*r, pz = Math.sin(a)*r;
      g.userData = { baseX:px, baseZ:pz, ph:rng()*7, dir:rng()*Math.PI*2 };
      g.position.set(px, groundHeight(px,pz)+0.1, pz);
      scene.add(g); rabbits.push(g);
    }
    world.updaters.push((dt,t)=>{
      for(const r of rabbits){
        const u = r.userData;
        const hopCycle = (t*0.9+u.ph) % 2.4;
        const hop = hopCycle < 0.7 ? Math.sin(hopCycle/0.7*Math.PI) : 0;
        if(hopCycle < 0.7){
          const px = u.baseX + Math.cos(u.dir)*hopCycle*0.9, pz = u.baseZ + Math.sin(u.dir)*hopCycle*0.9;
          r.position.x = px; r.position.z = pz;
          r.position.y = groundHeight(px,pz)+0.1+hop*0.3;
          r.rotation.y = u.dir;
        } else if(hopCycle > 2.1){ u.dir = rng()*Math.PI*2; u.baseX=r.position.x; u.baseZ=r.position.z; }
        r.scale.set(1+hop*0.08, 1-hop*0.12, 1+hop*0.08);
      }
    });
  }

  world.update = (dt, t)=>{ for(const u of world.updaters) u(dt,t); };
  return world;
}

function makeCloudTexture(){
  const c=document.createElement('canvas'); c.width=256; c.height=128;
  const g=c.getContext('2d');
  const puffs = [];
  for(let i=0;i<9;i++) puffs.push([40+Math.random()*176, 44+Math.random()*34, 18+Math.random()*26]);
  // shaded lavender underside
  for(const [x,y,r] of puffs){
    const gr=g.createRadialGradient(x,y+r*0.45,2,x,y+r*0.45,r);
    gr.addColorStop(0,'rgba(150,130,190,0.85)'); gr.addColorStop(1,'rgba(150,130,190,0)');
    g.fillStyle=gr; g.beginPath(); g.arc(x,y+r*0.45,r,0,7); g.fill();
  }
  // lit tops
  for(const [x,y,r] of puffs){
    const gr=g.createRadialGradient(x,y-4,2,x,y-4,r*0.9);
    gr.addColorStop(0,'rgba(255,250,238,0.98)'); gr.addColorStop(1,'rgba(255,250,238,0)');
    g.fillStyle=gr; g.beginPath(); g.arc(x,y-4,r*0.9,0,7); g.fill();
  }
  const t=new THREE.CanvasTexture(c); return t;
}
function makeRayTexture(){
  const c=document.createElement('canvas'); c.width=64; c.height=256;
  const g=c.getContext('2d');
  const gr=g.createLinearGradient(0,0,0,256);
  gr.addColorStop(0,'rgba(255,240,200,0.8)'); gr.addColorStop(1,'rgba(255,240,200,0)');
  g.fillStyle=gr;
  g.beginPath(); g.moveTo(20,0); g.lineTo(44,0); g.lineTo(64,256); g.lineTo(0,256); g.fill();
  return new THREE.CanvasTexture(c);
}
