// fauna.js — wandering critters you harvest by landing on them (item 12).
//
// WHY THESE ARE FAUNA AND NOT ENEMIES — read this before "fixing" them into goombas.
// A straight goomba port would fight the game we already have. Combat here is a melee combo
// chain with per-weapon finishers: it owns the attack input, it owns the kill fantasy, and it
// owns the reward for aggression. A stomp-kill enemy competes with all three at once — you
// would be choosing between comboing a mushroom and jumping on it, and whichever won would
// make the other feel like the wrong button.
// So these creatures do not fight back, do not damage the player, and cannot be killed by the
// combo at all. They can only be HARVESTED by landing on them while descending. That buys three
// things a combat-only world cannot have:
//   1. jumping gets a second job, and stomp-chaining gets its own skill ceiling;
//   2. the world contains life that is not trying to kill you, which is the difference between
//      a level and a place;
//   3. the combo system keeps its monopoly on combat, so neither system dilutes the other.
// Contact from the side is deliberately harmless — the critter gets shoved, the player does not
// get hurt. Adding contact damage would turn every one of them back into an enemy and reopen
// the exact conflict this file exists to avoid.
//
// Region -> creature -> resource is the system. Where you stand decides which critter you can
// farm, and each critter pays a DIFFERENT currency, so "go to the outer highlands" is a real
// economic sentence instead of a sightseeing suggestion.

import * as THREE from 'three';
import { toonMat, addOutline, anchorToBase } from './fx.js';
import { mulberry32 } from './rng.js';
import { surfaceAt, slopeAt, inExclusion, scatter, groundHeight, reachable, COLLIDERS, PARAMS } from './world.js';
import { SPECIES_BY_ID } from './mushrooms.js';

/* ---------------- tuning ----------------
   Flat and exported so the dev panel can write into it, same convention as world.PARAMS. */
export const FAUNA = {
  // A movement constant that is a level-design constraint: 14.5 is tuned so a stomp lifts you
  // roughly one critter-to-critter gap, which is what makes CHAINING the point of the mechanic
  // rather than a bonus on top of it. Lower it and stomps become a dead end.
  popVy: 14.5,
  // The stomp window's lower edge, in metres below the critter's top. You must be DESCENDING and
  // your feet must be inside this band: that is what stops a horizontal walk-through from
  // counting, without needing a separate "was airborne" flag.
  stompBand: 0.85,
  // Upper edge, so you cannot harvest one from 8m up the instant your arc crosses its column.
  // Without it the check is "descending and overhead", which fires far too early to read as a stomp.
  stompCeil: 2.3,
  chainWindow: 1.6,      // seconds of un-broken chain; a landing also breaks it via resetChain()
  respawnEvery: 20,      // seconds between population top-ups
  // How often a live critter is rechecked against the reachability mask. Slower than the respawn
  // tick on purpose: a stranded critter is retired here and re-placed by the NEXT top-up, so the
  // two timers being coprime-ish means the gap between "gone" and "back" is short but never zero
  // (a creature that vanishes and reappears in the same frame reads as a flicker, not a wander).
  strandEvery: 7,
  // Critters are short-legged: they step over less than the player's STEP (1.5). Passing a
  // smaller value to surfaceAt() is what stops one strolling up a boulder the player has to jump.
  step: 0.55,
  minGroundH: -3.0,      // never stand below this: the ravine floor and pond beds are not habitat
  edgeR: 176,            // inside PARAMS.scatterRMax, which is itself inside the playable ring
  alts: 8,               // random alternative headings sampled when the current one fails
};

/* ---------------- species: region -> creature -> resource ----------------
   Colours are lifted straight from mushrooms.js so a critter reads as belonging to the spore
   species it grazes on — an amber beetle in an amber meadow. `harvest` is that species id, which
   is also what a harvest contract counts, so the Crag Mite's payout can be credited by id
   without fauna.js knowing anything about contracts.

   Habitat gates are (radius band, slope band) rather than a biome lookup, because world.js's
   item-27 regions are internal to its heightfield — but every world has a flat inner glade, a
   broken mid shoulder and a climbing outer ring by construction (see the PARAMS sil- and edge- knobs), so
   these three habitats always exist no matter what the seed rolls. */
export const CRITTER_SPECIES = [
  {
    id:'sporebeetle', name:'Spore Beetle', icon:'🪲', harvest:'amber',
    color:0xffcf5a, emissive:0xcc8a15, count:4,
    // the glade: flat ground close in. The first critter you ever meet, so it lives where you spawn.
    r0:14, r1:104, slopeMin:0, slopeMax:0.24, maxSlope:0.34, pad:2.5, clear:1.7, minDist:20,
    body:[0.64,0.48,0.76], cap:'shell', capY:0.40, capS:[0.60,0.44,0.68],
    eyeX:0.21, eyeY:0.30, eyeZ:0.60, eyeR:0.125,
    limb:'foot', limbX:0.30, limbY:0.13, stride:0.20, lift:0.10,
    frondN:3, frondY:0.86, frondLen:0.40,
    top:0.95, reach:1.15, speed:2.3, gait:6.8, bob:0.10, torsoY:0.46, hover:0,
    // essence is the mutation currency and the one you burn constantly, so the commonest,
    // closest, easiest critter is the one that pays it.
    drop:{ essence:2, essencePer:1, essenceCap:6, myco:0, mycoPer:0, mycoCap:0, harvestN:0 },
  },
  {
    id:'cragmite', name:'Crag Mite', icon:'🐛', harvest:'violet',
    color:0xb47aff, emissive:0x6a2fa8, count:3,
    // the broken shoulders: it WANTS some slope, so it lives on the ground the beetle refuses.
    r0:58, r1:150, slopeMin:0.18, slopeMax:0.58, maxSlope:0.62, pad:3.0, clear:1.8, minDist:24,
    body:[0.56,0.58,0.60], cap:'hat', capY:0.58, capS:[0.78,0.40,0.78],
    eyeX:0.20, eyeY:0.30, eyeZ:0.52, eyeR:0.135,
    limb:'foot', limbX:0.27, limbY:0.12, stride:0.17, lift:0.12,
    frondN:2, frondY:1.06, frondLen:0.34,
    top:1.15, reach:1.10, speed:1.7, gait:5.4, bob:0.13, torsoY:0.50, hover:0,
    // spore credit, not currency: mites carry violet spores, so stomping them advances the same
    // harvest contracts picking mushrooms does. The chain doubles it, so a linked pair is worth
    // finding a slope for.
    drop:{ essence:0, essencePer:0, essenceCap:0, myco:0, mycoPer:0, mycoCap:0, harvestN:1, harvestPer:1, harvestCap:3 },
  },
  {
    id:'puffdrifter', name:'Puff Drifter', icon:'🎈', harvest:'azure',
    color:0x6ad0ff, emissive:0x2288bb, count:3,
    // the outer highlands: the longest walk on the map, and it HOVERS, so it also drifts over
    // ground the walkers can't use. Farthest habitat pays the scarcest resource.
    r0:110, r1:172, slopeMin:0, slopeMax:0.72, maxSlope:0.78, pad:3.0, clear:2.0, minDist:26,
    body:[0.60,0.58,0.60], cap:'tuft', capY:0.44, capS:[0.34,0.26,0.34],
    eyeX:0.21, eyeY:0.20, eyeZ:0.58, eyeR:0.145,
    limb:'tendril', limbX:0.22, limbY:-0.42, stride:0.10, lift:0.03,
    frondN:5, frondY:-0.44, frondLen:0.44,
    top:1.00, reach:1.20, speed:2.6, gait:3.2, bob:0.06, torsoY:0.78, hover:0.34,
    // Mycelium had one source (contracts) and one sink (lockpicks). A second source that costs
    // a trip to the rim is the point: it makes the outer ring worth crossing the map for.
    drop:{ essence:0, essencePer:0, essenceCap:0, myco:1, mycoPer:0.5, mycoCap:3, harvestN:0 },
  },
];
export const CRITTER_BY_ID = Object.fromEntries(CRITTER_SPECIES.map(s=>[s.id, s]));

/* ---------------- shared geometry ----------------
   One sphere for every body, eye and foot in the game; species differ by mesh.scale and material,
   not by geometry. INVARIANT: nothing in here is ever disposed per-critter — dropping a shared
   geometry would empty every critter built afterwards, so dispose() only touches the module
   cache and only when the last handle goes away. */
let GEO = null;
function sharedGeo(){
  if(GEO) return GEO;
  const sphere = new THREE.SphereGeometry(0.5, 12, 9);
  // eyes, buds and feet are 0.1-0.3m across on screen: at that size 12x9 segments are 190
  // triangles nobody can see. A critter's face alone was 1150 triangles before this split.
  const small = new THREE.SphereGeometry(0.5, 8, 6);
  // cap geometry is base-anchored (item 56) so the idle pulse scales UP FROM THE HEAD instead of
  // ballooning symmetrically through it and leaving a gap at the neck.
  const dome = anchorToBase(new THREE.SphereGeometry(0.5, 12, 6, 0, Math.PI*2, 0, Math.PI*0.55)).geo;
  const hat  = anchorToBase(new THREE.SphereGeometry(0.5, 14, 7, 0, Math.PI*2, 0, Math.PI*0.62)).geo;
  const tendril = anchorToBase(new THREE.CylinderGeometry(0.055, 0.13, 1, 5)).geo;
  GEO = { sphere, small, dome, hat, tendril, refs: 0 };
  return GEO;
}

// Bake a set of transformed sub-geometries into ONE vertex-coloured geometry. Two white sclerae
// plus two ink pupils is four spheres and would be four draw calls per critter; merged it is one,
// which is the whole reason a critter can afford a readable face at all.
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _v3 = new THREE.Vector3(), _s3 = new THREE.Vector3();
function mergeTinted(parts){
  const prepped = [];
  let total = 0;
  for(const p of parts){
    const g = p.geo.index ? p.geo.toNonIndexed() : p.geo.clone();
    _v3.set(p.x||0, p.y||0, p.z||0);
    _q.setFromEuler(new THREE.Euler(p.rx||0, p.ry||0, p.rz||0));
    _s3.set(p.sx??1, p.sy??1, p.sz??1);
    g.applyMatrix4(_m4.compose(_v3, _q, _s3));
    prepped.push({ g, c:new THREE.Color(p.color) });
    total += g.attributes.position.count;
  }
  const pos = new Float32Array(total*3), nrm = new Float32Array(total*3), col = new Float32Array(total*3);
  let o = 0;
  for(const { g, c } of prepped){
    const gp = g.attributes.position, gn = g.attributes.normal;
    for(let i=0;i<gp.count;i++){
      const j = (o+i)*3;
      pos[j] = gp.getX(i); pos[j+1] = gp.getY(i); pos[j+2] = gp.getZ(i);
      nrm[j] = gn.getX(i); nrm[j+1] = gn.getY(i); nrm[j+2] = gn.getZ(i);
      col[j] = c.r; col[j+1] = c.g; col[j+2] = c.b;
    }
    o += gp.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

// Everything one species needs, built once and shared by every critter of it.
function speciesKit(sp){
  const G = sharedGeo();
  const shroom = SPECIES_BY_ID[sp.harvest];
  const kit = { geo:{}, mat:{} };
  // ONE hull mesh carries the body, the eyes, the pupils and the blush, tinted per vertex. Four
  // spheres for a face would be four draw calls per critter; baked in, the face is free and the
  // shared ink outline wraps body and eyes together, which is what makes it read as drawn.
  kit.mat.hull = toonMat({ color:0xffffff, vertexColors:true, emissive:sp.emissive,
    emissiveIntensity:0.20, rim:0.55 });
  kit.mat.cap  = toonMat({ color:sp.color, emissive:sp.emissive, emissiveIntensity:0.42, rim:0.7 });
  kit.mat.limb = toonMat({ color:0xd9c8a6, emissive:0x000000, rim:0.35 });
  kit.mat.frond = toonMat({ color:0xffffff, vertexColors:true,
    emissive:(shroom ? shroom.emissive : sp.emissive), emissiveIntensity:0.35, rim:0.6 });
  kit.geo.cap = sp.cap === 'hat' ? G.hat : G.dome;   // 'tuft' is the dome, just small
  // Big forward eyes with a pale blush: the silhouette has to say "harvest me", and a readable
  // face is most of that — a blank blob the size of a mushroom reads as a hazard.
  const bodyC = new THREE.Color(sp.color).getHex();
  kit.geo.hull = mergeTinted([
    { geo:G.sphere, color:bodyC, sx:sp.body[0]*2, sy:sp.body[1]*2, sz:sp.body[2]*2 },
    { geo:G.small, color:0xfff6e3, x:-sp.eyeX, y:sp.eyeY, z:sp.eyeZ, sx:sp.eyeR*2, sy:sp.eyeR*2.1, sz:sp.eyeR*2 },
    { geo:G.small, color:0xfff6e3, x: sp.eyeX, y:sp.eyeY, z:sp.eyeZ, sx:sp.eyeR*2, sy:sp.eyeR*2.1, sz:sp.eyeR*2 },
    { geo:G.small, color:0x1c1410, x:-sp.eyeX*0.94, y:sp.eyeY+sp.eyeR*0.12, z:sp.eyeZ+sp.eyeR*0.66, sx:sp.eyeR*1.05, sy:sp.eyeR*1.25, sz:sp.eyeR*1.05 },
    { geo:G.small, color:0x1c1410, x: sp.eyeX*0.94, y:sp.eyeY+sp.eyeR*0.12, z:sp.eyeZ+sp.eyeR*0.66, sx:sp.eyeR*1.05, sy:sp.eyeR*1.25, sz:sp.eyeR*1.05 },
    { geo:G.small, color:0xffd9e6, x:-sp.eyeX*1.8, y:sp.eyeY-sp.eyeR*1.6, z:sp.eyeZ*0.70, sx:sp.eyeR*1.5, sy:sp.eyeR*0.8, sz:sp.eyeR*0.5 },
    { geo:G.small, color:0xffd9e6, x: sp.eyeX*1.8, y:sp.eyeY-sp.eyeR*1.6, z:sp.eyeZ*0.70, sx:sp.eyeR*1.5, sy:sp.eyeR*0.8, sz:sp.eyeR*0.5 },
  ]);
  // spore fronds: stalk + bud, all of them merged into a single swaying mesh
  const fr = [];
  const budC = shroom ? shroom.color : sp.color;
  for(let i=0;i<sp.frondN;i++){
    const a = (i/sp.frondN)*Math.PI*2 + 0.4;
    const lean = 0.42 + (i%2)*0.16;
    const dir = sp.limb === 'tendril' ? -1 : 1;    // a drifter's fronds hang, a walker's sprout
    const len = sp.frondLen*(0.82 + (i%3)*0.12);
    const ox = Math.cos(a)*0.16, oz = Math.sin(a)*0.16;
    fr.push({ geo:G.tendril, color:0xe8dcc0, x:ox, y:0, z:oz, sx:0.5, sy:len*dir, sz:0.5,
      rx:Math.sin(a)*lean*dir, rz:-Math.cos(a)*lean*dir });
    fr.push({ geo:G.small, color:budC,
      x:ox + Math.cos(a)*len*lean*0.9, y:len*dir*0.94, z:oz + Math.sin(a)*len*lean*0.9,
      sx:0.15, sy:0.17, sz:0.15 });
  }
  kit.geo.frond = mergeTinted(fr);
  kit.geo.limb = sp.limb === 'tendril' ? G.tendril : G.small;
  // Ownership is marked, not inferred: face/frond are baked per species and must be disposed,
  // cap/limb are borrowed from the shared cache and disposing one would empty every other
  // species that borrowed it. Every material here is per-species, so all of them are ours.
  kit.geo.hull.userData.ownGeo = true;
  kit.geo.frond.userData.ownGeo = true;
  for(const m in kit.mat) kit.mat[m].userData.ownMat = true;
  return kit;
}

/* ---------------- placement ---------------- */
// the placement half of the collider invariant: world.js keeps its clearOf() private, so fauna
// re-asks the same question of the same exported array. A critter that spawns inside a rock is
// stuck forever, because tryDir() will refuse every direction out of it.
function clearOfColliders(x, z, pad){
  for(let i=0;i<COLLIDERS.length;i++){
    const c = COLLIDERS[i];
    if(c.off) continue;
    const dx = x-c.x, dz = z-c.z, rr = c.r+pad;
    if(dx*dx + dz*dz < rr*rr) return false;
  }
  return true;
}
// Predicate for scatter(): reads the FINISHED world — height, slope, exclusions and colliders —
// which is what keeps a critter out of rocks and off the ravine void.
function placeOk(sp, x, z, slopeMax){
  if(x*x + z*z > FAUNA.edgeR*FAUNA.edgeR) return false;
  if(inExclusion(x, z, sp.pad)) return false;
  const s = slopeAt(x, z);
  if(s < sp.slopeMin || s > slopeMax) return false;
  if(groundHeight(x, z) < FAUNA.minGroundH) return false;
  if(!clearOfColliders(x, z, sp.clear)) return false;
  // THE ONE TEST SLOPE AND COLLIDERS CANNOT REPLACE. Everything above says "this is legal
  // ground"; only this says "the player can get to it". A critter on a mesa shelf 3 m above every
  // neighbour passed every other check and was still unharvestable — and because the whole payout
  // is "land on it", an unreachable critter is not a hard target, it is a broken one. Deliberately
  // LAST: it is the only predicate here that can trigger a one-off flood fill.
  return reachable(x, z);
}

/* ---------------- wander ----------------
   The rev-3 resolver. ONE helper answers "can I go this way" against the world edge, exclusion
   zones, slope, colliders and ground height at once, and returns the finished step or null.
   The naive version — add a fixed turn every time you're blocked — re-tests almost the same
   failing angle next frame and the animal spins on the spot forever, which reads as broken
   rather than as stuck. Sampling alternatives and STANDING STILL when none clear is the fix. */
const STEPOUT = { x:0, z:0, h:0 };   // reused: update() must not allocate
function tryDir(c, sp, dx, dz, dist){
  const nx = c.x + dx*dist, nz = c.z + dz*dist;
  if(nx*nx + nz*nz > FAUNA.edgeR*FAUNA.edgeR) return null;         // world edge
  if(inExclusion(nx, nz, sp.pad)) return null;                     // ravine void, authored sites
  // item 57: a collider tells you about walls, a gradient tells you about hillsides. A critter
  // refusing a slope is a separate question from a critter refusing a rock, and needs both asks.
  if(slopeAt(nx, nz) > sp.maxSlope) return null;
  // HAZARD: surfaceAt() returns a SHARED module-level object. Read both fields into locals on the
  // line after the call — never keep the reference, never call it again before consuming this one.
  const surf = surfaceAt(nx, nz, c.y + FAUNA.step);
  const h = surf.h, blocked = surf.blocked;
  if(blocked) return null;                                         // wall from where we stand
  if(h < FAUNA.minGroundH) return null;                            // stepping into a hole
  if(h - c.groundY > FAUNA.step) return null;                       // ledge too tall for stubby legs
  STEPOUT.x = nx; STEPOUT.z = nz; STEPOUT.h = h;
  return STEPOUT;
}

/* ---------------- the handle ---------------- */
export function buildFauna(scene, rng, world, opts={}){
  const parent = opts.parent || scene;
  const progress = opts.progress || null;
  const particles = opts.particles || null;
  const group = new THREE.Group();
  group.name = 'fauna';
  parent.add(group);

  const kits = {};
  const critters = [];
  const roots = [];
  const G = sharedGeo();
  G.refs++;

  // ---- build one critter's rig. Every species uses the SAME rig so one update path animates
  // all of them; a species differs by geometry, material and numbers, never by structure.
  function buildCritter(sp, kit){
    const g = new THREE.Group();
    const torso = new THREE.Group();          // bobs; the feet stay parented to g so they plant
    g.add(torso);
    const hull = new THREE.Mesh(kit.geo.hull, kit.mat.hull);
    hull.castShadow = true;
    addOutline(hull, 0.045);                   // ink hull: hand-painted, not flat-shaded
    torso.add(hull);
    const cap = new THREE.Mesh(kit.geo.cap, kit.mat.cap);
    cap.scale.set(sp.capS[0]*2, sp.capS[1]*2, sp.capS[2]*2);
    cap.position.y = sp.capY;
    cap.castShadow = true;
    addOutline(cap, 0.05);
    torso.add(cap);
    const frond = new THREE.Mesh(kit.geo.frond, kit.mat.frond);
    frond.position.y = sp.frondY;
    torso.add(frond);
    const limbs = [];
    for(let i=0;i<2;i++){
      const l = new THREE.Mesh(kit.geo.limb, kit.mat.limb);
      const s = 0.30;
      // negative Y on a base-anchored cylinder hangs it downward from its attachment point
      l.scale.set(s, sp.limb === 'tendril' ? -0.52 : s*0.66, s);
      l.position.set(i ? sp.limbX : -sp.limbX, sp.limbY, 0);
      limbs.push(l);
      g.add(l);
    }
    const c = { sp, group:g, torso, hull, cap, frond, limbs,
      x:0, z:0, y:0, groundY:0, dx:0, dz:1, yaw:0, phase:0, turnT:0, shove:0,
      dead:true, dying:false, dieT:0, scale:1, seed:0, rng:null, moved:false };
    g.userData.critter = c;                    // labelFor()/entryFor() walk up to this
    g.visible = false;
    group.add(g);
    return c;
  }

  for(const sp of CRITTER_SPECIES){
    const kit = kits[sp.id] = speciesKit(sp);
    for(let i=0;i<sp.count;i++){
      const c = buildCritter(sp, kit);
      // one derived stream per critter, so wander is reproducible from the world seed and the
      // AI proofs below are repeatable instead of anecdotal
      c.seed = rng()*6.283;
      c.rng = mulberry32(((rng()*0xffffffff)>>>0) || 1);
      c.scale = 0.9 + c.rng()*0.28;
      critters.push(c);
      roots.push(c.group);
    }
  }

  // ---- population top-up. Placement goes through scatter() so spacing and the guard counter
  // come for free; the predicate is the same one used at build time.
  function place(sp, need){
    const dead = [];
    for(const c of critters) if(c.sp === sp && c.dead && !c.dying) dead.push(c);
    if(!dead.length || need <= 0) return 0;
    const area = { x:0, z:0, r0:sp.r0, r1:Math.min(sp.r1, PARAMS.scatterRMax) };
    let pts = scatter(rng, need, sp.minDist, (x,z)=>placeOk(sp, x, z, sp.slopeMax), area);
    // A world can roll a seed with no ground in a species' slope band at all. Relaxing the band
    // once beats leaving the habitat empty: an absent species reads as a bug, a slightly
    // off-habitat one does not. Note what is relaxed and what is not: the SLOPE band widens,
    // reachability never does. An off-habitat critter is a compromise; an unreachable one is the
    // bug this fallback would otherwise reintroduce on exactly the awkward seeds that need it.
    if(pts.length < need){
      const more = scatter(rng, need-pts.length, sp.minDist,
        (x,z)=>placeOk(sp, x, z, sp.maxSlope), area);
      pts = pts.concat(more);
    }
    let n = 0;
    for(const p of pts){
      const c = dead[n]; if(!c) break;
      revive(c, p.x, p.z);
      n++;
    }
    return n;
  }
  function revive(c, x, z){
    const sp = c.sp;
    c.x = x; c.z = z;
    c.groundY = groundHeight(x, z);
    c.y = c.groundY;
    const a = c.rng()*Math.PI*2;
    c.dx = Math.cos(a); c.dz = Math.sin(a);
    c.yaw = Math.atan2(c.dx, c.dz);
    c.turnT = 1.6 + c.rng()*3.2;
    c.phase = c.rng()*6.283;
    c.dead = false; c.dying = false; c.dieT = 0; c.shove = 0;
    c.group.position.set(x, c.y, z);
    c.group.rotation.y = c.yaw;
    c.group.scale.setScalar(c.scale);
    c.group.visible = true;
  }

  let respawnT = 0, chain = 0, chainT = 0, strandT = 0, stranded = 0;
  const handle = {
    critters,
    species: CRITTER_SPECIES,
    group,

    update(dt, t, playerPos, playerVy){
      /* THE STRANDED SWEEP, and it exists because gating PLACEMENT is only half the fix.
         placeOk() proves a critter is reachable where it spawns; nothing proves it stays there.
         A critter walks DOWN any drop (tryDir only refuses to RISE more than FAUNA.step), so a
         perfectly legal spawn can wander off a shelf into somewhere the player cannot follow —
         and a critter you can see, that is alive, and that you cannot land on is exactly the
         complaint this whole item came from, whichever half of the code put it there.
         So: recheck live critters against the mask on a slow tick and retire any that have got
         themselves stuck. Retiring rather than teleporting is deliberate — a creature that
         vanishes reads as one that wandered off, whereas one that blinks across the valley reads
         as a bug. The next top-up re-places it through placeOk, which is reachable by
         construction. One array lookup per critter every FAUNA.strandEvery seconds. */
      strandT += dt;
      if(strandT >= FAUNA.strandEvery){
        strandT = 0;
        for(const c of critters){
          if(c.dead || c.dying) continue;
          if(reachable(c.x, c.z)) continue;
          c.dead = true; c.group.visible = false; stranded++;
        }
      }
      respawnT += dt;
      if(respawnT >= FAUNA.respawnEvery){
        respawnT = 0;
        for(const sp of CRITTER_SPECIES){
          let live = 0;
          for(const c of critters) if(c.sp === sp && !c.dead) live++;
          if(live < sp.count) place(sp, sp.count - live);
        }
      }
      if(chain > 0){ chainT -= dt; if(chainT <= 0) chain = 0; }

      for(let i=0;i<critters.length;i++){
        const c = critters[i], sp = c.sp;
        if(c.dying){
          // death is a flatten-and-widen, not a fade: the shape reading as "squashed" is the
          // feedback that the landing did it, and it lasts long enough to see mid-chain.
          c.dieT += dt;
          const e = Math.min(1, c.dieT/0.45);
          c.group.scale.set(c.scale*(1 + e*0.62), c.scale*Math.max(0.06, 1 - e*0.94), c.scale*(1 + e*0.62));
          if(e >= 1){ c.dying = false; c.dead = true; c.group.visible = false; }
          continue;
        }
        if(c.dead) continue;

        // --- wander. Current heading first; only sample alternatives when it actually fails.
        const dist = sp.speed*dt;
        let step = tryDir(c, sp, c.dx, c.dz, dist);
        if(!step){
          c.turnT = 0.6 + c.rng()*1.4;
          for(let k=0;k<FAUNA.alts;k++){
            const a = c.rng()*Math.PI*2;
            const ndx = Math.cos(a), ndz = Math.sin(a);
            step = tryDir(c, sp, ndx, ndz, dist);
            if(step){ c.dx = ndx; c.dz = ndz; break; }
          }
        }
        // No alternative cleared: STAND STILL. Boxed in, the next frame re-samples 8 fresh
        // headings, so it walks out the instant anything opens — but it never spins while waiting.
        c.moved = !!step;
        if(step){
          c.x = step.x; c.z = step.z; c.groundY = step.h;
        }
        // idle heading change on a timer, so an unblocked critter still wanders
        c.turnT -= dt;
        if(c.turnT <= 0){
          c.turnT = 1.6 + c.rng()*3.4;
          const a = Math.atan2(c.dx, c.dz) + (c.rng()-0.5)*2.4;
          c.dx = Math.sin(a); c.dz = Math.cos(a);
        }
        // side contact is a shove, never damage. This is the whole contact model: the critter
        // gets out of the way and the player's health bar never learns it happened.
        if(playerPos && c.shove <= 0){
          const px = playerPos.x - c.x, pz = playerPos.z - c.z;
          const rr = sp.reach + 0.7;
          if(px*px + pz*pz < rr*rr){
            const d = Math.sqrt(px*px + pz*pz) || 1;
            c.dx = -px/d; c.dz = -pz/d; c.shove = 0.4;
          }
        }
        if(c.shove > 0) c.shove -= dt;

        // --- animation. INVARIANT: the gait phase only advances when the critter actually
        // moved, so a blocked one stands and breathes instead of jogging on the spot.
        if(c.moved) c.phase += sp.gait*dt;
        const bob = c.moved ? Math.abs(Math.sin(c.phase))*sp.bob : 0;
        const breathe = Math.sin(t*1.7 + c.seed)*0.035;
        c.y = c.groundY + sp.hover*(1 + Math.sin(t*1.3 + c.seed)*0.22);
        c.group.position.set(c.x, c.y, c.z);
        c.torso.position.y = sp.torsoY + bob + breathe;
        // yaw only follows the heading while moving — a stalled critter does not pirouette
        if(c.moved){
          const want = Math.atan2(c.dx, c.dz);
          let d = want - c.yaw;
          while(d > Math.PI) d -= Math.PI*2;
          while(d < -Math.PI) d += Math.PI*2;
          c.yaw += d*Math.min(1, dt*7);
          c.group.rotation.y = c.yaw;
        }
        // pulsing cap + drifting fronds: the "something alive" layer, running whether it walks or not
        const pulse = Math.sin(t*2.1 + c.seed*1.7);
        c.cap.scale.set(sp.capS[0]*2*(1 - pulse*0.035), sp.capS[1]*2*(1 + pulse*0.08), sp.capS[2]*2*(1 - pulse*0.035));
        c.frond.rotation.z = Math.sin(t*1.45 + c.seed)*0.20;
        c.frond.rotation.x = Math.cos(t*1.15 + c.seed*0.6)*0.14;
        // breathing hull: tiny, always on, and the reason a standing critter still reads as alive
        c.hull.scale.set(1 - breathe*0.5, 1 + breathe*1.4, 1 - breathe*0.5);
        // limb swing, opposed phase. Also gated on moved: planted feet when standing.
        for(let k=0;k<2;k++){
          const l = c.limbs[k];
          const ph = c.phase + k*Math.PI;
          l.position.z = c.moved ? Math.sin(ph)*sp.stride : 0;
          l.position.y = sp.limbY + (c.moved ? Math.max(0, Math.sin(ph))*sp.lift : 0);
        }
      }
    },

    // THE stomp window. Descending, feet inside the band under the critter's top, horizontally
    // over it. `vy < 0` plus the band is what makes an ascending pass and a walk-through both
    // miss without needing to know anything about the player's state machine.
    tryStomp(playerPos, playerVy){
      if(!playerPos || !(playerVy < 0)) return null;
      for(let i=0;i<critters.length;i++){
        const c = critters[i];
        if(c.dead || c.dying) continue;
        const sp = c.sp;
        const top = c.y + sp.top*c.scale;
        if(playerPos.y <= top - FAUNA.stompBand) continue;
        if(playerPos.y >= top + FAUNA.stompCeil) continue;
        const dx = playerPos.x - c.x, dz = playerPos.z - c.z;
        const rr = sp.reach*c.scale;
        if(dx*dx + dz*dz > rr*rr) continue;
        return harvest(c);
      }
      return null;
    },

    // main.js calls this the moment the player touches the ground: landing is what ends a chain.
    // The chainWindow timer is only the fallback for a chain that ends in mid-air.
    resetChain(){ chain = 0; chainT = 0; },
    get chain(){ return chain; },
    // how many critters the sweep has had to retire this run. Should stay at or near zero; a
    // number that climbs means either the mask or the wander resolver is wrong, and this is the
    // only way to tell which without watching one for ten minutes.
    get strandedCount(){ return stranded; },

    // stable for the whole run: a dead critter's group stays parented and turns invisible, so
    // main.js registers its hover tags ONCE and never has to re-register after a respawn.
    hoverTargets(){ return roots; },
    labelFor(obj){
      for(let o = obj; o; o = o.parent){
        const c = o.userData && o.userData.critter;
        if(c) return (c.dead || c.dying) ? null : labelOf(c.sp);
      }
      return null;
    },

    dispose(){
      for(const c of critters) group.remove(c.group);
      critters.length = 0; roots.length = 0;
      for(const id in kits){
        const k = kits[id];
        for(const g in k.geo) if(k.geo[g].userData.ownGeo) k.geo[g].dispose();
        for(const m in k.mat) if(k.mat[m].userData.ownMat) k.mat[m].dispose();
      }
      if(group.parent) group.parent.remove(group);
      // Shared primitives are refcounted: dropping them while another world still holds a handle
      // would empty every critter it owns.
      if(--G.refs <= 0){
        for(const g in GEO) if(GEO[g] && GEO[g].dispose) GEO[g].dispose();
        GEO = null;
      }
    },
  };

  function labelOf(sp){
    const d = sp.drop;
    const pay = d.essence ? 'essence' : d.myco ? 'Mycelium' : d.harvestN ? (SPECIES_BY_ID[sp.harvest] || {name:'spores'}).name + ' spores' : 'coins';
    return sp.icon + ' ' + sp.name + ' — land on it for ' + pay;
  }

  // ONE payout chokepoint: every harvest, from any species, goes through here, so the chain
  // maths, the currency credit, the puff and the pop all stay consistent by construction.
  function harvest(c){
    const sp = c.sp, d = sp.drop;
    const used = chain;                       // 0-based un-broken count, per progress.js's contract
    chain = used + 1; chainT = FAUNA.chainWindow;
    // progress.js owns the coins and the 12% critter lockpick roll; fauna.js never touches
    // localStorage and never rolls its own odds.
    const banked = progress ? progress.stompCritter(used) : null;
    const reward = banked ? Object.assign({ banked:true }, banked)
      : { banked:false, coins:Math.min(12, 2 + used*2), lockpick:false, lockpicks:0, coinsTotal:0 };
    reward.species = sp.id; reward.name = sp.name; reward.icon = sp.icon;
    reward.chain = used;
    reward.essence = d.essence ? Math.min(d.essenceCap, Math.round(d.essence + used*d.essencePer)) : 0;
    reward.myco = d.myco ? Math.min(d.mycoCap, Math.round(d.myco + used*d.mycoPer)) : 0;
    reward.harvest = d.harvestN
      ? { id:sp.harvest, n:Math.min(d.harvestCap, d.harvestN + used*d.harvestPer) } : null;
    reward.label = sp.icon + ' ' + sp.name + (used > 0 ? ' ×' + (used+1) : '');
    // death starts here; the mesh lives 0.45s longer so the squash is visible mid-chain
    c.dying = true; c.dieT = 0;
    if(particles) particles.puff(c.x, c.y + sp.top*0.6*c.scale, c.z,
      { color:sp.color, n:9, size:9, life:0.5, rise:2.4, spread:2.6, grav:5, alpha:0.9 });
    return { critter:c, species:sp, reward, chain:used, popVy:FAUNA.popVy };
  }

  // initial population, before the first respawn tick
  for(const sp of CRITTER_SPECIES) place(sp, sp.count);
  // exposed so a debug path (or ?demo) can force a harvest without faking a descent through
  // the stomp window. Everything real should go through tryStomp().
  handle.harvest = harvest;
  return handle;
}
