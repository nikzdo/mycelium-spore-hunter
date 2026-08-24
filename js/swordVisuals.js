// swordVisuals.js — ornate procedural sword models, one hilt style per rarity tier
// gems follow the same brown/green/red/blue/purple rarity gradient as mushrooms:
// (common: plain steel · uncommon: leaf-wrapped wood · rare: curved gold+ember red ·
//  epic: spiky dark+azure flame · legendary: golden wings+violet halo)
import * as THREE from 'three';
import { toonMat, addOutline } from './fx.js';

const GEM_COLORS = [0xd8d8d8, 0x6fe65a, 0xff5a4a, 0x5aa0ff, 0xb46bff];

// tapered blade: BoxGeometry translated so local y=0 is the guard end and
// y=-length is the tip; jagged=true adds serrated edge notches (epic tier)
function makeBladeGeo(width, length, depth, jagged=false){
  const geo = new THREE.BoxGeometry(width, length, depth, 1, 8, 1);
  geo.translate(0, -length/2, 0);
  const p = geo.attributes.position;
  for(let i=0;i<p.count;i++){
    const y = p.getY(i);
    const tt = THREE.MathUtils.clamp(-y/length, 0, 1);
    const k = Math.pow(1-tt, 0.62);
    let x = p.getX(i) * (0.12 + 0.88*k);
    const z = p.getZ(i) * (0.35 + 0.65*k);
    if(jagged && tt > 0.1 && tt < 0.96 && x !== 0){
      const band = Math.round(y*41);
      const jr = Math.abs(Math.sin(band*12.9898)) % 1;
      x += Math.sign(x) * (jr-0.5) * width * 0.55 * (1-tt*0.4);
    }
    p.setX(i, x); p.setZ(i, z);
  }
  geo.computeVertexNormals();
  return geo;
}

function gemMesh(rarity, size){
  const m = new THREE.Mesh(new THREE.IcosahedronGeometry(size, 0),
    toonMat({ color:GEM_COLORS[rarity], emissive:GEM_COLORS[rarity], emissiveIntensity: rarity===0?0.15:0.9, rim:0.7, rimColor:GEM_COLORS[rarity] }));
  addOutline(m, 0.08);
  return m;
}

function buildHilt(rarity){
  const g = new THREE.Group();
  if(rarity === 0){ // COMMON — plain steel
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.05, 0.09),
      toonMat({ color:0xc9c9c9, rim:0.5, rimColor:0xffffff }));
    addOutline(guard, 0.1); g.add(guard);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7),
      toonMat({ color:0x8a5a35, rim:0.25 }));
    grip.position.y = 0.15; addOutline(grip, 0.1); g.add(grip);
    const pommel = gemMesh(0, 0.05); pommel.position.y = 0.30; g.add(pommel);
  } else if(rarity === 1){ // UNCOMMON — leaf-wrapped wood
    const guard = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.045, 0.08),
      toonMat({ color:0x6b4a2a, rim:0.3 }));
    addOutline(guard, 0.1); g.add(guard);
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7),
      toonMat({ color:0x6b4a2a, rim:0.25 }));
    grip.position.y = 0.15; addOutline(grip, 0.1); g.add(grip);
    const leafMat = toonMat({ color:0x4a8a2e, rim:0.5, rimColor:0xc8ffb0 });
    for(const s of [-1,1]){
      const leaf = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.17, 4), leafMat);
      leaf.position.set(0.10*s, 0.06, 0);
      leaf.rotation.z = 1.1*s; leaf.rotation.x = 0.3;
      addOutline(leaf, 0.08); g.add(leaf);
    }
    const pommel = gemMesh(1, 0.06); pommel.position.y = 0.30; g.add(pommel);
  } else if(rarity === 2){ // RARE — curved gold guard, aqua wrap
    const goldMat = toonMat({ color:0xd4af37, rim:0.65, rimColor:0xfff2b0 });
    for(const s of [-1,1]){
      const fang = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.24, 5), goldMat);
      fang.position.set(0.09*s, -0.05, 0);
      fang.rotation.z = 2.5*s; fang.rotation.x = 0.15;
      addOutline(fang, 0.1); g.add(fang);
    }
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7),
      toonMat({ color:0x5a1a1a, rim:0.4, rimColor:0xffb0a0 }));
    grip.position.y = 0.15; addOutline(grip, 0.1); g.add(grip);
    for(const ry of [0.06, 0.24]){
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.012, 5, 10), goldMat);
      ring.position.y = ry; ring.rotation.x = Math.PI/2; g.add(ring);
    }
    const pommel = gemMesh(2, 0.065); pommel.position.y = 0.32; g.add(pommel);
  } else if(rarity === 3){ // EPIC — spiky dark guard, azure flame
    const spikeMat = toonMat({ color:0x1a2230, rim:0.4, rimColor:0x5aa0ff });
    for(let i=0;i<5;i++){
      const a = (i/5)*Math.PI*2;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.16, 4), spikeMat);
      spike.position.set(Math.cos(a)*0.09, -0.01, Math.sin(a)*0.09*0.4);
      spike.rotation.z = Math.PI/2 + a*0.3; spike.rotation.x = Math.cos(a)*0.6;
      addOutline(spike, 0.1); g.add(spike);
    }
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7),
      toonMat({ color:0x182030, rim:0.35, rimColor:0x5aa0ff }));
    grip.position.y = 0.15; addOutline(grip, 0.1); g.add(grip);
    const pommel = gemMesh(3, 0.07); pommel.position.y = 0.31; g.add(pommel);
    // azure flame wreath
    const flame = new THREE.Mesh(new THREE.ConeGeometry(0.22, 0.9, 8, 1, true),
      new THREE.MeshBasicMaterial({ color:0x5aa0ff, transparent:true, opacity:0.22,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
    flame.position.y = -0.35; flame.rotation.x = Math.PI;
    g.add(flame); g.userData.flame = flame;
  } else { // LEGENDARY — golden wings, blue gem, sparkle
    const goldMat = toonMat({ color:0xffd94a, rim:0.8, rimColor:0xfff6d0, emissive:0xb4860a, emissiveIntensity:0.35 });
    for(const s of [-1,1]){
      const wing = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.32, 3), goldMat);
      wing.position.set(0.13*s, 0.02, 0);
      wing.rotation.z = 1.85*s; wing.rotation.y = 0.5*s;
      addOutline(wing, 0.1); g.add(wing);
    }
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, 0.26, 7),
      toonMat({ color:0x3a1a5a, rim:0.5, rimColor:0xd8a6ff }));
    grip.position.y = 0.15; addOutline(grip, 0.1); g.add(grip);
    for(const ry of [0.06, 0.24]){
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.012, 5, 10), goldMat);
      ring.position.y = ry; ring.rotation.x = Math.PI/2; g.add(ring);
    }
    const pommel = gemMesh(4, 0.07); pommel.position.y = 0.32; g.add(pommel);
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.5, 10, 8),
      new THREE.MeshBasicMaterial({ color:0xd8a6ff, transparent:true, opacity:0.16,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide }));
    halo.position.y = -0.45; g.add(halo); g.userData.halo = halo;
  }
  return g;
}

const BLADE_DIMS = [
  { w:0.10, l:0.95, d:0.18, jagged:false }, // common — straight steel
  { w:0.10, l:0.95, d:0.17, jagged:false }, // uncommon — pale, leaf-etched
  { w:0.11, l:1.00, d:0.19, jagged:false }, // rare — slim aqua
  { w:0.14, l:1.05, d:0.22, jagged:true  }, // epic — wide, jagged dark blade
  { w:0.13, l:1.05, d:0.20, jagged:false }, // legendary — bright polished
];

// builds the Windsong Bow: a curved stave + taut string + a grip, built from its own geometry
// rather than the shared tapered-blade mesh every sword-family weapon reuses — a bow does not
// read as a bow if it's just a re-scaled sword blade with a different tint.
export function buildBow(){
  const group = new THREE.Group();
  const staveMat = toonMat({ color:0x6b4a2a, rim:0.5, rimColor:0xc8ffb0 });
  // a quadratic bezier from tip to tip, bowed out on -X, is a robust way to get a believable
  // bow curve without hand-tuning torus-arc trig
  const curve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(0, 0.42, 0),
    new THREE.Vector3(-0.15, 0, 0),
    new THREE.Vector3(0, -0.42, 0));
  const stave = new THREE.Mesh(new THREE.TubeGeometry(curve, 20, 0.026, 6, false), staveMat);
  addOutline(stave, 0.22);
  group.add(stave);

  // string: straight, tip to tip, sitting on the open (+X) side of the stave's curve for tension
  const string = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 0.84, 5),
    new THREE.MeshBasicMaterial({ color:0xf2e4c8 }));
  string.position.x = 0.015;
  group.add(string);

  // grip, sitting at the curve's actual midpoint (a quadratic bezier's t=0.5 point is NOT the
  // origin — it's pulled toward the control point) so it doesn't float off the stave
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.17, 7),
    toonMat({ color:0x4a3420, rim:0.3 }));
  grip.position.set(-0.065, 0, 0);
  addOutline(grip, 0.15);
  group.add(grip);

  return { group, stave, string, grip };
}

// builds the spear: a long shaft + steel point, its own model rather than a stretched sword
// blade — the whole point of a spear is reach read at a glance, and a re-scaled sword blade
// doesn't sell "long shaft held out in front" the way a real taper-to-a-point silhouette does.
export function buildSpear(){
  const group = new THREE.Group();
  const shaftMat = toonMat({ color:0x6b4a2a, rim:0.4, rimColor:0xd8c8a0 });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 1.5, 7), shaftMat);
  shaft.position.y = -0.75;                 // grip at y=0, shaft runs down toward the point
  addOutline(shaft, 0.12);
  group.add(shaft);

  // a wrapped grip band, so the hand-height on the shaft reads even at a glance
  const wrap = new THREE.Mesh(new THREE.CylinderGeometry(0.042, 0.042, 0.16, 7),
    toonMat({ color:0x3a2a18, rim:0.3 }));
  wrap.position.y = -0.14;
  addOutline(wrap, 0.1);
  group.add(wrap);

  // steel point, tinted per-weapon like the sword blade / bow stave
  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.078, 0.44, 6),
    toonMat({ color:0xd8d8d8, emissive:0x6a7a88, emissiveIntensity:0.5, rim:0.75, rimColor:0xffffff }));
  tip.position.y = -1.5 - 0.20;
  addOutline(tip, 0.12);
  group.add(tip);

  // two small side barbs at the point's base — without them the silhouette reads as "sharpened
  // stick", not "spear"
  const barbMat = toonMat({ color:0xb8b8b8, rim:0.55, rimColor:0xffffff });
  for(const s of [-1,1]){
    const barb = new THREE.Mesh(new THREE.ConeGeometry(0.036, 0.17, 4), barbMat);
    barb.position.set(0.052*s, -1.5-0.02, 0);
    barb.rotation.z = 1.15*s; barb.rotation.x = 0.22;
    addOutline(barb, 0.1);
    group.add(barb);
  }
  return { group, shaft, tip };
}

// builds one full sword: { group (add under the hand), blade (mesh to tint per-weapon) }
export function buildSwordVariant(rarity){
  const group = new THREE.Group();
  const hilt = buildHilt(rarity);
  group.add(hilt);
  const d = BLADE_DIMS[rarity];
  const blade = new THREE.Mesh(makeBladeGeo(d.w, d.l, d.d, d.jagged),
    toonMat({ color:0xbfefff, emissive:0x3fa8cc, emissiveIntensity:1.2, rim:0.8, rimColor:0xbfefff }));
  addOutline(blade, 0.1);
  // blade glow trail plane (motion streak during swings)
  const glowTexC = document.createElement('canvas'); glowTexC.width = 16; glowTexC.height = 64;
  const gg = glowTexC.getContext('2d');
  const ggr = gg.createLinearGradient(0,0,0,64);
  ggr.addColorStop(0,'rgba(160,240,255,0)'); ggr.addColorStop(0.5,'rgba(160,240,255,0.9)'); ggr.addColorStop(1,'rgba(160,240,255,0)');
  gg.fillStyle = ggr; gg.fillRect(0,0,16,64);
  const glowPlane = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 1.2),
    new THREE.MeshBasicMaterial({ map:new THREE.CanvasTexture(glowTexC), transparent:true, opacity:0.7,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
  glowPlane.position.y = -d.l*0.5;
  blade.add(glowPlane);
  group.add(blade);
  return { group, blade, hiltFx: hilt.userData };
}
