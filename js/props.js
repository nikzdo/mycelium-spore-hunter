// props.js — the interactive props. Items 11 (spore pods), 13 (vents), 14 (sealed chests),
// 18 (guaranteed treasure).
//
// This module is the toys. Everything else in the world is scenery you route around; these four
// are the things you go *to*. They share one build entry point and one update, and every payout,
// travel and pickup is REPORTED to the caller rather than acted on — HUD, audio and announce copy
// all live in main.js, so a prop that pays must never also decide how that reads.
//
// Nothing here is imported by world.js/entities.js/main.js yet — see PORT_NOTES.md for the wiring.
//
// Typical wiring (main.js side):
//   import { buildProps } from './props.js';
//   const props = buildProps(scene, mulberry32(deriveSeed(seed, 0x9705)), world, {
//     progress, pops: rewardPops, onEvent: onPropEvent });
//   // pods register themselves with entities.js's HEAD_HITS; call clearHeadHits() before a rebuild.
//   // per frame:  props.update(dt, t, camera, player.group.position);
//
import * as THREE from 'three';
import { toonMat, addOutline, paintStates, canvasStates, linearColor, anchorToBase,
         makeProgressBar, glowTexture, RewardPops } from './fx.js';
import { COLLIDERS, groundHeight, groundOnly, slopeAt, inExclusion, scatter, reachable } from './world.js';
import { registerHeadHit, PLAYER_H } from './entities.js';
import { mulberry32, deriveSeed } from './rng.js';
import { mergeGeos } from './rockgen.js';

const TAU = Math.PI*2;
const clamp01 = (v)=> v < 0 ? 0 : v > 1 ? 1 : v;
// quintic ease-out. A lid is heavy: it should leave fast and settle slow, and a quintic is the
// cheapest curve that reads as weight rather than as a tween.
const easeOutQuint = (t)=> 1 - Math.pow(1-t, 5);
const smooth = (t)=> t*t*(3-2*t);

// Derived, never authored. entities.js keeps JUMP_VY private but exports PLAYER_H, so this is the
// closest this file can get to the real number — and importing PLAYER_H means a retune over there
// shows up here as a moved pod instead of as an item that silently stopped working.
const JUMP_APEX = 11*11/(2*30);              // JUMP_VY^2 / 2g, entities.js:29-30
export const HEAD_APEX = JUMP_APEX + PLAYER_H;   // 4.57 m: how high the crown gets from flat ground

/* ================================================================================
   knobs. One flat object, same convention as world.js's PARAMS, so item 10's dev
   panel can write into it without knowing anything about this file's internals.
   ================================================================================ */
export const PROP_PARAMS = {
  /* --- item 11: spore pods --- */
  // THE reachability constraint. A standing jump is JUMP_VY 11 against gravity 30, so the feet
  // rise 11^2/(2*30) = 2.02 m; add PLAYER_H 2.55 and the crown tops out 4.57 m over the ground it
  // left. podBotMin/Var must stay inside that or a pod becomes decoration. If entities.js ever
  // retunes JUMP_VY, these two numbers are what stops the whole item from silently going dead.
  podBotMin: 3.45, podBotVar: 0.62,   // metres above the ground the pod hovers over
  podClusters: 7, podPerMin: 1, podPerVar: 3,   // 1-3 pods per cluster
  podStep: 2.35,                    // spacing along the cluster heading
  podR: 0.66,                       // visual radius of the BULB; the corolla reaches ~1.5x this
  // Still under the widest point of the flower, but no longer under the bulb: item 03 grew a
  // corolla, and a hit disc narrower than the thing you are aiming at turns clean-looking hits
  // into misses. If PETAL.out/len change, this changes with them — see the note on PETAL.
  podHitR: 0.76,
  podColR: 0.5,                      // collider radius — narrower again, so a pod never feels sticky
  podSlope: 0.85, podPad: 1.6, podClear: 1.7,
  podMinH: -3.0,                     // never over the ravine void even if exclusion misses
  podEdgeBand: 9,                    // "just outside an exclusion" band — ravine lips, site rims
  podAnchorR: 30,                    // how close to a landmark counts as an interesting arc
  podBias: 0.6,                      // fraction of clusters that must land somewhere interesting
  podChargeChance: 0.28,             // pods worth returning to
  podChargeMin: 2, podChargeVar: 2,  // 2-3 hits
  podRichChance: 0.12, podRichMult: 10,
  podCoinMin: 6, podCoinVar: 6,
  podBob: 0.14, podBobRate: 1.7, podSway: 0.11, podSwayRate: 0.9,
  podKick: 0.85,                     // metres the pod jumps up on a hit
  podBumpT: 0.34,                    // seconds of the kick arc
  podCool: 0.28,                     // lockout after a hit, so one rise can't pay twice

  /* --- item 13: vents --- */
  ventCount: 4, ventMinDist: 62, ventSlope: 0.5, ventPad: 4, ventClear: 3.2,
  // A vent you just stepped out of is a free trip back, which makes a two-vent hop into an
  // infinite one and turns the shortcut into a way to farm arrival cues. 15 s is long enough that
  // going back is a decision and short enough that a mistaken trip is not a punishment.
  ventCool: 15,
  // height stays under entities.js's STEP (1.5) so an unused vent is a kerb you walk over
  // rather than a knee-high wall you have to jump — a shortcut must never be an obstacle.
  ventH: 1.44, ventLipR: 1.78, ventThroatR: 1.24, ventThroatDepth: 1.05,
  ventReach: 1.75,                   // how close to the axis counts as standing on it
  ventBandAngle: 2.35,               // the island's fixed highlight angle, in WORLD space
  ventBandWidth: 1.05, ventBandAmt: 0.34, ventBandShadow: 0.24,

  /* --- item 14: sealed chests --- */
  chestCrusted: 4, chestIronbound: 2, chestElderChance: 0.75,   // at most one elder per world
  chestSlope: 0.6, chestPad: 2.5, chestClear: 2.2, chestMinDist: 26,
  chestReach: 3.4,                    // interaction radius
  chestOpenT: 0.72,                   // lid swing duration
  chestLidRot: -1.95,                 // radians, open
  chestShakeT: 0.3, chestShakeAmp: 0.11, chestShakeRate: 46,

  /* --- item 18: guaranteed treasure --- */
  treasureCount: 4, treasureRing: 2.6,   // > 2x treasureReach, or touching one collects its neighbour
  treasureCoinMin: 55, treasureCoinVar: 40,
  treasureBob: 0.28, treasureBobRate: 1.15, treasureSpin: 0.75,
  treasureReach: 1.55, treasureLift: 1.15,
};

/* ================================================================================
   palettes. Deliberately NOT the island's stone/grass ramps: a prop that pays has to
   read as manufactured against a world made of dirt and fungus, so these are all
   saturated bio-plastics with one warm accent.
   ================================================================================ */
const PAL = {
  pod:      { skin:'#7be0b0', deep:'#1f6f5c', crack:'#123a33', glow:0x2fbf8a },
  podRich:  { skin:'#ffd86b', deep:'#b06a12', crack:'#4a2a06', glow:0xffab24 },
  podSpent: { skin:'#8d8a86', deep:'#3a3733', crack:'#191614', glow:0x000000 },
  chest: {
    crusted:   { body:'#a58b6a', band:0x6e5a43, plate:0xc9a86a, glow:0xffd79a },
    ironbound: { body:'#7d8ea8', band:0x2f3a4e, plate:0xa8c4e0, glow:0xbfe4ff },
    elder:     { body:'#8f6aa8', band:0x3a2450, plate:0xd8a8ff, glow:0xe0b0ff },
  },
  // Only the throat is allowed to be near-black — that IS the hole. Every other vent colour now
  // lives in VENT_FAMILIES; see the note there for why the body can never go dark.
  vent:     { throat:0x0d1620 },
  // core is deliberately SATURATED, not icy: it is the only prop whose whole job is "this is
  // worth the climb", and a pale cyan reads as ice, which is scenery. Ice is free; gems are not.
  treasure: { core:0x2fb0e0, deep:0x1c5f80, glow:0x8fe8ff },
};

/* item 09 — the three vent families.

   TWO JOBS, and the second is the one that decides the colours. First, a vent has to read as
   manufactured plumbing against a world of dirt and fungus. Second, and this is what pairs are
   for (see the pairing note in the build): THE COLOUR IS THE DESTINATION. Two violet vents are
   the two ends of one trip, so the family has to be identifiable at 60 m and from any angle,
   which rules out three tints of the same hue — these are violet / orange / green precisely
   because no two of them can be confused in peripheral vision.

   Every `body` sits WELL clear of the ink hull's 0x1c1410. A dark body merges with its own
   outline into one black mass and the vent stops reading as a prop with a hole in it and starts
   reading as a hole in the world — which is the exact failure the pale blue original existed to
   avoid, and the reason none of these three is allowed to go moody. */
const VENT_FAMILIES = [
  { id:'violet', name:'Violet', body:0x9a6ad4, lip:0xe8d4ff },
  { id:'ember',  name:'Ember',  body:0xd98a44, lip:0xffe2b4 },
  { id:'verdant',name:'Verdant',body:0x62bd64, lip:0xd6ffca },
];
/* Family assignment has to be decided BEFORE the build loop, because the colour is baked into the
   vertex colours pre-merge, and it has to agree with the pairing rule exactly — a violet vent
   whose partner is orange is worse than no colour-coding at all, because it teaches the wrong
   thing. So both this and the pairing below read the same shape off one number: n. */
function ventFamilies(n){
  const out = new Array(n);
  let f = 0;
  for(let i=0;i+1<n;i+=2){ out[i] = out[i+1] = f % VENT_FAMILIES.length; f++; }
  if(n % 2 === 1) out[n-1] = n === 1 ? 0 : out[n-3];   // the odd vent joins the last trio's colour
  return out;
}

/* ================================================================================
   local geometry helpers
   ================================================================================ */

// Fixed-angle painted highlight BAND, written into vertex colours.
// Two things separate this from fx.js's shade(): the falloff is a band with an edge rather than a
// cosine (a band reads as drawn, a cosine reads as lit), and the caller is expected to have
// already baked any yaw into the geometry — see bakeYaw() for why that ordering is not optional.
function bandShade(geo, opts={}){
  const angle  = opts.angle  ?? PROP_PARAMS.ventBandAngle;
  const width  = opts.width  ?? 1.05;
  const amount = opts.amount ?? 0.36;
  const shadow = opts.shadow ?? 0.28;
  const ao     = opts.ao     ?? 0;
  const belly  = opts.belly  ?? 0;     // extra brightening toward the LOWEST vertices
  const base   = linearColor(opts.color ?? 0xffffff);   // shared + frozen: read only
  const pos = geo.attributes.position;
  geo.computeBoundingBox();
  const bb = geo.boundingBox, spanY = Math.max(1e-6, bb.max.y - bb.min.y);
  const col = new Float32Array(pos.count*3);
  for(let i=0;i<pos.count;i++){
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    let d = Math.atan2(z, x) - angle;
    d = d - TAU*Math.floor((d + Math.PI)/TAU);      // wrap to [-PI, PI)
    const a = Math.abs(d);
    let f = a < width ? 1 + amount*smooth(1 - a/width)
                      : 1 - shadow*smooth(Math.min(1, (a-width)/(Math.PI-width)));
    const yn = (y - bb.min.y)/spanY;
    if(ao > 0) f *= 1 - ao*(1-yn);
    if(belly > 0) f *= 1 + belly*Math.pow(1-yn, 2.5);
    col[i*3] = base.r*f; col[i*3+1] = base.g*f; col[i*3+2] = base.b*f;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

// INVARIANT (the bug this exists to prevent): bake the yaw into the VERTICES, then shade.
// The highlight angle is fixed in world space, so if you shade first and yaw the mesh afterwards
// every vent ends up catching light from a different direction and the "hand-drawn" read
// collapses into "randomly lit". rockgen hit exactly this and documented it; the fix is ordering,
// not maths. The mesh must then carry NO rotation.y of its own.
function bakeYaw(geo, yaw){ if(yaw) geo.rotateY(yaw); return geo; }

// mergeGeos() concatenates attributes with no index, so every input must be non-indexed first.
// CONTRACT: `g` is a geometry the caller just built and is handing over; this disposes it and
// returns one we own outright.
// The clone branch is not paranoia. `toNonIndexed()` returns **`this`** when the geometry already
// has no index — which is every PolyhedronGeometry, i.e. every Octahedron here — so without it the
// "copy" we go on to translate/scale IS the input. Feed it a geometry shared between instances and
// each instance bakes its own transform into the shared source, compounding as you go. Same class
// of bug as disposing a shared geometry, in transform form rather than lifetime form.
function nonIndexed(g){
  const own = g.index ? g.toNonIndexed() : g.clone();
  g.dispose();
  return own;
}

// a pod: lathe profile, bottom-up, so the belly brightening in bandShade lands on the underside
function podBodyGeo(r, h){
  const pts = [];
  // the flange at 0.26 h is the GILL RIM: it is the part the head hits, so the silhouette says so
  // from any angle. Without it a lathe pod is an egg, and an egg does not read as "hit me here".
  const prof = [[0.00,0.00],[0.28,0.02],[0.52,0.09],[0.70,0.18],[1.02,0.25],[0.84,0.33],
                [0.99,0.52],[0.92,0.70],[0.73,0.85],[0.44,0.95],[0.20,1.02],[0.11,1.14],
                [0.06,1.26],[0.00,1.28]];
  for(const p of prof) pts.push(new THREE.Vector2(p[0]*r, p[1]*h));
  const g = new THREE.LatheGeometry(pts, 12);
  return anchorToBase(g).geo;
}

/* --- the corolla (item 03). A ring of petals grown off the gill rim, plus a stamen crown. ---

   WHY A FLOWER AND NOT JUST A PRETTIER POD: the pod is the only prop in the game you can reach by
   ONE route — jumping into it from underneath — and the old egg silhouette said nothing about
   that. Petals splayed BELOW the horizontal are the affordance: the face you are meant to hit is
   the face the flower opens toward, so the thing looks, from the only angle you ever approach it
   at, like a target. Read from above it is still a pod, which is what keeps it legible as one
   object in a clearing full of them.

   THE CONSTRAINT THE PETALS MUST NOT BREAK: `petalOut` is bounded by podHitR, not the reverse. A
   corolla wider than the head-hit disc turns every clean-looking miss into a bug report, so if
   you widen the flower you widen podHitR in the same commit or you have made the prop lie. */
const PETAL = {
  n: 6,               // odd counts read as a pinwheel from directly below; 6 reads as a flower
  yFrac: 0.27,        // AT the gill flange (prof peak 1.02 @ 0.25h) — the petals grow out of the rim
  tilt: 0.46,         // radians below horizontal. Enough that the corolla is visible from beneath
  out: 0.56,          // how far the petal root sits from the axis, as a fraction of pod radius
  // Reach is out + len*cos(tilt) = 1.56 pod radii = 1.03 m, so a flower is ~2.1 m across against
  // a podStep of 2.35 m. THAT is the ceiling on len: any longer and the pods in a cluster grow
  // into each other and a row of flowers becomes one hedge.
  len: 1.12, wide: 0.68, thick: 0.22,   // all fractions of pod radius
  /* Deeper than the pink you actually want to SEE, deliberately. The shared material adds its
     mint emissive (0x2fbf8a at 0.42) FLAT to every fragment, petals included, and then ACES at
     exposure 1.28 lifts the result again — a pale rose here arrives on screen as off-white. The
     tint has to be authored below the target so the emissive can add its way up to it. This is
     the same "solve for the composite, not the swatch" rule the palette's contrast floors follow. */
  tint: 0xe64c86,
  stamens: 5, stamenR: 0.095, stamenY: 0.99, stamenOut: 0.13, stamenTint: 0xffe08a,
};
// the reserved white corner of every pod texture, and the single UV every petal vertex is pinned
// to. Centre of the patch, not its edge: a UV on the boundary samples the pod's paint under
// linear filtering. See the note where the patch is drawn.
// v is size/2, NOT 1 - size/2, and that is not a typo. Three.js textures default to flipY:true,
// so canvas row 0 (the top) is v = 1 and the patch drawn at the canvas BOTTOM-right lands at low
// v. Pointing at 1 - size/2 samples the top of the sheet instead — which is the pod's own dark
// gradient stop, and is exactly why the first attempt produced pale grey-green petals.
const PETAL_UV = { size: 0.125, u: 1 - 0.125/2, v: 0.125/2 };
function pinUV(geo, u, v){
  const uv = geo.attributes.uv;
  if(!uv) return geo;
  for(let i=0;i<uv.count;i++) uv.setXY(i, u, v);
  uv.needsUpdate = true;
  return geo;
}
// one petal blade, lathed then flattened: a teardrop of revolution squashed on one axis is a
// petal, and it costs 5 profile points instead of hand-authored triangles.
const PETAL_PROFILE = [[0.02,0.00],[0.34,0.15],[0.50,0.42],[0.40,0.72],[0.19,0.91],[0.00,1.00]];
function petalBlade(r){
  const pts = [];
  for(const q of PETAL_PROFILE) pts.push(new THREE.Vector2(q[0]*PETAL.wide*r, q[1]*PETAL.len*r));
  const g = nonIndexed(new THREE.LatheGeometry(pts, 6));
  g.scale(1, 1, PETAL.thick/PETAL.wide);        // flatten across the blade: revolution -> petal
  // the lathe grows along +Y; lay it over so it grows along +Z, then drop the tip below level
  g.rotateX(Math.PI/2 + PETAL.tilt);
  return g;
}
function flowerPodGeo(r, h){
  const parts = [];
  parts.push(bandShade(nonIndexed(podBodyGeo(r, h)), {
    color:0xffffff, amount:0.30, shadow:0.24, width:1.15,
    belly:0.85,                     // the underside is the part that pays, so it is the part that glows
    ao:0.10 }));
  for(let i=0;i<PETAL.n;i++){
    const a = (i/PETAL.n)*TAU;
    const blade = pinUV(petalBlade(r), PETAL_UV.u, PETAL_UV.v);
    blade.translate(0, h*PETAL.yFrac, r*PETAL.out);
    blade.rotateY(a);
    // shaded in its own tint BEFORE the merge, for the same reason the chest's plate is: after
    // the merge there is one colour attribute and no way to tell the parts apart again.
    // belly brightens toward a part's LOWEST vertices and bandShade recomputes the bounding box
    // PER PART, so a lone petal's own tip is its own y-min. At belly 1.15 that made f up to 2.15,
    // multiplied again by amount — the tint blew straight past 1.0 and every petal clipped to
    // white. 0.30 is the most that keeps the corolla's underside lit rather than blown out.
    parts.push(bandShade(blade, { color: PETAL.tint, amount:0.26, shadow:0.20, belly:0.30 }));
  }
  for(let i=0;i<PETAL.stamens;i++){
    const a = (i/PETAL.stamens)*TAU + 0.31;
    const dot = pinUV(nonIndexed(new THREE.SphereGeometry(PETAL.stamenR*r, 6, 4)),
      PETAL_UV.u, PETAL_UV.v);
    dot.translate(Math.cos(a)*r*PETAL.stamenOut, h*PETAL.stamenY, Math.sin(a)*r*PETAL.stamenOut);
    parts.push(bandShade(dot, { color: PETAL.stamenTint, amount:0.20, shadow:0.10 }));
  }
  return mergeGeos(parts);
}

/* a faceted crystal cluster: four shards of falling height leaning off a shared base, merged so
   the whole cluster is ONE mesh. Emissive only — item 18's crystals spawn and despawn, and the
   README rule is that nothing which does that gets a real PointLight.

   INVARIANT (the bug this exists to prevent): a shard is ONE continuously tapering spire, never a
   prism with a cone on top. A constant-radius body plus a tall nose cone plus short flared
   satellites round the foot is not a gem — it is a ROCKET, which is exactly what the previous
   build read as: straight tube, nose cone, engine skirt. Three rules keep the silhouette a gem:
     - every ring in the profile CHANGES radius, so there is no cylindrical section to read as a
       fuselage. The widest ring sits low (the "belt"), which is what makes a shard look grown
       rather than machined;
     - the apex is pushed OFF-AXIS, so the termination reads as a cut face instead of a nose;
     - no shard stands vertical, and the satellites are slender-and-tall rather than stubby-and-
       flared, because a fat flared cone at the foot of a tall point is a fin.
   Facet count is the other half of the read: an octahedron only ever shows two plates to the
   camera, so the rim highlight covers the whole silhouette at once and a "gem" flattens into cut
   paper. Five or six vertical facets, jittered so no two are the same width, put the toon bands
   and the rim on different plates — that is what makes it look cut. */

/* [yFrac, radiusFrac], bottom to top; the apex is implied at yFrac 1. Two rules:
   - radiusFrac must never repeat twice in a row — a repeat IS a cylinder;
   - keep the ring COUNT low. Rings are where the silhouette can bend, so four of them curve the
     outline and the shard turns into a teardrop; three leave three tall bands of flat facets and
     two hard slope changes, which is what reads as cut stone. The termination slope is steeper
     than the body slope on purpose — that shoulder is the whole difference between a crystal
     terminating and a cone coming to a point. */
const SHARD_PROFILE = [[0.00, 0.34], [0.26, 1.00], [0.66, 0.58]];

function shardGeo(rng, sides, r, h){
  // the jitter is rolled ONCE per shard and reused by every ring, so a facet stays a single flat
  // plane all the way up. Roll it per ring instead and the shard turns into a crumpled sack.
  const jr = [], ja = [];
  for(let i=0;i<sides;i++){ jr.push(0.74 + rng()*0.52); ja.push((rng()-0.5)*0.26); }
  const rings = [];
  for(const [yf, rf] of SHARD_PROFILE){
    const ring = [];
    for(let i=0;i<sides;i++){
      const a = (i/sides)*TAU + ja[i], rr = r*rf*jr[i];
      ring.push([Math.cos(a)*rr, yf*h, Math.sin(a)*rr]);
    }
    rings.push(ring);
  }
  const aa = rng()*TAU, ad = r*0.20*rng();
  const apex = [Math.cos(aa)*ad, h, Math.sin(aa)*ad];
  const foot = [0, 0, 0];                    // closed: the crystal floats, so its underside is on camera
  const v = [];
  const tri = (a, b, c)=>{ v.push(a[0],a[1],a[2], b[0],b[1],b[2], c[0],c[1],c[2]); };
  // winding is outward-facing (verified against the cross product, not guessed): get it backwards
  // and every facet lights from behind while the ink hull covers the front.
  for(let k=0;k<rings.length-1;k++){
    const lo = rings[k], hi = rings[k+1];
    for(let i=0;i<sides;i++){
      const j = (i+1)%sides;
      tri(lo[i], hi[j], lo[j]); tri(lo[i], hi[i], hi[j]);
    }
  }
  const top = rings[rings.length-1];
  for(let i=0;i<sides;i++) tri(top[i], apex, top[(i+1)%sides]);
  for(let i=0;i<sides;i++) tri(foot, rings[0][i], rings[0][(i+1)%sides]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;                                  // non-indexed already; mergeGeos needs it that way
}

/* Proportions are the whole silhouette, and two of these numbers are the ones that were wrong.
   ASPECT: a shard is at most ~3.5x as tall as it is wide. Past about 4:1 a tapering spire stops
   being a crystal and becomes a missile no matter how it is faceted.
   HEIGHT SPREAD: the second shard is ~78% of the first, not 30%. Small shards round the foot of
   one dominant point are FINS; two shards of comparable height leaning opposite ways are a
   cluster. The tilts grow as the shards shrink so the little ones splay outward like a druse
   instead of standing to attention beside the big one. */
const CRYSTAL_SHARDS = [
  { sides:6, r:0.52, h:1.62, tilt:0.17, d:0.05 },
  { sides:6, r:0.42, h:1.26, tilt:0.42, d:0.34 },
  { sides:5, r:0.33, h:0.92, tilt:0.70, d:0.42 },
  { sides:5, r:0.25, h:0.58, tilt:1.00, d:0.46 },
];

/* Treasure-glow tuning. MODULE scope, not the build block: update() reads the same numbers, and
   a glow whose size is set in one place and ramped in another is a glow that drifts. */
const HALO_R = 1.55;         // world half-size, and the ONE number that decides whether the glow
                             // reads. It has to be much wider than the cluster (~0.65 m of
                             // radius), because the texture's bright core sits behind the gem: the
                             // wider the quad, the higher up the falloff the gem's edge lands, so
                             // width and apparent brightness are the same dial. Past ~1.8 the
                             // fringe reaches the ground and it goes back to being a pale disc.
const HALO_ASPECT = 1.12;    // the cluster is taller than it is wide, so its light is too
/* Opacity is the CORE of the falloff, and the core is behind the gem — which is why this number
   looks reckless and is not. The texture is at alpha ~0.22 where the gem's silhouette ends, so
   what the eye actually receives outside the gem is 0.72*0.22 ~ 0.16 of a pale cyan: a bloom, not
   a wash. Tuned by measurement, not by taste: at 0.42 the glow was invisible in a mid shot, which
   is how a treasure stops reading as treasure. The core can only clip if the gem gets narrower
   than the texture core (0.29 m of radius) at HALO_Y, and no shard in CRYSTAL_SHARDS does. */
const HALO_OP = 0.72;
const HALO_OP_HOT = 1.00;    // hover: obviously hotter, and the exposed shoulder still lands ~0.22
const HALO_Y = 0.86;         // up the crystal, not at its foot — the light comes from the body
/* The ramps are the actual size cap. Below HALO_NEAR_OFF the glow is gone, so no camera position
   can make it fill the frame; past HALO_FAR_START it fades out, because a treasure you cannot
   resolve does not need a draw call. NEAR_FULL sits under CAM_DIST_MIN (4.2 m, main.js), so normal
   play never sees the near ramp at all — it only catches a lens clipped into the prop. */
const HALO_NEAR_OFF = 1.1, HALO_NEAR_FULL = 3.2;
const HALO_FAR_START = 90, HALO_FAR_OFF = 120;

function crystalGeo(rng){
  const parts = [];
  const a0 = rng()*TAU;
  for(let i=0;i<CRYSTAL_SHARDS.length;i++){
    const s = CRYSTAL_SHARDS[i];
    const g = shardGeo(rng, s.sides, s.r*(0.90 + rng()*0.20), s.h*(0.90 + rng()*0.20));
    // fan the shards round the axis instead of stacking them on one side: a cluster that leans
    // all one way reads as a single broken spike, not as several crystals sharing a base.
    const a = a0 + (i/CRYSTAL_SHARDS.length)*TAU + rng()*0.5;
    const t = s.tilt*(0.7 + rng()*0.6);
    g.rotateZ(Math.cos(a)*t); g.rotateX(-Math.sin(a)*t);     // lean away from the main spire
    const d = s.d*(0.7 + rng()*0.6);
    g.translate(Math.cos(a)*d, 0, Math.sin(a)*d);            // bases stay level, so they share one
    parts.push(g);
  }
  const geo = mergeGeos(parts);
  geo.computeVertexNormals();                // non-indexed, so this gives FLAT per-facet normals
  return anchorToBase(geo).geo;
}

/* ================================================================================
   textures. Every state a prop can be in is baked at build time (item 37): the runtime
   state change is one material reference swap, never canvas work at the moment it flips.
   ================================================================================ */

// 3 wear stages for a pod: fresh, cracked (been hit, still has charges), husk (spent).
// The middle stage is the whole reason charges are legible — a cracked pod tells you from across
// the clearing that it still owes you something.
function podTextures(rng, pal){
  return canvasStates(3, (g, s, i, t)=>{
    const grad = g.createLinearGradient(0, 0, 0, s);
    grad.addColorStop(0, pal.deep); grad.addColorStop(0.45, pal.skin); grad.addColorStop(1, pal.deep);
    g.fillStyle = grad; g.fillRect(0, 0, s, s);
    // painterly dabs, then vertical ribs so the lathe reads as a seed pod rather than a ball
    for(let k=0;k<180;k++){
      const x = rng()*s, y = rng()*s, r = 2 + rng()*7;
      g.fillStyle = rng() < 0.5 ? pal.skin : pal.deep;
      g.globalAlpha = 0.07 + rng()*0.12;
      g.beginPath(); g.ellipse(x, y, r, r*0.55, rng()*Math.PI, 0, 7); g.fill();
    }
    g.globalAlpha = 0.30; g.strokeStyle = pal.deep; g.lineWidth = 2;
    for(let k=0;k<8;k++){ const x = (k+0.5)*s/8; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, s); g.stroke(); }
    g.globalAlpha = 1;
    // cracks scale with the wear stage: `t` is 0..1 across the states, so one number drives it
    const cracks = Math.round(t*13);
    g.strokeStyle = pal.crack; g.lineWidth = 1.6 + t*1.6;
    for(let k=0;k<cracks;k++){
      let x = rng()*s, y = rng()*s;
      g.beginPath(); g.moveTo(x, y);
      for(let j=0;j<4;j++){ x += (rng()-0.5)*s*0.22; y += (rng()-0.5)*s*0.22; g.lineTo(x, y); }
      g.stroke();
    }
    if(i === 2){                                     // husk: drained, grey, holed
      g.globalAlpha = 0.55; g.fillStyle = '#4a4744'; g.fillRect(0, 0, s, s); g.globalAlpha = 1;
      g.fillStyle = pal.crack;
      for(let k=0;k<5;k++){
        const x = rng()*s, y = rng()*s, r = 6 + rng()*10;
        g.beginPath(); g.ellipse(x, y, r, r*0.7, rng()*3, 0, 7); g.fill();
      }
    }
    /* THE NEUTRAL PATCH — item 03's petals depend on it and it is the last thing drawn on purpose.
       MeshToonMaterial multiplies color * map * vertexColor, so a petal sharing the pod's material
       ALSO samples the pod's texture, and mint-green paint times a pink vertex colour is a dull
       grey-green: measured (0.20,0.75,0.44) x (1.00,0.48,0.66) = (0.20,0.36,0.29). The corolla
       came out as a colourless frill for exactly this reason.
       Reserving one white corner and pinning every petal UV to its CENTRE makes the map
       contribute ~1.0 there, which hands the petal's hue back to its vertex colours — and keeps
       the whole flower on ONE mesh with ONE material, which is the point. The patch is a fat
       16/128 of the sheet so the first few mip levels still resolve white rather than bleeding the
       pod's paint into the petals at distance. Every wear state gets it: a husk's petals are grey
       because their vertex colours say so, not because the atlas forgot. */
    g.globalAlpha = 1; g.fillStyle = '#ffffff';
    g.fillRect(s - s*PETAL_UV.size, s - s*PETAL_UV.size, s*PETAL_UV.size, s*PETAL_UV.size);
  }, 128);
}

/* ================================================================================
   build
   ================================================================================ */

/**
 * buildProps(scene, rng, world, opts) -> propsHandle
 *
 * scene  THREE.Scene (or any Object3D) the prop root is added to.
 * rng    seeded stream from mulberry32 — EVERY placement and every rolled value comes from here,
 *        so a seed rebuilds identical props. Math.random() is never called for either.
 * world  the object returned by buildWorld(). Read defensively: this module lands whether or not
 *        the terrain wave has finished exposing authored-site positions (see item 18 below).
 * opts   { progress, pops, parent, onEvent, registerHeadHit, quality,
 *          podClusters, ventCount, treasureCount, grantCoins }
 */
export function buildProps(scene, rng, world = {}, opts = {}){
  const P = PROP_PARAMS;
  const parent = opts.parent || scene;
  const progress = opts.progress || null;
  const onEvent = opts.onEvent || null;
  // texture/appearance rolls run on their OWN stream, so adding a dab or a crack stage cannot
  // shift the placement stream and move every prop in the world.
  const look = mulberry32(deriveSeed((world.seed|0) || 1, 0x70d5));

  const root = new THREE.Group();
  root.name = 'props';
  parent.add(root);

  // shared resources: one entry per thing THIS module allocated, disposed by dispose() and
  // nothing else. Sharing is the perf rule; the list is what makes sharing safe to tear down.
  const own = { geo: [], mat: [], tex: [], misc: [] };
  const keepGeo = (g)=>{ own.geo.push(g); return g; };
  const keepMat = (m)=>{ own.mat.push(m); return m; };
  const keepTex = (t)=>{ own.tex.push(t); return t; };

  // a mesh whose geometry/material came from the shared pool owns NEITHER. Marking them false is
  // not redundant: a future teardown that disposed a shared geometry would empty every prop that
  // references it AND every prop built afterwards from the same source.
  function shared(mesh){ mesh.userData.ownGeo = false; mesh.userData.ownMat = false; return mesh; }
  function ownsGeo(mesh){ mesh.userData.ownGeo = true; mesh.userData.ownMat = false; return mesh; }

  const pops = opts.pops || new RewardPops(scene, { parent: root });
  const popsOwned = !opts.pops;

  const colliders = [];     // the ones WE pushed, so dispose() can retire exactly those
  function pushCollider(x, z, r, bot, top){
    const c = { x, z, r, bot, top };
    COLLIDERS.push(c); colliders.push(c);
    return c;
  }
  // the placement half of item 01, local copy: world.js keeps clearOf() private, and a predicate
  // that does not read the FINISHED collider list is how a prop ends up inside a rock.
  function clearOf(x, z, pad){
    for(let i=0;i<COLLIDERS.length;i++){
      const c = COLLIDERS[i];
      if(c.off) continue;
      const dx = x-c.x, dz = z-c.z, rr = c.r + pad;
      if(dx*dx + dz*dz < rr*rr) return false;
    }
    return true;
  }
  // the same question in 3D, for the hover band: a pod may stand over open ground and still be
  // buried in the flank of a spire two metres up.
  function bandFree(x, z, pad, bot, top){
    for(let i=0;i<COLLIDERS.length;i++){
      const c = COLLIDERS[i];
      if(c.off) continue;
      const dx = x-c.x, dz = z-c.z, rr = c.r + pad;
      if(dx*dx + dz*dz > rr*rr) continue;
      if(c.top > bot && c.bot < top) return false;
    }
    return true;
  }

  const events = [];   // every event also lands here, so a caller without onEvent can drain it

  function emit(ev){
    events.push(ev);
    if(events.length > 64) events.shift();
    if(onEvent) onEvent(ev);
    return ev;
  }
  function grantCoins(n){
    if(!n) return 0;
    if(opts.grantCoins) return opts.grantCoins(n) || n;
    // progress.js has no addCoins(); `coins += n; saveCoins()` is the established pattern at
    // main.js:552 and inside progress.js itself, and progress stays the only file touching
    // localStorage either way.
    if(progress){ progress.coins += n; if(progress.saveCoins) progress.saveCoins(); }
    return n;
  }

  /* ---- interest anchors: what makes a jump arc worth aiming at ----
     Read defensively. Every one of these fields is optional and set by a different wave; a world
     with none of them still gets props, just without the bias. */
  const anchors = [];
  function pushAnchor(v){
    if(!v) return;
    if(Array.isArray(v)){ for(const e of v) pushAnchor(e); return; }
    const p = v.isObject3D ? v.position : v;
    if(p && Number.isFinite(p.x) && Number.isFinite(p.z)) anchors.push({ x:p.x, z:p.z });
  }
  pushAnchor(world.sites); pushAnchor(world.motherShroom); pushAnchor(world.pondPos);
  pushAnchor(world.geysers); pushAnchor(world.caveSpots); pushAnchor(world.spawnPoint);
  function nearAnchor(x, z, r){
    const r2 = r*r;
    for(let i=0;i<anchors.length;i++){
      const dx = x-anchors[i].x, dz = z-anchors[i].z;
      if(dx*dx + dz*dz < r2) return true;
    }
    return false;
  }
  // A ravine lip is a point that is legal to stand on but a couple of metres from somewhere that
  // is not. inExclusion() is the only exported view of the ravine, so read it at two clearances:
  // the difference between them IS the edge, without world.js having to publish RAVINE.
  function nearEdge(x, z, pad, band){
    return !inExclusion(x, z, pad) && inExclusion(x, z, band);
  }

  /* ================================ item 11 — spore pods ================================
     The money box, and the reason jumping has a job. Everything else in this file is a thing you
     walk to; a pod is the only prop you can only get by leaving the ground. */
  const pods = [];
  {
    // already band-shaded part-by-part inside flowerPodGeo — the petals and the stamens carry
    // their own tints, which is the whole reason the corolla can ride the pod's shared material.
    const geo = keepGeo(flowerPodGeo(P.podR, P.podR*1.9));
    // 2 kinds x 3 wear stages x 2 hover states = 12 shared materials, 6 shared textures.
    // Hover brightening is a material SWAP rather than a per-pod material, which is what keeps a
    // clearing full of pods at two draw calls each instead of one material compile each.
    const texFor = { normal: podTextures(look, PAL.pod), rich: podTextures(look, PAL.podRich) };
    for(const k in texFor) for(const t of texFor[k]) keepTex(t);
    const mats = {};
    for(const kind of ['normal','rich']){
      const pal = kind === 'rich' ? PAL.podRich : PAL.pod;
      mats[kind] = { plain: [], hot: [] };
      for(let s=0;s<3;s++){
        const spent = s === 2;
        const glow = spent ? 0x14100e : pal.glow;
        mats[kind].plain.push(keepMat(toonMat({ color:0xffffff, vertexColors:true,
          map: texFor[kind][s], emissive: glow, emissiveIntensity: spent ? 0.12 : 0.42,
          rim: spent ? 0.18 : 0.62, rimColor: spent ? 0x9a948c : 0xd8fff0 })));
        mats[kind].hot.push(keepMat(toonMat({ color:0xffffff, vertexColors:true,
          map: texFor[kind][s], emissive: glow, emissiveIntensity: spent ? 0.2 : 1.05,
          rim: spent ? 0.25 : 1.0, rimColor: 0xffffff })));
      }
    }

    // A pod hangs in the air, so "reachable" is a question about the GROUND UNDER IT: the jump
    // that pays it has to start from somewhere. podBotMin is already clamped against HEAD_APEX,
    // which proves the pod is within reach of the ground below it — reachable() is what proves
    // the player can stand on that ground in the first place.
    const podTest = (x, z)=>{
      const h = groundHeight(x, z);
      if(h < P.podMinH) return false;
      if(slopeAt(x, z) > P.podSlope) return false;
      if(inExclusion(x, z, P.podPad)) return false;
      if(!clearOf(x, z, P.podClear)) return false;
      if(!bandFree(x, z, P.podClear, h + P.podBotMin - 0.3, h + P.podBotMin + P.podBotVar + 1.8)) return false;
      return reachable(x, z);
    };
    // two passes: the interesting places first (ravine lips and landmark aprons, where the arc has
    // something to read against), then a plain top-up so a world with no ravine still gets pods.
    const want = opts.podClusters ?? P.podClusters;
    const biased = Math.round(want * P.podBias);
    const spots = scatter(rng, biased, 9, (x,z)=> podTest(x,z) &&
      (nearEdge(x, z, P.podPad, P.podEdgeBand) || nearAnchor(x, z, P.podAnchorR)));
    for(const s of scatter(rng, want - spots.length, 9, podTest)) spots.push(s);

    for(const s of spots){
      const heading = rng()*TAU, n = P.podPerMin + ((rng()*P.podPerVar)|0);
      for(let i=0;i<n;i++){
        const x = s.x + Math.cos(heading)*P.podStep*i, z = s.z + Math.sin(heading)*P.podStep*i;
        if(i > 0 && !podTest(x, z)) break;           // the cluster stops where the ground stops
        const gh = groundHeight(x, z);
        // the roll is clamped against HEAD_APEX, not just authored under it: a pod out of reach is
        // not a hard pod, it is a bug the player cannot tell apart from bad aim.
        const bot = gh + Math.min(P.podBotMin + rng()*P.podBotVar, HEAD_APEX - 0.4);
        const rich = rng() < P.podRichChance;
        const charged = rng() < P.podChargeChance;
        const pod = {
          type:'pod', x, z, groundY: gh,
          bot, restY: bot,                          // mesh origin sits at the pod's own base (anchorToBase)
          r: P.podHitR, kind: rich ? 'rich' : 'normal',
          mult: rich ? P.podRichMult : 1,
          coins: Math.round((P.podCoinMin + rng()*P.podCoinVar)) * (rich ? P.podRichMult : 1),
          charges: charged ? P.podChargeMin + ((rng()*P.podChargeVar)|0) : 1,
          hits: 0, spent: false, stage: 0, hovered: false,
          bump: 0, cool: 0, phase: rng()*TAU, swayPhase: rng()*TAU,
          mesh: null, head: null, col: null,
        };
        pod.maxCharges = pod.charges;
        const mesh = shared(new THREE.Mesh(geo, mats[pod.kind].plain[0]));
        mesh.position.set(x, bot, z);
        mesh.rotation.y = rng()*TAU;
        mesh.castShadow = true;
        mesh.userData.prop = pod;
        addOutline(mesh, 0.045);
        root.add(mesh);
        pod.mesh = mesh;
        pod.mats = mats[pod.kind];
        // INVARIANT: the collider and the head-hit entry are pushed by the SAME loop that builds
        // the mesh, so a pod is solid from above and payable from below and the three can never
        // drift apart. bot/top are re-synced from the mesh every frame (see update) — a bobbing
        // silhouette with a static collision volume is exactly the drift this rule forbids.
        pod.col = pushCollider(x, z, P.podColR, bot - 0.12, bot + P.podR*1.9 + 0.12);
        // item 11's crossing test lives in entities.js's Player.headBonk() — the ONE place that
        // knows the crown's previous and current Y. This file only registers the plane and owns
        // what happens when it is crossed: `bot` is the underside, `onHead` is the payout.
        pod.head = { x, z, r: P.podHitR, bot, off: false, pod,
          onHead: (player, game)=> payPod(pod, game) };
        (opts.registerHeadHit || registerHeadHit)(pod.head);
        pods.push(pod);
      }
    }
  }

  // The single payout chokepoint for a pod, whichever side found the crossing.
  function payPod(pod, game){
    if(pod.spent || pod.cool > 0) return null;
    pod.cool = P.podCool;
    pod.bump = 1e-4;                            // starts the sin(bump*PI) kick arc
    pod.hits++;
    const coins = grantCoins(pod.coins);
    // PODS ARE WHERE LOCKPICKS COME FROM, SO SEALED CHESTS ALWAYS STAY REACHABLE. progress.js
    // owns the chance AND the pity streak — rolling our own here would double-count both.
    const lockpick = progress && progress.lockpickRoll ? progress.lockpickRoll('pod') : null;
    const y = pod.mesh.position.y;
    pops.pop(pod.x, y + 0.5, pod.z, pod.mult > 1 ? 5 : 2);
    if(pod.hits >= pod.charges) setPodSpent(pod);
    else setPodStage(pod, 1);                   // cracked: still owes you something, and shows it
    return emit({ type:'pod', pod, coins, mult: pod.mult,
      hits: pod.hits, charges: pod.charges, chargesLeft: Math.max(0, pod.charges - pod.hits),
      spent: pod.spent, lockpick, x: pod.x, y, z: pod.z,
      // entities.js has ALREADY clamped and bonked the player by the time onHead runs; these are
      // reported so the caller can size a camera kick or a sound to the same impact, not re-apply it.
      clampY: pod.head.bot, vy: -2, game: game || null });
  }
  function setPodStage(pod, stage){
    if(pod.stage === stage) return;
    pod.stage = stage;
    pod.mesh.material = (pod.hovered ? pod.mats.hot : pod.mats.plain)[stage];
  }
  function setPodSpent(pod){
    pod.spent = true;
    pod.head.off = true;                        // stops paying, permanently and legibly
    setPodStage(pod, 2);
  }

  /* ================================ item 13 — vents ================================
     The warp pipe. Geometry-wise the only interesting part is the throat: a dark disc reads as a
     painted spot, a short cylinder wound INWARD from the lip reads as a hole. */
  const vents = [];
  {
    // closed-ended and BackSide: you see the inside of the wall AND the inside of the bottom cap,
    // so the throat's own floor comes free instead of costing a second mesh per vent.
    const throatGeo = keepGeo(new THREE.CylinderGeometry(P.ventThroatR, P.ventThroatR*0.7,
      P.ventThroatDepth, 12, 1, false));
    const throatMat = keepMat(toonMat({ color: PAL.vent.throat, rim:0.12, rimColor:0x2a3a4a }));
    throatMat.side = THREE.BackSide;            // you are looking at the INSIDE of the throat wall
    const glowGeo = keepGeo(new THREE.RingGeometry(P.ventThroatR*0.92, P.ventLipR*0.94, 12));

    // one shared material for every vent shell: the per-vent difference is baked into the
    // vertex colours, which is the whole reason the highlight can be shared at all.
    const ventMat = keepMat(toonMat({ color:0xffffff, vertexColors:true, rim:0.5,
      rimColor:0xcfeeff, emissive:0x0a1c26, emissiveIntensity:0.3 }));
    // One glow material per family, not per vent: the family count is fixed at three, so this is
    // three compiles for the whole world however many vents a seed rolls.
    const famGlow = VENT_FAMILIES.map(f => keepMat(new THREE.MeshBasicMaterial({ color: f.lip,
      transparent:true, opacity:0.35, blending:THREE.AdditiveBlending, depthWrite:false })));

    // reachable() last, and for the same reason it is last in fauna.js: a vent is a door, and a
    // door on an unreachable shelf is not a shortcut, it is a taunt. It is also the only predicate
    // here that can trigger the one-off flood fill.
    const ventTest = (x, z)=> slopeAt(x, z) < P.ventSlope && !inExclusion(x, z, P.ventPad)
      && clearOf(x, z, P.ventClear) && reachable(x, z);
    const spots = scatter(rng, opts.ventCount ?? P.ventCount, P.ventMinDist, ventTest);
    const famIdx = ventFamilies(spots.length);

    for(let i=0;i<spots.length;i++){
      const s = spots[i], gy = groundHeight(s.x, s.z);
      const yaw = rng()*TAU;
      // tapered shaft + wider lip, merged into one fill mesh. Baked yaw, THEN the band — the
      // mesh carries no rotation of its own, which is what keeps every vent lit from one angle.
      // BOTH tubes are open-ended and the top face is an ANNULUS, not a cap. A capped lip seals
      // the hole shut and the vent reads as a bollard — the throat below it is then invisible and
      // the one thing the prop has to communicate ("you can go in here") is gone.
      const shaft = nonIndexed(new THREE.CylinderGeometry(P.ventLipR*0.86, P.ventLipR*1.02,
        P.ventH*0.78, 12, 1, true));
      shaft.translate(0, P.ventH*0.39, 0);
      const lip = nonIndexed(new THREE.CylinderGeometry(P.ventLipR, P.ventLipR*0.9, P.ventH*0.32, 12, 1, true));
      lip.translate(0, P.ventH*0.84, 0);
      const rim = nonIndexed(new THREE.RingGeometry(P.ventThroatR, P.ventLipR, 12));
      rim.rotateX(-Math.PI/2);
      rim.translate(0, P.ventH, 0);
      // item 09. The family is decided HERE, before the merge, because the colour lives in the
      // vertex colours — which is also what lets every vent in the world share one material.
      const fam = VENT_FAMILIES[famIdx[i]];
      const fill = bandShade(bakeYaw(mergeGeos([shaft, lip, rim]), yaw), {
        color: fam.body, angle: P.ventBandAngle, width: P.ventBandWidth,
        amount: P.ventBandAmt, shadow: P.ventBandShadow, ao: 0.14 });
      fill.computeVertexNormals();
      const mesh = ownsGeo(new THREE.Mesh(fill, ventMat));
      mesh.position.set(s.x, gy, s.z);
      mesh.castShadow = true;
      addOutline(mesh, 0.035);
      const throat = shared(new THREE.Mesh(throatGeo, throatMat));
      throat.position.y = P.ventH - P.ventThroatDepth*0.5 - 0.04;
      const glow = shared(new THREE.Mesh(glowGeo, famGlow[famIdx[i]]));
      glow.rotation.x = -Math.PI/2;
      glow.position.y = P.ventH - 0.02;
      mesh.add(throat, glow);
      root.add(mesh);
      const vent = { type:'vent', i, x: s.x, z: s.z, groundY: gy, topY: gy + P.ventH,
        r: P.ventLipR, mesh, glow, partner: null, aimAt: null, hovered: false,
        fam, cool: 0 };                      // cool > 0: arrived here recently, see travel()
      mesh.userData.prop = vent;
      // a vent is climbable geometry even when unused — and ventH stays under STEP so it is a kerb
      pushCollider(s.x, s.z, P.ventLipR*0.95, gy, gy + P.ventH);
      vents.push(vent);
    }
    /* PAIRS, not a ring — and the colour is the reason. A ring (0->1->2->3->0) gives every vent
       exactly one destination, which is all travel() needs, but it makes the trip unlearnable:
       the vent you arrive at is not the vent that takes you back, so no amount of colour-coding
       can tell you where a vent goes. Symmetric pairs mean "violet comes out at the other
       violet", and item 09's three families exist precisely so that sentence is readable at a
       glance. An ODD count still has to terminate somewhere, so the leftover joins the last pair
       as a 3-cycle: it is the one vent whose exit is not its entrance, and it shares its trio's
       colour so at least the SET is legible. */
    for(let i=0;i+1<vents.length;i+=2){
      vents[i].partner = vents[i+1];
      vents[i+1].partner = vents[i];
    }
    if(vents.length % 2 === 1){
      const odd = vents[vents.length-1];
      if(vents.length === 1) odd.partner = odd;         // degenerate world: a vent that goes nowhere
      else {
        const a = vents[vents.length-3], b = vents[vents.length-2];
        a.partner = b; b.partner = odd; odd.partner = a;
      }
    }
    // arrival aim: the nearest interest anchor to the DESTINATION, so main.js can turn the camera
    // toward something on arrival instead of leaving you facing wherever you happened to look.
    for(const v of vents){
      let best = null, bd = Infinity;
      for(const a of anchors){
        const dx = a.x - v.x, dz = a.z - v.z, d = dx*dx + dz*dz;
        if(d > 36 && d < bd){ bd = d; best = a; }
      }
      for(const o of vents){
        if(o === v) continue;
        const dx = o.x - v.x, dz = o.z - v.z, d = dx*dx + dz*dz;
        if(d < bd){ bd = d; best = { x:o.x, z:o.z }; }
      }
      v.aimAt = best ? { x: best.x, y: groundOnly(best.x, best.z) + 2, z: best.z } : null;
    }
  }

  /* ================================ item 14 — sealed chests ================================
     The published gamble. progress.js owns every number; this file owns the lid, the shake and
     the fact that the odds are on the label before you spend. */
  const chests = [];
  {
    const tierSpec = [
      { id:'crusted',   n: opts.chestCrusted ?? P.chestCrusted,   r:0.95, h:1.05, bands:4, eye:false },
      { id:'ironbound', n: opts.chestIronbound ?? P.chestIronbound, r:1.15, h:1.28, bands:6, eye:false },
      { id:'elder',     n: (rng() < P.chestElderChance) ? 1 : 0,  r:1.42, h:1.55, bands:8, eye:true },
    ];
    const kit = {};      // per-tier shared geometry + materials
    for(const spec of tierSpec){
      const pal = PAL.chest[spec.id];
      // body = lower hemisphere; bands = thin boxes at the corners + a ring at the seam;
      // lock plate rides on the front of the body. All merged: one fill mesh per half.
      // Each part is band-shaded in its OWN tint BEFORE the merge. That is what lets one mesh carry
      // a pale body, dark chitin bands, a metal plate and a black keyhole: after the merge there is
      // one colour attribute and no way to tell the parts apart again.
      const baseParts = [];
      const body = nonIndexed(new THREE.SphereGeometry(spec.r, 12, 6, 0, TAU, Math.PI*0.5, Math.PI*0.5));
      body.scale(1, spec.h/spec.r*0.92, 1);
      baseParts.push(bandShade(body, { color:0xffffff, amount:0.26, shadow:0.22, ao:0.3 }));
      const seam = nonIndexed(new THREE.TorusGeometry(spec.r*0.99, spec.r*0.075, 5, 14));
      seam.rotateX(Math.PI/2);
      baseParts.push(bandShade(seam, { color: pal.band, amount:0.3, shadow:0.2 }));
      for(let b=0;b<spec.bands;b++){
        const a = b/spec.bands*TAU;
        const band = nonIndexed(new THREE.BoxGeometry(spec.r*0.17, spec.h*0.92, spec.r*0.13));
        band.translate(0, -spec.h*0.46, spec.r*0.94);
        band.rotateY(a);
        baseParts.push(bandShade(band, { color: pal.band, amount:0.34, shadow:0.2 }));
      }
      const plate = nonIndexed(new THREE.BoxGeometry(spec.r*0.62, spec.h*0.46, spec.r*0.16));
      plate.translate(0, -spec.h*0.42, spec.r*0.93);
      baseParts.push(bandShade(plate, { color: pal.plate, amount:0.4, shadow:0.18 }));
      const keyhole = nonIndexed(new THREE.CylinderGeometry(spec.r*0.12, spec.r*0.1, spec.r*0.34, 8));
      keyhole.rotateX(Math.PI/2);
      keyhole.translate(0, -spec.h*0.4, spec.r*0.98);
      baseParts.push(bandShade(keyhole, { color:0x140d16, amount:0.1, shadow:0.05 }));
      const baseGeo = keepGeo(mergeGeos(baseParts));
      baseGeo.computeVertexNormals();
      // lid: upper hemisphere + its own band ring, translated so the pivot is the BACK rim.
      // Pivoting at the back rim is what makes the lid swing instead of spin about its middle.
      const lidParts = [];
      const dome = nonIndexed(new THREE.SphereGeometry(spec.r, 12, 6, 0, TAU, 0, Math.PI*0.52));
      dome.scale(1, spec.h/spec.r*0.7, 1);
      lidParts.push(bandShade(dome, { color:0xffffff, amount:0.3, shadow:0.2 }));
      for(let b=0;b<spec.bands;b++){
        const a = b/spec.bands*TAU;
        const band = nonIndexed(new THREE.BoxGeometry(spec.r*0.17, spec.h*0.42, spec.r*0.13));
        band.translate(0, spec.h*0.16, spec.r*0.9);
        band.rotateY(a);
        lidParts.push(bandShade(band, { color: pal.band, amount:0.34, shadow:0.2 }));
      }
      const lidGeo = keepGeo(mergeGeos(lidParts));
      lidGeo.computeVertexNormals();
      lidGeo.translate(0, 0, spec.r*0.9);          // pivot goes to the back rim, not the centre
      const map = keepTex(paintStates(pal.body, [{ dabs: 240,
        spots: [{ c: pal.body, n: 12, r: 9, a: 0.4 }] }], { size: 128 })[0]);
      // DoubleSide is not decoration: both halves are open shells, so the moment the lid swings the
      // camera sees their INSIDES — and a single-sided shell there shows nothing but its own
      // BackSide ink hull, i.e. a solid black hole where the opened container should be.
      const mat = keepMat(toonMat({ color:0xffffff, vertexColors:true, map,
        emissive: pal.band, emissiveIntensity:0.18, rim:0.4 }));
      mat.side = THREE.DoubleSide;
      const hot = keepMat(toonMat({ color:0xffffff, vertexColors:true, map,
        emissive: pal.glow, emissiveIntensity:0.55, rim:0.9, rimColor:0xffffff }));
      hot.side = THREE.DoubleSide;
      const eyeGeo = spec.eye ? keepGeo(new THREE.SphereGeometry(spec.r*0.2, 8, 6)) : null;
      const eyeMat = spec.eye ? keepMat(toonMat({ color: pal.plate, emissive: pal.glow,
        emissiveIntensity:1.4, rim:1.0 })) : null;
      kit[spec.id] = { spec, baseGeo, lidGeo, mat, hot, eyeGeo, eyeMat, pal };
    }

    // A chest costs lockpicks to open, so a chest you cannot walk to costs the player a resource
    // they spent a jump chain earning and then never get to use. reachable() last, as everywhere.
    const chestTest = (x, z)=> slopeAt(x, z) < P.chestSlope && !inExclusion(x, z, P.chestPad)
      && clearOf(x, z, P.chestClear) && reachable(x, z);
    for(const spec of tierSpec){
      if(spec.n <= 0) continue;
      const k = kit[spec.id];
      for(const s of scatter(rng, spec.n, P.chestMinDist, chestTest)){
        const gy = groundHeight(s.x, s.z);
        const g = new THREE.Group();
        g.position.set(s.x, gy, s.z);
        g.rotation.y = rng()*TAU;
        const base = shared(new THREE.Mesh(k.baseGeo, k.mat));
        base.position.y = spec.h*0.5;
        base.castShadow = true;
        addOutline(base, 0.035);
        const pivot = new THREE.Group();
        // pivot at the BACK rim: lidGeo was translated +z by the same r*0.9, so the two cancel
        // and the lid swings about its hinge instead of spinning about its own middle.
        pivot.position.set(0, spec.h*0.52, -spec.r*0.9);
        const lid = shared(new THREE.Mesh(k.lidGeo, k.mat));
        lid.castShadow = true;
        addOutline(lid, 0.035);
        pivot.add(lid);
        g.add(base, pivot);
        if(k.eyeGeo){
          const eye = shared(new THREE.Mesh(k.eyeGeo, k.eyeMat));
          eye.position.set(0, spec.h*0.3, spec.r*1.02);
          g.add(eye);
        }
        // world-space "how many lockpicks has this thing eaten" bar. Hidden until the first attempt:
        // publishing the odds is the point, but publishing a 0/5 bar on an untouched chest is noise.
        const bar = makeProgressBar({ width: spec.r*1.7, height: 0.16, tint: k.pal.glow });
        bar.group.position.y = spec.h*1.5;
        bar.group.visible = false;
        g.add(bar.group);
        own.misc.push(bar);
        root.add(g);
        const chest = { type:'chest', tier: spec.id, x: s.x, z: s.z, y: gy, r: spec.r, h: spec.h,
          // per-run and NOT persisted: a chest's attempt history dies with the world it stands in
          state: { tries: 0 },
          group: g, base, lid, pivot, bar, kit: k, mesh: base,
          open: false, openT: 0, shakeT: 0, hovered: false };
        base.userData.prop = chest; lid.userData.prop = chest;
        // the collider comes out of the same loop as the mesh (item 01)
        pushCollider(s.x, s.z, spec.r*0.88, gy, gy + spec.h*1.05);
        chests.push(chest);
      }
    }
  }

  /* ================================ item 18 — guaranteed treasure ================================
     The pattern matters more than the prop: this is placed UNCONDITIONALLY at the hardest-to-reach
     authored place, so getting there is a known trade rather than a gamble. A guaranteed reward at
     a known hard place is what turns exploration into a decision. */
  const treasures = [];
  let treasureSource = 'none';
  {
    const geo = keepGeo(crystalGeo(look));
    geo.computeBoundingBox();
    const crystalH = geo.boundingBox.max.y;   // base-anchored, so max.y IS the height
    const INK = 0.045;                        // ink weight; see the re-centring note at the hull
    /* emissiveIntensity is the whole difference between a gem and a paper cutout, in both
       directions. ACES + exposure 1.28 clips anything at or over 1.0 to flat white — that is why
       BOTH states stay under it. But emissive is added FLAT, so it also erases the difference
       between facets: at 0.72 every plate landed within a few percent of every other one and the
       crystal read as a pale blob even though it never clipped. 0.30 leaves the toon bands and the
       rim doing the shape-reading, and hover more than doubles it to 0.68 — obviously hotter, still
       well short of the clip. The rim came down with it for the same reason: a six-facet point
       presents most of its surface at a grazing angle, so a rim tuned for a two-plate octahedron
       whites out the entire silhouette. The cool/warm tints are pinned near the treasure palette
       so the shadow side stays a saturated blue instead of drifting grey; a jewel is its shadows. */
    const mat = keepMat(toonMat({ color: PAL.treasure.core, emissive: PAL.treasure.glow,
      emissiveIntensity: 0.30, rim: 0.42, rimColor: 0xdffbff,
      coolTint: 0x3d7fb2, warmTint: 0xcdeeff }));
    const hot = keepMat(toonMat({ color: PAL.treasure.core, emissive: PAL.treasure.glow,
      emissiveIntensity: 0.68, rim: 0.72, rimColor: 0xffffff,
      coolTint: 0x5a9bc8, warmTint: 0xeafaff }));
    /* emissive + an additive glow, NEVER a PointLight: these despawn on pickup, and adding or
       removing a real light forces a shader recompile on every other material in the scene.

       INVARIANT: the glow is a camera-facing BILLBOARD carrying fx.glowTexture(), never a shell.
       Two bugs, one shape:
       - LOOK. `opacity` is FLAT. An additive sphere therefore has constant alpha and renders as a
         hard-edged DISC sitting behind the gem — the same bug as the mapless square halo, in round
         form. Only the radial map gives a falloff, which is why fx says any billboarded glow must
         carry it.
       - COST. A shell is a thing the camera can stand INSIDE, and once it does it paints the whole
         viewport with an additive layer at full strength, at every distance. Two triangles whose
         world size we own cannot do that. (Measured: four deliberately full-screen additive shells
         cost under a millisecond on this machine, so this is a ceiling being removed, not a fire
         being put out — see the ramp below for the part that actually guarantees the ceiling.)
       Sprite, not a quad we spin ourselves: the renderer billboards it for free, so the update
       loop stays allocation-free and never touches a quaternion. */
    const haloMat = keepMat(new THREE.SpriteMaterial({ map: glowTexture(),
      color: PAL.treasure.glow, transparent:true, opacity: HALO_OP,
      // fog OFF on purpose: fog mixes toward the fog colour, which on an additive layer means a
      // distant glow ADDS sky to the sky. The distance ramp below does the fading instead.
      blending: THREE.AdditiveBlending, depthWrite:false, fog:false }));

    // Fall back gracefully. The terrain wave is adding authored sites this wave and exposing them
    // on the world object; probe the plausible field names, then landmarks, then high ground. The
    // guarantee is that treasure EXISTS somewhere hard, not that a particular field was finished.
    let site = null;
    const siteFields = ['treasureSites','authoredSites','sites','setPieces','landmarkSites'];
    for(const f of siteFields){
      const v = world[f];
      if(!Array.isArray(v) || !v.length) continue;
      // prefer the highest one: "hardest to reach" is a real property, not a label
      let best = null, bh = -Infinity;
      for(const s of v){
        const p = s && s.isObject3D ? s.position : s;
        if(!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) continue;
        const top = Number.isFinite(s.base) && Number.isFinite(s.coreH) ? s.base + s.coreH
                                                                        : groundOnly(p.x, p.z);
        if(top > bh){ bh = top; best = { x:p.x, z:p.z, y: top, r: s.r ? s.r*0.17 : 2 }; }
      }
      if(best){ site = best; treasureSource = 'world.' + f; break; }
    }
    if(!site){
      for(const f of ['motherShroom','pondPos']){
        const v = world[f];
        const p = v && v.isObject3D ? v.position : v;
        if(!p || !Number.isFinite(p.x)) continue;
        // stand off the landmark's own footprint rather than inside its collider
        const a = rng()*TAU, d = 11;
        const x = p.x + Math.cos(a)*d, z = p.z + Math.sin(a)*d;
        site = { x, z, y: groundOnly(x, z), r: 2 };
        treasureSource = 'world.' + f + ' (fallback)';
        break;
      }
    }
    if(!site){
      // last resort: the highest clear point out of 400 samples. Still unconditional, still hard
      // to reach, and it needs nothing at all from the terrain wave.
      // Treasure is the one thing in this file whose existence is GUARANTEED, so reachability is
      // a preference here rather than a veto: take the highest REACHABLE point, and only if the
      // seed offers none at all fall back to the highest point of any kind. An awkward gem beats
      // an absent one; an unreachable gem is what this two-pass search exists to avoid.
      let best = null, bh = -Infinity, anyBest = null, anyH = -Infinity;
      const cand = scatter(rng, 400, 0, (x, z)=> !inExclusion(x, z, 3) && clearOf(x, z, 2.5));
      for(const c of cand){
        const h = groundHeight(c.x, c.z);
        if(h > anyH){ anyH = h; anyBest = c; }
        if(h > bh && reachable(c.x, c.z)){ bh = h; best = c; }
      }
      if(best){ site = { x: best.x, z: best.z, y: bh, r: 2 }; treasureSource = 'high-ground search'; }
      else if(anyBest){ site = { x: anyBest.x, z: anyBest.z, y: anyH, r: 2 };
        treasureSource = 'high-ground search (no reachable peak)'; }
    }
    if(site){
      const n = opts.treasureCount ?? P.treasureCount;
      for(let i=0;i<n;i++){
        const a = (i/n)*TAU + rng()*0.4;
        const rr = n > 1 ? P.treasureRing : 0;
        const x = site.x + Math.cos(a)*rr, z = site.z + Math.sin(a)*rr;
        const gy = Math.max(groundOnly(x, z), site.y - 1.2);
        const mesh = shared(new THREE.Mesh(geo, mat));
        mesh.position.set(x, gy + P.treasureLift, z);
        mesh.rotation.y = rng()*TAU;
        // addOutline inflates the hull by SCALING it about the mesh origin, and anchorToBase() put
        // that origin at the crystal's FOOT. On a 2.2 m point that sends the whole hull upward —
        // 0.10 m past the tip — so the ink stops being a line round the silhouette and becomes a
        // second, offset copy of it painted over the facets. Dropping the hull by half its own
        // growth re-centres the inflation on the crystal's middle, which is what the uniform-scale
        // trick assumes in the first place. Any tall, base-anchored prop needs this.
        const ink = addOutline(mesh, INK);
        ink.position.y = -crystalH*INK*0.5;
        // one material clone per gem: the ramp is per-camera-distance, so the four cannot share
        // an opacity. Same parameters means the same compiled program, so this is four uniforms,
        // not four shaders. keepMat() puts each clone on the module's own teardown list.
        const halo = shared(new THREE.Sprite(keepMat(haloMat.clone())));
        halo.position.y = HALO_Y;
        halo.scale.set(HALO_R*2, HALO_R*2*HALO_ASPECT, 1);
        halo.raycast = ()=>{};
        mesh.add(halo);
        root.add(mesh);
        const tr = { type:'treasure', x, z, y: gy + P.treasureLift, restY: gy + P.treasureLift,
          coins: Math.round(P.treasureCoinMin + rng()*P.treasureCoinVar),
          mesh, halo, mats: { plain: mat, hot }, collected: false, hovered: false,
          phase: rng()*TAU, spin: (rng() < 0.5 ? -1 : 1) * P.treasureSpin };
        mesh.userData.prop = tr;
        treasures.push(tr);
      }
    }
  }

  /* ================================ hover targets ================================ */
  // built ONCE. hoverTargets() is called from a raycast every frame, so it must not allocate.
  const targets = [];
  for(const p of pods) targets.push(p.mesh);
  for(const c of chests){ targets.push(c.base); targets.push(c.lid); }
  for(const v of vents) targets.push(v.mesh);
  for(const t of treasures) targets.push(t.mesh);

  let hovered = null;
  function setHovered(prop){
    if(hovered === prop) return;
    if(hovered) applyHover(hovered, false);
    hovered = prop || null;
    if(hovered) applyHover(hovered, true);
  }
  function applyHover(p, on){
    p.hovered = on;
    if(p.type === 'pod') p.mesh.material = (on ? p.mats.hot : p.mats.plain)[p.stage];
    else if(p.type === 'chest'){ p.base.material = p.lid.material = on ? p.kit.hot : p.kit.mat; }
    else if(p.type === 'treasure') p.mesh.material = on ? p.mats.hot : p.mats.plain;
    else if(p.type === 'vent') p.glow.material.opacity = on ? 0.62 : 0.35;
  }

  /* ================================ update ================================ */
  // No allocations. Indexed loops, plain-number maths, and every material change is a reference
  // swap to something already compiled.
  function update(dt, t, camera, playerPos){
    for(let i=0;i<pods.length;i++){
      const p = pods[i];
      if(p.cool > 0) p.cool -= dt;
      let y = p.restY;
      if(p.bump > 0){
        // the kick: sin(bump*PI) is a full arc up and back with no state beyond one scalar
        p.bump += dt/P.podBumpT;
        if(p.bump >= 1) p.bump = 0;
        else y += Math.sin(p.bump*Math.PI)*P.podKick;
      }
      if(!p.spent){
        y += Math.sin(t*P.podBobRate + p.phase)*P.podBob;
        p.mesh.position.x = p.x + Math.sin(t*P.podSwayRate + p.swayPhase)*P.podSway;
        p.mesh.rotation.y += dt*0.35;
        // faint pulse so a live pod is never quite still — the difference between a prop and a toy
        p.mesh.scale.setScalar(1 + Math.sin(t*2.6 + p.phase)*0.026);
      } else {
        y -= 0.06;                                 // a husk sags, permanently
      }
      p.mesh.position.y = y;
      // collision follows the silhouette, not the rest pose (see the build-loop invariant)
      p.head.bot = y;
      p.col.bot = y - 0.12; p.col.top = y + P.podR*1.9 + 0.12;
    }
    for(let i=0;i<chests.length;i++){
      const c = chests[i];
      if(c.open && c.openT < 1){
        c.openT = clamp01(c.openT + dt/P.chestOpenT);
        c.pivot.rotation.x = P.chestLidRot*easeOutQuint(c.openT);
      }
      if(c.shakeT > 0){
        c.shakeT -= dt;
        const k = Math.max(0, c.shakeT)/P.chestShakeT;
        const s = Math.sin(c.shakeT*P.chestShakeRate)*P.chestShakeAmp*k;
        c.group.position.x = c.x + s;
        c.group.position.z = c.z + s*0.4;
        c.group.rotation.z = s*0.5;
        if(c.shakeT <= 0){ c.group.position.x = c.x; c.group.position.z = c.z; c.group.rotation.z = 0; }
      }
      if(c.bar.group.visible && camera) c.bar.group.quaternion.copy(camera.quaternion);
    }
    for(let i=0;i<vents.length;i++){
      const v = vents[i];
      if(v.cool > 0){
        v.cool -= dt;
        if(v.cool < 0) v.cool = 0;
      }
      // item 10 has to be VISIBLE or it is just a refused input. The throat glow is the vent's
      // only "open" signal, so a cooling vent snuffs it and refills it as the timer runs down —
      // you can read how long is left off the brightness without a number anywhere on screen.
      // The material is SHARED per family, so the per-vent state rides scale + the mesh's own
      // visibility, never material.opacity: writing opacity here would dim every vent of that
      // colour on the map at once.
      const k = v.cool > 0 ? 1 - v.cool/P.ventCool : 1;
      const pulse = v.cool > 0 ? 0.34 + k*0.66 : 1 + Math.sin(t*1.9 + i)*0.05;
      v.glow.scale.setScalar(pulse);
      if(v.glow.visible !== (k > 0.08 || v.cool <= 0)) v.glow.visible = k > 0.08 || v.cool <= 0;
    }
    for(let i=0;i<treasures.length;i++){
      const tr = treasures[i];
      if(tr.collected) continue;
      tr.mesh.position.y = tr.restY + Math.sin(t*P.treasureBobRate + tr.phase)*P.treasureBob;
      tr.mesh.rotation.y += dt*tr.spin;
      /* The glow's size AND opacity both ride one 0..1 ramp `k`, so the billboard can never be the
         biggest thing on screen however close the lens gets, and stops being drawn once it is too
         far to read. Plain-number maths on four props: no allocation, no sqrt we don't need. */
      let k = 1;
      if(camera){
        const cx = camera.position.x - tr.x, cy = camera.position.y - (tr.restY + HALO_Y),
              cz = camera.position.z - tr.z;
        const d = Math.sqrt(cx*cx + cy*cy + cz*cz);
        k = smooth(clamp01((d - HALO_NEAR_OFF)/(HALO_NEAR_FULL - HALO_NEAR_OFF)))
          * (1 - clamp01((d - HALO_FAR_START)/(HALO_FAR_OFF - HALO_FAR_START)));
      }
      tr.halo.visible = k > 0.02;
      if(tr.halo.visible){
        const s = HALO_R*2*(1 + Math.sin(t*2.2 + tr.phase)*0.08)*k;
        tr.halo.scale.set(s, s*HALO_ASPECT, 1);
        tr.halo.material.opacity = (tr.hovered ? HALO_OP_HOT : HALO_OP)*k;
      }
      if(playerPos){
        const dx = playerPos.x - tr.x, dz = playerPos.z - tr.z;
        const dy = playerPos.y - tr.restY;
        if(dx*dx + dz*dz < P.treasureReach*P.treasureReach && dy > -2.6 && dy < 3.2)
          collectTreasure(tr);
      }
    }
    pops.update(dt);
  }

  function collectTreasure(tr){
    if(tr.collected) return null;
    tr.collected = true;
    tr.mesh.visible = false;
    const coins = grantCoins(tr.coins);
    pops.pop(tr.x, tr.restY + 0.4, tr.z, 6);
    return emit({ type:'treasure', treasure: tr, coins, x: tr.x, y: tr.restY, z: tr.z,
      left: treasures.reduce((a,b)=> a + (b.collected ? 0 : 1), 0) });
  }

  /* ================================ queries the caller drives ================================ */

  function nearestChest(px, pz, py){
    let best = null, bd = P.chestReach*P.chestReach;
    for(let i=0;i<chests.length;i++){
      const c = chests[i];
      if(c.open) continue;
      if(py !== undefined && Math.abs(py - c.y) > 3.2) continue;
      const dx = px - c.x, dz = pz - c.z, d = dx*dx + dz*dz;
      if(d < bd){ bd = d; best = c; }
    }
    return best;
  }
  function promptFor(chest){
    if(!chest) return '';
    if(progress && progress.chestPrompt) return progress.chestPrompt(chest.tier, chest.state);
    return 'Pry the sealed chest';
  }
  function infoFor(chest){
    return (chest && progress && progress.chestInfo) ? progress.chestInfo(chest.tier, chest.state) : null;
  }

  // item 14. One attempt. progress.js spends the lockpick, rolls the published chance, banks the
  // payout and decides `gear`; this only drives the lid, the shake and the bar.
  function pry(chest){
    if(!chest || chest.open) return null;
    if(!progress || !progress.pryChest) return null;
    const res = progress.pryChest(chest.tier, chest.state);
    const info = progress.chestInfo(chest.tier, chest.state);
    if(res.ok && info.maxTries > 0){
      chest.bar.group.visible = true;
      chest.bar.set(clamp01(info.tries/info.maxTries));
    }
    if(!res.ok){
      chest.shakeT = P.chestShakeT*0.6;                  // no lockpick: a nudge, not an attempt
    } else if(res.opened){
      chest.open = true; chest.openT = 0;
      chest.bar.group.visible = false;
      pops.pop(chest.x, chest.y + chest.h*1.1, chest.z, res.coins > 90 ? 10 : 6);
    } else {
      chest.shakeT = P.chestShakeT;
    }
    // `gear:true` is a request to main.js to roll ONE drop from its own powerup table — the
    // chest -> duplicates -> stars edge deliberately stays there so chests pay from the same table.
    return emit({ type:'chest', chest, tier: chest.tier, result: res, info,
      gear: !!res.gear, x: chest.x, y: chest.y, z: chest.z });
  }

  // item 13. Standing on the lip, feet near the top: that is "on a vent".
  function ventUnderfoot(px, pz, py, grounded){
    if(grounded === false) return null;
    for(let i=0;i<vents.length;i++){
      const v = vents[i];
      const dx = px - v.x, dz = pz - v.z;
      if(dx*dx + dz*dz > P.ventReach*P.ventReach) continue;
      if(py !== undefined && Math.abs(py - v.topY) > 1.3) continue;
      return v;
    }
    return null;
  }
  // item 10. THE COOLDOWN IS ON THE VENT YOU ARRIVE AT, not the one you leave, and that asymmetry
  // is the whole mechanic: without it a pair of vents is an infinite loop you can stand in, and
  // "ride the vent" stops being a route decision. Refusal is REPORTED rather than silently
  // dropped — a shortcut that ignores your input without saying why reads as broken.
  function travel(vent){
    if(!vent || !vent.partner) return null;
    if(vent.cool > 0)
      return emit({ type:'ventCool', vent, left: vent.cool, of: P.ventCool,
        x: vent.x, y: vent.topY, z: vent.z });
    const to = vent.partner;
    to.cool = P.ventCool;
    return emit({ type:'travel', from: vent, to, cool: P.ventCool,
      x: to.x, y: to.topY + 0.05, z: to.z, aimAt: to.aimAt });
  }
  // the one place that turns a vent's live state into words, so the hover tag, the interact
  // prompt and the label can never disagree about whether a vent is usable.
  function ventPrompt(v){
    if(!v) return '';
    if(v.cool > 0) return `🌀 ${v.fam.name} vent — venting, ${Math.ceil(v.cool)}s`;
    return `🌀 ${v.fam.name} vent — rides to the other ${v.fam.name.toLowerCase()} vent`;
  }

  function labelFor(mesh){
    let n = mesh, p = null;
    while(n && !p){ p = n.userData && n.userData.prop; n = n.parent; }
    if(!p) return '';
    if(p.type === 'pod'){
      if(p.spent) return '🥀 Spent husk';
      const left = p.charges - p.hits;
      const rich = p.mult > 1 ? ' ×10 value' : '';
      return `🌸 Flower pod${rich} — ×${left}, jump up into it`;
    }
    if(p.type === 'chest') return promptFor(p) || '🧰 Sealed chest';
    if(p.type === 'vent') return ventPrompt(p);
    if(p.type === 'treasure') return '💎 Spore crystal — touch to collect';
    return '';
  }
  function propOf(mesh){
    let n = mesh;
    while(n){ if(n.userData && n.userData.prop) return n.userData.prop; n = n.parent; }
    return null;
  }

  function dispose(){
    // retire, never splice: surfaceAt() walks COLLIDERS by index for every entity every frame,
    // and world.js truncates the array in place on its own teardown.
    for(const c of colliders) c.off = true;
    for(const p of pods) p.head.off = true;
    for(const b of own.misc) if(b.dispose) b.dispose();
    if(popsOwned) pops.dispose();
    root.traverse(n=>{                       // only what a mesh actually owns; see markOwnership
      if(n.userData.ownGeo && n.geometry) n.geometry.dispose();
      if(n.userData.ownMat && n.material && !Array.isArray(n.material)) n.material.dispose();
    });
    // then the shared pool, which this module does own — disposing it any earlier would empty
    // every prop still referencing it.
    for(const g of own.geo) g.dispose();
    for(const m of own.mat) m.dispose();
    for(const t of own.tex) t.dispose();
    own.geo.length = own.mat.length = own.tex.length = own.misc.length = 0;
    if(root.parent) root.parent.remove(root);
    pods.length = chests.length = vents.length = treasures.length = 0;
    targets.length = 0; colliders.length = 0; events.length = 0;
  }

  return {
    root, pods, chests, vents, treasures, colliders, events,
    treasureSource, anchors,
    update, nearestChest, promptFor, infoFor, pry, ventUnderfoot, travel, ventPrompt,
    collectTreasure, payPod,
    hoverTargets: ()=> targets,
    labelFor, propOf, setHovered,
    headEntries: ()=> pods.map(p=>p.head),
    dispose,
  };
}

// world.js also exports a buildProps() (item 31, terrain-side props). Different module, but
// import it under a name if both ever land in one file.
export { buildProps as buildInteractiveProps };
