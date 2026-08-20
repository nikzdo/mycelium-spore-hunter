// rockgen.js — parametric stacked-prism rocks (item 34) + lattice jitter (item 55)
//
// ONE generator makes boulders, spires, towers, crystal clusters and whole ridges. The
// difference between them is numbers, not code paths — see PRESETS. Everything here is
// build-time: nothing in this file is safe to call from a render loop.
//
// Typical use (world.js side, see PORT_NOTES.md):
//   const geos = [];
//   for(const c of jitterLattice(rng, { shape:'hex', r:1.4, cols:6, rows:5, cx, cz,
//                                       test:(x,z)=>!inExclusion(x,z,2) }))
//     geos.push(makeStack(rng, Object.assign({}, PRESETS.boulder, {
//       r:c.r, h:c.h, sides:c.sides, tiers:c.tiers, hull:0.06,
//       x:c.x, y:groundHeight(c.x,c.z), z:c.z, rotY:c.rotY, tiltX:c.tiltX, tiltZ:c.tiltZ
//     }), COLLIDERS));
//   const { geo, hull } = mergeStacks(geos);   // 2 draw calls for any number of rocks
import * as THREE from 'three';
import { linearColor, paletteOf } from './fx.js';

const TAU = Math.PI * 2;
const clamp01 = (v)=> v < 0 ? 0 : v > 1 ? 1 : v;
const rangeOf = (rng, a, b)=> a + (b - a) * rng();
function colorOf(v){ return (typeof v === 'number') ? linearColor(v) : v; }

/* ---------- palettes ---------- */
// Hexes go through THREE.Color exactly once here, so every tier ramp is a lerp between LINEAR
// colours. Ramping between sRGB-encoded numbers is the blend that goes muddy under ACES.
export const ROCK_PAL = paletteOf({
  stone:   { base:0x4a434e, side:0x9a8f96, tint:0x8a7460 },
  basalt:  { base:0x201c28, side:0x5d5866, tint:0x3a3550 },
  chalk:   { base:0x7a7264, side:0xd8cfb8, tint:0xb8ac92 },
  crystal: { base:0x22405f, side:0x8fd8ff, tint:0x6de0d0 },
  rot:     { base:0x261b2c, side:0x6b4a72, tint:0x9a5ec8 },
});

const DEFAULTS = {
  r: 1.2,             // base radius of the bottom tier
  h: undefined,       // absolute tier-0 height; if unset, r * hr
  hr: 1,              // height/radius ratio — this single number is boulder vs spire
  tiers: 1,
  sides: 7,
  taper: 0.7,         // top radius / bottom radius WITHIN one tier
  bulge: 1.1,         // mid-row radius multiplier; >1 makes the silhouette convex
  wobble: 0.24,       // per-vertex radius+angle jitter of the shared ring
  shrink: [0.62, 0.86],   // radius multiplier BETWEEN tiers
  hScale: [0.72, 1.0],    // height multiplier between tiers
  drift: 0.34,        // lateral centre drift per tier, as a fraction of the new radius
  sink: 0.3,          // tier-0 base sits this * r below y=0, so the rock beds into terrain
  capJitter: 0.16,    // per-vertex Y jitter of the top row, as a fraction of tier height
  capRise: 0.14,      // centre of the top fan lifted, so the cap is a low crown not a lid
  tintStep: 0.35,     // how far the last tier drifts toward `tint`
  faceJitter: 0.07,   // per-face darkening range
  highlight: 0.2,     // baked cylindrical highlight swing (item 38)
  highlightAngle: 2.35,
  base: ROCK_PAL.stone.base,   // colour at each tier's bottom
  side: ROCK_PAL.stone.side,   // colour at each tier's top
  tint: ROCK_PAL.stone.tint,   // accent the tier tint step walks toward
  minColliderR: 0.55,
  x:0, y:0, z:0, rotY:0, tiltX:0, tiltZ:0,
  hull: 0,            // >0 also builds the matching inverted-hull shell, in world units (see makeStack)
  ring: null,         // pass a polyRing() to share ONE outline across several stacks
};

// The whole vocabulary, as parameters. A "type" of rock is a row in this table.
export const PRESETS = {
  boulder: { tiers:1, sides:8, hr:0.85, taper:0.62, bulge:1.16, wobble:0.28, sink:0.34 },
  spire:   { tiers:2, sides:6, hr:3.0,  taper:0.55, bulge:1.02, wobble:0.18, sink:0.22,
             shrink:[0.5,0.7], hScale:[0.5,0.8], drift:0.18 },
  tower:   { tiers:4, sides:7, hr:1.5,  taper:0.86, bulge:1.05, wobble:0.2,  sink:0.3,
             shrink:[0.74,0.92], hScale:[0.8,1.05], drift:0.3 },
  crystal: { tiers:1, sides:5, hr:2.6,  taper:0.28, bulge:0.98, wobble:0.1,  sink:0.18,
             capJitter:0.05, capRise:0.5, highlight:0.34,
             base:ROCK_PAL.crystal.base, side:ROCK_PAL.crystal.side, tint:ROCK_PAL.crystal.tint },
  ridge:   { tiers:3, sides:6, hr:1.2,  taper:0.72, bulge:1.08, wobble:0.26, sink:0.4,
             shrink:[0.66,0.9], hScale:[0.7,1.0], drift:0.55 },
};

/* ---------- the shared outline ---------- */
// One wobbled polygon, reused by every tier of a stack. Re-cutting the ring per tier is exactly
// what makes a stack read as stacked cylinders; sharing it is what makes three tiers read as one
// rock that has been broken across.
export function polyRing(rng, sides, wobble = 0.24){
  const n = Math.max(3, sides|0);
  const ring = new Float32Array(n*2);
  for(let i=0;i<n;i++){
    // angular jitter as well as radial, or the facets stay suspiciously regular. Capped at
    // 0.4 of the vertex spacing so neighbours can never cross and invert a face.
    const a = (i/n)*TAU + (rng()-0.5)*(TAU/n)*Math.min(0.8, wobble*1.6);
    const w = 1 + (rng()-0.5)*2*wobble;
    ring[i*2] = Math.cos(a)*w; ring[i*2+1] = Math.sin(a)*w;
  }
  return ring;
}

/* ---------- placement ---------- */
const _m4 = new THREE.Matrix4(), _eu = new THREE.Euler(), _v3 = new THREE.Vector3();
// Euler order YXZ builds Ry*Rx*Rz, so a vertex is tilted in the rock's OWN frame first and
// yawed after. Yaw-then-tilt makes the lean direction depend on the yaw, and a field of rocks
// then all lean the same way in world space instead of each leaning its own way.
function placeMatrix(x, y, z, rotY, tiltX, tiltZ, out=_m4){
  _eu.set(tiltX, rotY, tiltZ, 'YXZ');
  out.makeRotationFromEuler(_eu);
  out.setPosition(x, y, z);
  return out;
}
// Bakes rotation/tilt/translation into the vertex buffer. Baking is what lets hundreds of
// individually-placed, individually-shaped rocks end up in one merged draw call — an
// InstancedMesh can only repeat one silhouette.
// NOTE: the returned matrix is a module scratch; do not retain it.
export function placeGeo(geo, x, y, z, rotY=0, tiltX=0, tiltZ=0){
  geo.applyMatrix4(placeMatrix(x, y, z, rotY, tiltX, tiltZ));
  return geo;
}
// A collider stays an UPRIGHT cylinder — that is world.js's contract — so a tilted tier is
// approximated by transforming its axis endpoints with the same matrix as the vertices and
// keeping the midline. Tilts here stay under ~0.2 rad, where the error is well inside PLAYER_R.
function xformCollider(c, m){
  _v3.set(c.x, c.bot, c.z).applyMatrix4(m);
  const bx = _v3.x, by = _v3.y, bz = _v3.z;
  _v3.set(c.x, c.top, c.z).applyMatrix4(m);
  c.x = (bx + _v3.x)*0.5; c.z = (bz + _v3.z)*0.5;
  c.bot = Math.min(by, _v3.y); c.top = Math.max(by, _v3.y);
}

/* ---------- the generator ---------- */
// makeStack(rng, opts, collidersOut) -> BufferGeometry
//   opts: any DEFAULTS key (spread a PRESETS entry over it).
//   collidersOut: array; one { x, z, r, bot, top } is PUSHED PER QUALIFYING TIER.
//   geo.userData = { hull, height, top, colliders }
export function makeStack(rng, opts = {}, collidersOut = null){
  const o = Object.assign({}, DEFAULTS, opts);
  const sides = Math.max(3, o.sides|0);
  const tiers = Math.max(1, o.tiers|0);
  const h0 = o.h !== undefined ? o.h : o.r * o.hr;
  const ring = o.ring || polyRing(rng, sides, o.wobble);

  // every tier drifts along the SAME heading, so a stack leans coherently like a weathered
  // outcrop instead of zig-zagging like a badly balanced toy
  const lean = rng()*TAU, leanX = Math.cos(lean), leanZ = Math.sin(lean);

  const cBase = colorOf(o.base), cSide = colorOf(o.side), cTint = colorOf(o.tint);

  // 2 side bands (4 tris per edge) + a top fan (1 per edge) per tier, plus one bottom fan
  const triCount = tiers*sides*5 + sides;
  const pos = new Float32Array(triCount*9);
  const col = new Float32Array(triCount*9);
  const rowA = new Float64Array(sides*3), rowB = new Float64Array(sides*3), rowC = new Float64Array(sides*3);

  let vi = 0, tY0 = 0, tH = 1;
  let c0r=0, c0g=0, c0b=0, c1r=0, c1g=0, c1b=0;
  const put = (x, y, z, f)=>{
    const t = tH > 0 ? clamp01((y - tY0)/tH) : 0;   // ramp base->side by height WITHIN the tier
    const b = vi*3;
    pos[b]=x; pos[b+1]=y; pos[b+2]=z;
    col[b]   = (c0r + (c1r-c0r)*t)*f;
    col[b+1] = (c0g + (c1g-c0g)*t)*f;
    col[b+2] = (c0b + (c1b-c0b)*t)*f;
    vi++;
  };
  // one jitter factor per FACE, shared by its three vertices: the height ramp still reads as
  // strata, but individual facets catch light differently, which is what stops a merged field
  // of rocks looking like one extruded blob.
  const tri = (ax,ay,az, bx,by,bz, px,py,pz)=>{
    const f = 1 - rng()*o.faceJitter;
    put(ax,ay,az,f); put(bx,by,bz,f); put(px,py,pz,f);
  };
  // outward winding: (L_i, U_i, U_j) then (L_i, U_j, L_j). Ring angle increases from +X toward
  // +Z, and this order is the one whose cross product points away from the axis.
  const band = (lo, hi, i, j)=>{
    tri(lo[i*3],lo[i*3+1],lo[i*3+2], hi[i*3],hi[i*3+1],hi[i*3+2], hi[j*3],hi[j*3+1],hi[j*3+2]);
    tri(lo[i*3],lo[i*3+1],lo[i*3+2], hi[j*3],hi[j*3+1],hi[j*3+2], lo[j*3],lo[j*3+1],lo[j*3+2]);
  };

  const cStart = collidersOut ? collidersOut.length : 0;
  let r = o.r, ht = h0, cx = 0, cz = 0, y0 = -o.sink*o.r, localTop = y0;

  for(let t=0; t<tiers; t++){
    const rTop = r*o.taper;
    const rMid = (r + (rTop - r)*0.55) * o.bulge;   // mid row at 0.55 height, slightly bulged
    const yMid = y0 + ht*0.55, yTop = y0 + ht;

    // per-tier tint step: each tier walks a little further toward the accent, so the silhouette
    // reads as strata laid down at different times rather than one extruded colour
    const k = tiers > 1 ? (t/(tiers-1))*o.tintStep : 0;
    c0r = cBase.r + (cTint.r - cBase.r)*k; c0g = cBase.g + (cTint.g - cBase.g)*k; c0b = cBase.b + (cTint.b - cBase.b)*k;
    c1r = cSide.r + (cTint.r - cSide.r)*k; c1g = cSide.g + (cTint.g - cSide.g)*k; c1b = cSide.b + (cTint.b - cSide.b)*k;
    tY0 = y0; tH = ht;

    for(let i=0;i<sides;i++){
      const dx = ring[i*2], dz = ring[i*2+1];
      rowA[i*3]=cx+dx*r;    rowA[i*3+1]=y0;   rowA[i*3+2]=cz+dz*r;
      rowB[i*3]=cx+dx*rMid; rowB[i*3+1]=yMid; rowB[i*3+2]=cz+dz*rMid;
      // the top row's Y is jittered PER VERTEX so the cap is a broken crown, not a machined lid
      rowC[i*3]=cx+dx*rTop; rowC[i*3+1]=yTop + (rng()-0.5)*2*o.capJitter*ht; rowC[i*3+2]=cz+dz*rTop;
    }
    const peakY = yTop + o.capRise*ht;
    for(let i=0;i<sides;i++){
      const j = (i+1)%sides;
      band(rowA, rowB, i, j);
      band(rowB, rowC, i, j);
      tri(cx, peakY, cz, rowC[j*3],rowC[j*3+1],rowC[j*3+2], rowC[i*3],rowC[i*3+1],rowC[i*3+2]);
    }
    if(t === 0){
      // close the bottom while rowA is still tier 0's. The base is sunk below the terrain, but a
      // watertight shell is what keeps the BackSide outline from showing its own interior.
      for(let i=0;i<sides;i++){
        const j = (i+1)%sides;
        tri(cx, y0, cz, rowA[i*3],rowA[i*3+1],rowA[i*3+2], rowA[j*3],rowA[j*3+1],rowA[j*3+2]);
      }
    }

    // INVARIANT (item 01): the collider for this tier is pushed by the SAME loop iteration that
    // just wrote its vertices, from the same cx/cz/r/y numbers. Geometry and collision cannot
    // drift apart, because there is no second place where either is computed.
    // Below minColliderR a tier is a pebble: PLAYER_R is 0.85 and STEP is 1.5, so a sub-0.55
    // radius lump is something you brush past or step over. Turning it into a wall would only
    // make the world feel sticky.
    const cr = (r + rTop)*0.5;   // mean of the tier's bottom and top radius, so the cylinder
    if(collidersOut && cr >= o.minColliderR)   // neither overhangs the cap nor undercuts the base
      collidersOut.push({ x:cx, z:cz, r:cr, bot:y0, top:yTop });

    localTop = yTop;
    r  *= rangeOf(rng, o.shrink[0], o.shrink[1]);
    ht *= rangeOf(rng, o.hScale[0], o.hScale[1]);
    const d = o.drift * r * (0.5 + rng());   // drift scaled by the NEW radius: a small cap can
    cx += leanX*d; cz += leanZ*d;            // hang further off its base than a big one
    y0 = yTop;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // non-indexed on purpose: computeVertexNormals() then gives every vertex its own FACE normal,
  // which is flat shading without needing a material flag that toonMat() does not expose.
  geo.computeVertexNormals();

  let hull = null;
  if(o.hull > 0){
    // OUTLINE DECISION: fx.addOutline() scales a mesh about its own origin, which a MERGED rock
    // field does not have — scaling merged geometry pushes every rock away from the world origin
    // instead of thickening it. So the shell is baked here, per rock, in local space before
    // placement, and merged separately: hundreds of unique rocks cost one fill draw call plus one
    // ink draw call. Draw it with a BackSide MeshBasicMaterial (fx's outlineMat look);
    // NEVER pass a merged rock mesh to addOutline().
    // `hull` is an ABSOLUTE width in world units, not addOutline()'s scale factor: a proportional
    // scale gives ink that grows with distance from the origin, and a 14-unit spire ends up
    // wearing a 0.6-unit black cap. Pushing out radially from the stack axis and away from
    // mid-height by a fixed amount keeps one constant ink weight at every rock size.
    const t = o.hull, midY = (localTop - o.sink*o.r)*0.5;
    const hp = new Float32Array(pos.length);
    for(let i=0;i<pos.length;i+=3){
      const x = pos[i], y = pos[i+1], z = pos[i+2];
      const d = Math.sqrt(x*x + z*z) || 1;
      hp[i] = x + (x/d)*t; hp[i+1] = y + (y > midY ? t : -t); hp[i+2] = z + (z/d)*t;
    }
    hull = new THREE.BufferGeometry();
    hull.setAttribute('position', new THREE.BufferAttribute(hp, 3));
  }

  // ONE matrix, applied to the vertices, to the shell and to the colliders. There is no code
  // path in which only some of the three get placed.
  const m = placeMatrix(o.x, o.y, o.z, o.rotY, o.tiltX, o.tiltZ);
  geo.applyMatrix4(m);
  if(hull) hull.applyMatrix4(m);
  if(collidersOut) for(let i=cStart;i<collidersOut.length;i++) xformCollider(collidersOut[i], m);

  if(o.highlight > 0) paintHighlight(geo, o.x, o.z, o.highlight, o.highlightAngle);

  geo.userData.hull = hull;
  geo.userData.height = localTop - (-o.sink*o.r);
  geo.userData.top = o.y + localTop;
  geo.userData.colliders = collidersOut ? collidersOut.length - cStart : 0;
  return geo;
}

// item 38's baked cylindrical highlight, computed in WORLD space around the rock's own axis and
// AFTER placement. Bake it before the yaw and every rock's painted highlight ends up pointing
// somewhere different, which reads as broken lighting rather than one hand-painted set.
// We deliberately do not call fx.shade(): it OVERWRITES the colour attribute, which would erase
// the strata ramp this file just built.
function paintHighlight(geo, cx, cz, amount, angle){
  const p = geo.attributes.position.array, c = geo.attributes.color.array;
  for(let i=0;i<p.length;i+=3){
    const f = 1 + amount*Math.cos(Math.atan2(p[i+2]-cz, p[i]-cx) - angle);
    c[i]*=f; c[i+1]*=f; c[i+2]*=f;
  }
}

/* ---------- merging ---------- */
// Collapse many placed geometries into one BufferGeometry. Attributes are the set present on
// EVERY input (so a position-only outline shell merges fine next to a coloured fill).
// Inputs are disposed: keeping them alive would double the memory for no reason, and reusing a
// merged-away geometry is always a bug. A single-element list is returned as-is, undisposed.
export function mergeGeos(list){
  const geos = [];
  for(const g of list) if(g) geos.push(g);
  if(!geos.length) return new THREE.BufferGeometry();
  if(geos.length === 1) return geos[0];
  const names = Object.keys(geos[0].attributes).filter(n => geos.every(g => g.attributes[n]));
  let total = 0;
  for(const g of geos) total += g.attributes.position.count;
  const out = new THREE.BufferGeometry();
  for(const n of names){
    const size = geos[0].attributes[n].itemSize;
    const arr = new Float32Array(total*size);
    let off = 0;
    for(const g of geos){
      const a = g.attributes[n];
      arr.set(a.array.subarray ? a.array.subarray(0, a.count*size) : a.array, off);
      off += a.count*size;
    }
    out.setAttribute(n, new THREE.BufferAttribute(arr, size));
  }
  out.computeBoundingSphere();
  for(const g of geos) g.dispose();
  return out;
}
// The pair a caller actually wants: fill + ink, both merged, hulls harvested BEFORE mergeGeos()
// disposes the stacks that carry them.
export function mergeStacks(list){
  const hulls = [];
  for(const g of list) if(g && g.userData.hull) hulls.push(g.userData.hull);
  const geo = mergeGeos(list);
  return { geo, hull: hulls.length ? mergeGeos(hulls) : null };
}

/* ---------- item 55: jitter the instance, keep the lattice ---------- */
const LATTICE = {
  shape:'hex',        // 'hex' | 'grid' | 'ring' | 'line'
  r: 1.2,             // BASE radius — the lattice key. Never the jittered one.
  h: null,            // base height; defaults to r
  spacing: 1.8,       // step, in base radii
  cx:0, cz:0,
  cols:5, rows:4,     // hex/grid
  count:8, radius:null, angle:0,   // ring/line
  rMul:[0.65,1.4], hMul:[0.6,1.5], sides:[5,9], tiers:[1,2],
  pos:0.34,           // positional jitter, as a fraction of the step (hard-capped below 0.5)
  tilt:0.1,
  edgeScale:1,        // size multiplier at the rim: <1 crests a cluster/ridge in the middle
  test:null,          // (x,z)->bool, run on the JITTERED position
};
// THE PRINCIPLE: vary radius, height, side count, tilt and position per cell as much as you
// like, but keep the grid step keyed to the UNJITTERED base radius. Let the jittered radius set
// the step and the packing drifts — gaps at one end, overlap at the other. Keyed to the base,
// the mosaic still tiles cleanly while reading as broken crust instead of floor tiles.
// Returns plain data, so the same helper lays out rocks, pods, mushrooms or anything else.
export function jitterLattice(rng, spec = {}){
  const s = Object.assign({}, LATTICE, spec);
  const step = s.r * s.spacing;
  const baseH = s.h != null ? s.h : s.r;
  const jit = Math.min(0.49, s.pos);   // >=0.5 lets an instance leave its own cell and swap
  const out = [];                      // places with its neighbour — then it is no longer a lattice
  const push = (x, z, edge)=>{
    const jx = x + (rng()*2-1)*step*jit;
    const jz = z + (rng()*2-1)*step*jit;
    // placement predicates query the finished world (height, slope, exclusions, COLLIDERS),
    // not the noise — that is what stops a cell landing inside something that already exists
    if(s.test && !s.test(jx, jz)) return;
    const fall = 1 + (s.edgeScale - 1)*edge;
    out.push({
      x:jx, z:jz, edge,
      r: s.r * rangeOf(rng, s.rMul[0], s.rMul[1]) * fall,
      h: baseH * rangeOf(rng, s.hMul[0], s.hMul[1]) * fall,
      sides: s.sides[0] + ((rng()*(s.sides[1]-s.sides[0]+1))|0),
      tiers: s.tiers[0] + ((rng()*(s.tiers[1]-s.tiers[0]+1))|0),
      rotY: rng()*TAU,
      tiltX: (rng()*2-1)*s.tilt, tiltZ: (rng()*2-1)*s.tilt,
    });
  };

  if(s.shape === 'hex' || s.shape === 'grid'){
    const cols = Math.max(1, s.cols|0), rows = Math.max(1, s.rows|0);
    const zStep = s.shape === 'hex' ? step*0.8660254 : step;   // sqrt(3)/2 row pitch
    const w = (cols-1)*step, d = (rows-1)*zStep;
    const norm = Math.max(1e-6, Math.max(w, d)*0.5);
    for(let j=0;j<rows;j++) for(let i=0;i<cols;i++){
      const x = s.cx - w/2 + i*step + (s.shape === 'hex' ? (j&1)*step*0.5 : 0);
      const z = s.cz - d/2 + j*zStep;
      push(x, z, clamp01(Math.hypot(x - s.cx, z - s.cz)/norm));
    }
  } else if(s.shape === 'ring'){
    const n = Math.max(3, s.count|0);
    const rad = s.radius != null ? s.radius : (n*step)/TAU;   // the radius that spaces n cells `step` apart
    for(let i=0;i<n;i++){
      const a = (i/n)*TAU;
      push(s.cx + Math.cos(a)*rad, s.cz + Math.sin(a)*rad, 1);
    }
  } else {   // 'line' — a ridge. One row, spacing still keyed to the base radius.
    const n = Math.max(1, s.count|0);
    const ax = Math.cos(s.angle), az = Math.sin(s.angle);
    for(let i=0;i<n;i++){
      const t = n > 1 ? i/(n-1) : 0.5;
      const d = (t - 0.5)*(n - 1)*step;
      push(s.cx + ax*d, s.cz + az*d, Math.abs(t - 0.5)*2);   // edge=1 at the ends, so edgeScale<1 crests it
    }
  }
  return out;
}
