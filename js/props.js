// props.js — the interactive props. Items 11 (spore pods), 13 (vents), 14 (sealed cysts),
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
         makeProgressBar, RewardPops } from './fx.js';
import { COLLIDERS, groundHeight, groundOnly, slopeAt, inExclusion, scatter } from './world.js';
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
  podR: 0.66,                       // visual radius; the head-hit disc is podHitR
  podHitR: 0.52,                    // slightly under the silhouette: a pod you clearly missed must miss
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
  // height stays under entities.js's STEP (1.5) so an unused vent is a kerb you walk over
  // rather than a knee-high wall you have to jump — a shortcut must never be an obstacle.
  ventH: 1.44, ventLipR: 1.78, ventThroatR: 1.24, ventThroatDepth: 1.05,
  ventReach: 1.75,                   // how close to the axis counts as standing on it
  ventBandAngle: 2.35,               // the island's fixed highlight angle, in WORLD space
  ventBandWidth: 1.05, ventBandAmt: 0.34, ventBandShadow: 0.24,

  /* --- item 14: sealed cysts --- */
  cystCrusted: 4, cystIronbound: 2, cystElderChance: 0.75,   // at most one elder per world
  cystSlope: 0.6, cystPad: 2.5, cystClear: 2.2, cystMinDist: 26,
  cystReach: 3.4,                    // interaction radius
  cystOpenT: 0.72,                   // lid swing duration
  cystLidRot: -1.95,                 // radians, open
  cystShakeT: 0.3, cystShakeAmp: 0.11, cystShakeRate: 46,

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
  cyst: {
    crusted:   { body:'#a58b6a', band:0x6e5a43, plate:0xc9a86a, glow:0xffd79a },
    ironbound: { body:'#7d8ea8', band:0x2f3a4e, plate:0xa8c4e0, glow:0xbfe4ff },
    elder:     { body:'#8f6aa8', band:0x3a2450, plate:0xd8a8ff, glow:0xe0b0ff },
  },
  // the body has to sit WELL clear of the ink hull's 0x1c1410, or the outline and the fill merge
  // into one black mass and the whole vent reads as a hole in the world rather than a prop with
  // a hole in it. Only the throat is allowed to be near-black — that IS the hole.
  vent:     { body:0x9ac0d4, lip:0xd8f2ff, throat:0x0d1620 },
  // core is deliberately SATURATED, not icy: it is the only prop whose whole job is "this is
  // worth the climb", and a pale cyan reads as ice, which is scenery. Ice is free; gems are not.
  treasure: { core:0x2fb0e0, deep:0x1c5f80, glow:0x8fe8ff },
};

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
function podGeo(r, h){
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

// a faceted crystal cluster: one tall point plus two shards, merged so the whole cluster is
// ONE mesh. Emissive only — item 18's crystals spawn and despawn, and the README rule is that
// nothing which does that gets a real PointLight.
//
// INVARIANT: each shard is a SIX-sided tapered prism capped with a six-sided point, and the cap
// shares the body's segment count so their facets stay in phase. The facet count is the whole
// read: an octahedron only ever shows two plates to the camera, so the rim highlight covers the
// entire silhouette at once and a "gem" flattens into cut paper. Six vertical facets means the
// band shading and the rim land on different plates, which is what makes it look cut.
function crystalShard(r, bodyH, tipH){
  // caps stay closed: the crystal floats at treasureLift, so its underside is on camera
  const body = new THREE.CylinderGeometry(r*0.80, r*0.94, bodyH, 6, 1);
  body.translate(0, bodyH*0.5, 0);
  const tip = new THREE.ConeGeometry(r*0.80, tipH, 6, 1);
  tip.translate(0, bodyH + tipH*0.5, 0);
  return [nonIndexed(body), nonIndexed(tip)];
}
function crystalGeo(rng){
  const parts = crystalShard(0.44, 1.22, 0.98);          // the point: ~2.2 m, the silhouette
  for(let i=0;i<2;i++){
    // one transform per SHARD, applied to both of its halves — roll the numbers before the loop
    // or the body and the tip lean and land differently and the shard comes apart.
    // stubby on purpose: a satellite as slender as the point reads as a flap of paper stuck to
    // the side, not as a second crystal. Fat and short is what makes it a cluster.
    const sub = crystalShard(0.19 + rng()*0.09, 0.26 + rng()*0.18, 0.30 + rng()*0.14);
    const a = rng()*TAU, d = 0.34 + rng()*0.16, lean = 0.18 + rng()*0.22, lift = 0.05 + rng()*0.10;
    for(const s of sub){
      s.rotateZ(Math.cos(a)*lean); s.rotateX(-Math.sin(a)*lean);   // lean AWAY from the point
      s.translate(Math.cos(a)*d, lift, Math.sin(a)*d);
      parts.push(s);
    }
  }
  const geo = mergeGeos(parts);
  geo.computeVertexNormals();
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
    const geo = keepGeo(bandShade(podGeo(P.podR, P.podR*1.9), {
      color:0xffffff, amount:0.30, shadow:0.24, width:1.15,
      belly:0.85,                     // the underside is the part that pays, so it is the part that glows
      ao:0.10 }));
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

    const podTest = (x, z)=>{
      const h = groundHeight(x, z);
      if(h < P.podMinH) return false;
      if(slopeAt(x, z) > P.podSlope) return false;
      if(inExclusion(x, z, P.podPad)) return false;
      if(!clearOf(x, z, P.podClear)) return false;
      return bandFree(x, z, P.podClear, h + P.podBotMin - 0.3, h + P.podBotMin + P.podBotVar + 1.8);
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
    // PODS ARE WHERE PRY-SPINES COME FROM, SO SEALED CYSTS ALWAYS STAY REACHABLE. progress.js
    // owns the chance AND the pity streak — rolling our own here would double-count both.
    const spine = progress && progress.spineRoll ? progress.spineRoll('pod') : null;
    const y = pod.mesh.position.y;
    pops.pop(pod.x, y + 0.5, pod.z, pod.mult > 1 ? 5 : 2);
    if(pod.hits >= pod.charges) setPodSpent(pod);
    else setPodStage(pod, 1);                   // cracked: still owes you something, and shows it
    return emit({ type:'pod', pod, coins, mult: pod.mult,
      hits: pod.hits, charges: pod.charges, chargesLeft: Math.max(0, pod.charges - pod.hits),
      spent: pod.spent, spine, x: pod.x, y, z: pod.z,
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
    const glowMat = keepMat(new THREE.MeshBasicMaterial({ color: PAL.vent.lip, transparent:true,
      opacity:0.35, blending:THREE.AdditiveBlending, depthWrite:false }));
    // one shared material for every vent shell: the per-vent difference is baked into the
    // vertex colours, which is the whole reason the highlight can be shared at all.
    const ventMat = keepMat(toonMat({ color:0xffffff, vertexColors:true, rim:0.5,
      rimColor:0xcfeeff, emissive:0x0a1c26, emissiveIntensity:0.3 }));

    const ventTest = (x, z)=> slopeAt(x, z) < P.ventSlope && !inExclusion(x, z, P.ventPad)
      && clearOf(x, z, P.ventClear);
    const spots = scatter(rng, opts.ventCount ?? P.ventCount, P.ventMinDist, ventTest);

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
      const fill = bandShade(bakeYaw(mergeGeos([shaft, lip, rim]), yaw), {
        color: PAL.vent.body, angle: P.ventBandAngle, width: P.ventBandWidth,
        amount: P.ventBandAmt, shadow: P.ventBandShadow, ao: 0.14 });
      fill.computeVertexNormals();
      const mesh = ownsGeo(new THREE.Mesh(fill, ventMat));
      mesh.position.set(s.x, gy, s.z);
      mesh.castShadow = true;
      addOutline(mesh, 0.035);
      const throat = shared(new THREE.Mesh(throatGeo, throatMat));
      throat.position.y = P.ventH - P.ventThroatDepth*0.5 - 0.04;
      const glow = shared(new THREE.Mesh(glowGeo, glowMat));
      glow.rotation.x = -Math.PI/2;
      glow.position.y = P.ventH - 0.02;
      mesh.add(throat, glow);
      root.add(mesh);
      const vent = { type:'vent', i, x: s.x, z: s.z, groundY: gy, topY: gy + P.ventH,
        r: P.ventLipR, mesh, glow, partner: null, aimAt: null, hovered: false };
      mesh.userData.prop = vent;
      // a vent is climbable geometry even when unused — and ventH stays under STEP so it is a kerb
      pushCollider(s.x, s.z, P.ventLipR*0.95, gy, gy + P.ventH);
      vents.push(vent);
    }
    // one ring, so every vent has exactly one partner and travel always terminates. A ring rather
    // than pairs because an odd count then still links: nobody is left with no destination.
    for(let i=0;i<vents.length;i++) vents[i].partner = vents[(i+1) % vents.length];
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

  /* ================================ item 14 — sealed cysts ================================
     The published gamble. progress.js owns every number; this file owns the lid, the shake and
     the fact that the odds are on the label before you spend. */
  const cysts = [];
  {
    const tierSpec = [
      { id:'crusted',   n: opts.cystCrusted ?? P.cystCrusted,   r:0.95, h:1.05, bands:4, eye:false },
      { id:'ironbound', n: opts.cystIronbound ?? P.cystIronbound, r:1.15, h:1.28, bands:6, eye:false },
      { id:'elder',     n: (rng() < P.cystElderChance) ? 1 : 0,  r:1.42, h:1.55, bands:8, eye:true },
    ];
    const kit = {};      // per-tier shared geometry + materials
    for(const spec of tierSpec){
      const pal = PAL.cyst[spec.id];
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

    const cystTest = (x, z)=> slopeAt(x, z) < P.cystSlope && !inExclusion(x, z, P.cystPad)
      && clearOf(x, z, P.cystClear);
    for(const spec of tierSpec){
      if(spec.n <= 0) continue;
      const k = kit[spec.id];
      for(const s of scatter(rng, spec.n, P.cystMinDist, cystTest)){
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
        // world-space "how many spines has this thing eaten" bar. Hidden until the first attempt:
        // publishing the odds is the point, but publishing a 0/5 bar on an untouched cyst is noise.
        const bar = makeProgressBar({ width: spec.r*1.7, height: 0.16, tint: k.pal.glow });
        bar.group.position.y = spec.h*1.5;
        bar.group.visible = false;
        g.add(bar.group);
        own.misc.push(bar);
        root.add(g);
        const cyst = { type:'cyst', tier: spec.id, x: s.x, z: s.z, y: gy, r: spec.r, h: spec.h,
          // per-run and NOT persisted: a cyst's attempt history dies with the world it stands in
          state: { tries: 0 },
          group: g, base, lid, pivot, bar, kit: k, mesh: base,
          open: false, openT: 0, shakeT: 0, hovered: false };
        base.userData.prop = cyst; lid.userData.prop = cyst;
        // the collider comes out of the same loop as the mesh (item 01)
        pushCollider(s.x, s.z, spec.r*0.88, gy, gy + spec.h*1.05);
        cysts.push(cyst);
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
    // emissive + an additive shell, NEVER a PointLight: these despawn on pickup, and adding or
    // removing a real light forces a shader recompile on every other material in the scene.
    // The shell hugs the crystal (1.0, not 1.15): any wider and it stops reading as the crystal's
    // own glow and starts reading as a pale disc laid over the ground behind it.
    const haloGeo = keepGeo(new THREE.SphereGeometry(1.0, 10, 8));
    const haloMat = keepMat(new THREE.MeshBasicMaterial({ color: PAL.treasure.glow,
      transparent:true, opacity:0.10, blending:THREE.AdditiveBlending, depthWrite:false,
      side: THREE.BackSide }));

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
      let best = null, bh = -Infinity;
      const cand = scatter(rng, 400, 0, (x, z)=> !inExclusion(x, z, 3) && clearOf(x, z, 2.5));
      for(const c of cand){
        const h = groundHeight(c.x, c.z);
        if(h > bh){ bh = h; best = c; }
      }
      if(best){ site = { x: best.x, z: best.z, y: bh, r: 2 }; treasureSource = 'high-ground search'; }
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
        const halo = shared(new THREE.Mesh(haloGeo, haloMat));
        halo.position.y = 0.78;
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
  for(const c of cysts){ targets.push(c.base); targets.push(c.lid); }
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
    else if(p.type === 'cyst'){ p.base.material = p.lid.material = on ? p.kit.hot : p.kit.mat; }
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
    for(let i=0;i<cysts.length;i++){
      const c = cysts[i];
      if(c.open && c.openT < 1){
        c.openT = clamp01(c.openT + dt/P.cystOpenT);
        c.pivot.rotation.x = P.cystLidRot*easeOutQuint(c.openT);
      }
      if(c.shakeT > 0){
        c.shakeT -= dt;
        const k = Math.max(0, c.shakeT)/P.cystShakeT;
        const s = Math.sin(c.shakeT*P.cystShakeRate)*P.cystShakeAmp*k;
        c.group.position.x = c.x + s;
        c.group.position.z = c.z + s*0.4;
        c.group.rotation.z = s*0.5;
        if(c.shakeT <= 0){ c.group.position.x = c.x; c.group.position.z = c.z; c.group.rotation.z = 0; }
      }
      if(c.bar.group.visible && camera) c.bar.group.quaternion.copy(camera.quaternion);
    }
    for(let i=0;i<vents.length;i++){
      const v = vents[i];
      v.glow.scale.setScalar(1 + Math.sin(t*1.9 + i)*0.05);
    }
    for(let i=0;i<treasures.length;i++){
      const tr = treasures[i];
      if(tr.collected) continue;
      tr.mesh.position.y = tr.restY + Math.sin(t*P.treasureBobRate + tr.phase)*P.treasureBob;
      tr.mesh.rotation.y += dt*tr.spin;
      tr.halo.scale.setScalar(1 + Math.sin(t*2.2 + tr.phase)*0.08);
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

  function nearestCyst(px, pz, py){
    let best = null, bd = P.cystReach*P.cystReach;
    for(let i=0;i<cysts.length;i++){
      const c = cysts[i];
      if(c.open) continue;
      if(py !== undefined && Math.abs(py - c.y) > 3.2) continue;
      const dx = px - c.x, dz = pz - c.z, d = dx*dx + dz*dz;
      if(d < bd){ bd = d; best = c; }
    }
    return best;
  }
  function promptFor(cyst){
    if(!cyst) return '';
    if(progress && progress.cystPrompt) return progress.cystPrompt(cyst.tier, cyst.state);
    return 'Pry the sealed cyst';
  }
  function infoFor(cyst){
    return (cyst && progress && progress.cystInfo) ? progress.cystInfo(cyst.tier, cyst.state) : null;
  }

  // item 14. One attempt. progress.js spends the spine, rolls the published chance, banks the
  // payout and decides `gear`; this only drives the lid, the shake and the bar.
  function pry(cyst){
    if(!cyst || cyst.open) return null;
    if(!progress || !progress.pryCyst) return null;
    const res = progress.pryCyst(cyst.tier, cyst.state);
    const info = progress.cystInfo(cyst.tier, cyst.state);
    if(res.ok && info.maxTries > 0){
      cyst.bar.group.visible = true;
      cyst.bar.set(clamp01(info.tries/info.maxTries));
    }
    if(!res.ok){
      cyst.shakeT = P.cystShakeT*0.6;                  // no spine: a nudge, not an attempt
    } else if(res.opened){
      cyst.open = true; cyst.openT = 0;
      cyst.bar.group.visible = false;
      pops.pop(cyst.x, cyst.y + cyst.h*1.1, cyst.z, res.coins > 90 ? 10 : 6);
    } else {
      cyst.shakeT = P.cystShakeT;
    }
    // `gear:true` is a request to main.js to roll ONE drop from its own powerup table — the
    // cyst -> duplicates -> stars edge deliberately stays there so cysts pay from the same table.
    return emit({ type:'cyst', cyst, tier: cyst.tier, result: res, info,
      gear: !!res.gear, x: cyst.x, y: cyst.y, z: cyst.z });
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
  function travel(vent){
    if(!vent || !vent.partner) return null;
    const to = vent.partner;
    return emit({ type:'travel', from: vent, to,
      x: to.x, y: to.topY + 0.05, z: to.z, aimAt: to.aimAt });
  }

  function labelFor(mesh){
    let n = mesh, p = null;
    while(n && !p){ p = n.userData && n.userData.prop; n = n.parent; }
    if(!p) return '';
    if(p.type === 'pod'){
      if(p.spent) return '🫗 Spent husk';
      const left = p.charges - p.hits;
      const rich = p.mult > 1 ? ' ×10 value' : '';
      return `🫧 Spore pod${rich} — ×${left}, jump into it`;
    }
    if(p.type === 'cyst') return promptFor(p) || '🥚 Sealed cyst';
    if(p.type === 'vent') return '🌀 Vent — stand on it and interact';
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
    pods.length = cysts.length = vents.length = treasures.length = 0;
    targets.length = 0; colliders.length = 0; events.length = 0;
  }

  return {
    root, pods, cysts, vents, treasures, colliders, events,
    treasureSource, anchors,
    update, nearestCyst, promptFor, infoFor, pry, ventUnderfoot, travel,
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
