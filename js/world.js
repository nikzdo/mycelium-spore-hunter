// world.js — terrain, sky, vegetation, atmosphere
import * as THREE from 'three';
import { makeNoise, fbmOf, srgbTriple, paintTexture, toonMat, addOutline } from './fx.js';
import { mulberry32, deriveSeed } from './rng.js';
import { MUSHROOM_SPECIES, SPECIES_BY_ID } from './mushrooms.js';
import { makeStack, mergeStacks, jitterLattice, PRESETS } from './rockgen.js';
import { makePalette, jitterFor, rockSetFor } from './palette.js';

export const WORLD_SIZE = 420;

/* ---------------- movement constants surfaceAt() must agree with ----------------
   These are entities.js's numbers (items 02-04 export them there in a later wave).
   Duplicated rather than imported because entities.js imports world.js — the cycle
   would leave them in TDZ while this module initialises.
   A movement constant is a level-design constraint: STEP is the tallest ledge you can
   walk onto without jumping, so it is ALSO the threshold under which a prop must not get
   a collider — an ankle-high rock you can't walk over reads as a bug, not as terrain. */
const STEP = 1.5;
const PLAYER_R = 0.85;
const PLAYER_H = 2.55;

/* ---------------- generation knobs (item 32) ----------------
   The world is a pure function of (seed, PARAMS): every count, radius, density and
   probability that generation reads lives here, so the dev panel can rebuild a world by
   writing into this object instead of editing code.
   Deliberately NOT here: terrain height coefficients (the shape of the land, owned by
   baseTerrainHeight) and geometry/appearance constants, which stay at their use site. */
export const PARAMS = {
  /* --- terrain shape (items 08, 22, 23, 24, 26, 27). Heights are METRES; see the amplitude
     convention above baseTerrainHeight() before changing any of the *A coefficients. --- */
  // mesh extent. Deliberately LARGER than WORLD_SIZE: the wobbled rim crest (edgeRMin+edgeRVar,
  // up to 232) plus its outer skirt has to fit inside the mesh, or the boundary wall would be
  // cut off in the axis directions and you would see sky where the ground should be.
  terrainSpan: 500, terrainSegs: 172,
  // item 22 — domain warp. warpR0/R1 ramp the warp in with radius: a constant warp at the origin
  // makes every angle-derived boundary pinwheel around the spawn point.
  warpFreq: 0.0055, warpAmp: 27, warpR0: 28, warpR1: 150,
  // item 23 — world edge. edgeRMin is the PLAYABILITY FLOOR: entities.js clamps the player to
  // radius 195, so the crest must never come inside that. The wobble is added, never subtracted.
  edgeRMin: 200, edgeRVar: 32, edgeGain: 1.15, edgeLoopR: 2.5,
  rimHMin: 18, rimHVar: 18,
  edgeLock: 0.975,          // >= 195/edgeRMin, so the "rim wins" override cannot reach into play
  edgeSkirt: 0.42, edgeSkirtMax: 11,
  // item 24 — authored radial silhouette, in fractions of the crest radius. These are the RANGES
  // the per-world curve is rolled from (see rollShape): the four-part profile is authored, but a
  // world picks a tight basin under a tall rim or a broad shallow terrace under a low one. Without
  // this the silhouette is identical in every world and swamps every per-seed difference in it.
  silBasin: 0.16, silBasinVar: 0.09, silRamp: 0.48, silRampVar: 0.14,
  silTerr: 0.68, silTerrVar: 0.12, terraceH: 6, terraceHVar: 8,
  rimScaleMin: 0.80, rimScaleVar: 0.55, reliefMulMin: 0.70, reliefMulVar: 0.85,
  regBiasVar: 0.24,
  // item 27 — regions. regLo/regHi split one weight field into plains / broken / hills.
  regFreq: 0.0042, regLo: -0.06, regHi: 0.10, regBand: 0.30,
  regPlainF: 0.013, regPlainA: 4.5,
  regHillF: 0.020,  regHillA: 20,
  regBrokeF: 0.034, regBrokeA: 12,
  // hills/mound mask + fine detail. Thresholds are on NORMALIZED fbm (range ~+/-0.45).
  moundMF: 0.006, moundMLo: 0.03, moundMHi: 0.42, moundF: 0.023, moundA: 15,
  detailF: 0.055, detailA: 2.2,
  clearR0: 8, clearR1: 44, reliefFade: 0.80, reliefFadeAmt: 0.85,
  // item 26 — authored sites: hand-placed bowl/rim/plinth set-pieces the noise carves around
  siteChance2: 0.55, siteDMin: 58, siteDVar: 105,
  siteRMin: 17, siteRVar: 8, siteCoreR: 0.16,
  siteCoreMin: 1.8, siteCoreVar: 1.8, siteBowlMin: 2.2, siteBowlVar: 2.4,
  siteRimMin: 4, siteRimVar: 4,
  /* Canopy lightness is NOT a knob here any more: palette.js solves it per world, because the
     legal window between "separates from the sky" and "separates from the ground" moves with the
     hour — a noon world wants dark canopies and a gloaming world pale ones, and one authored
     range cannot be both. `theme.canopyL` is the drop-in [min, var] pair if a panel ever needs it. */
  // atmosphere + light rig (items 06, 43)
  // shadowBox is the RESOLUTION dial, not a coverage dial: main.js retargets the sun at the player
  // every frame, so the box only ever has to cover what is near them. The same map over a smaller
  // box is a sharper shadow everywhere one can actually be seen, and sharpness is most of what
  // separates "shadow" from "smudge". 120 -> 95 takes 2048 from 8.5 to 10.8 texels per metre.
  // Not tighter: a shadow outside the box stops existing, and at 95 m that edge is deep in the fog,
  // whereas at 70 it fell on ground the player can still read and the shadows visibly popped in.
  fogDensity: 0.0030, shadowMap: 2048, shadowBox: 95, shadowBias: -0.0007, shadowNormalBias: 0.4,
  // ravine: the bridge-crossing layout feature. not every world gets one.
  ravChance: 0.6, ravDMin: 45, ravDVar: 70, ravSegMin: 30, ravSegVar: 30,
  ravBend: 1.6, ravWMin: 5, ravWVar: 3, ravDepthMin: 5, ravDepthVar: 3,
  // themed pockets: each rolled independently, so a world can have none, some or all
  pockRMin: 14, pockRVar: 10,
  crystalChance: 0.55, crystalPMin: 30, crystalPMax: 165,
  warrenChance: 0.55,  warrenPMin: 20,  warrenPMax: 150,
  witherChance: 0.5,   witherPMin: 20,  witherPMax: 100,
  // fen hollow: a boggy patch — reeds + lily pads, and the one pocket that touches player
  // speed (fenBogAt, read by entities.js) rather than being scenery-only like the other three
  fenChance: 0.45,     fenPMin: 20,     fenPMax: 145,
  fenReedMin: 16, fenReedVar: 14, fenReedHMin: 0.6, fenReedHVar: 0.9,
  fenPadMin: 4,   fenPadVar: 5,  fenWisps: 46,
  // scorched hollow: ash and embers — atmosphere-only, like crystal/withered, no gameplay hook
  scorchChance: 0.5, scorchPMin: 20, scorchPMax: 130,
  scorchRockMin: 8, scorchRockVar: 8, scorchEmbers: 34,
  // per-pocket ambient signature for the two that didn't have one yet (crystal hollow already
  // has its orbiting motes, fen hollow its rising wisps)
  warrenSpores: 30, witherMotes: 26,
  // big set-pieces: rolled per world, floor of 2 so no world is a bare field
  landmarkChance: 0.62, landmarkMin: 2,
  // trees
  treeTries: 520, treeMax: 110, treeDMin: 16, treeDMax: 195, treeGrove: -0.05,
  treeSMin: 0.8, treeSVar: 0.9,
  // rocks: ambient scatter + dramatic formations + cave-mouth walls, all one draw call
  rockAmbient: 70, rockSpread: 0.9, rockSMin: 0.5, rockSVar: 2.2,
  formMin: 3, formVar: 3, formDMin: 20, formDVar: 165, formSpread: 3.5,
  formMemMin: 4, formMemVar: 5, formSMin: 1.2, formSVar: 2.6,
  /* --- stepped rock formations (items 34, 55): the ONLY props you climb by jumping.
     stepRise is a level-design constraint, not taste. entities.js: a standing jump is JUMP_VY 11
     against gravity 30, so the feet clear 11^2/60 = 2.02 m, and STEP 1.5 is the tallest ledge you
     walk onto for free. Every rise is authored into the band between the two — above STEP so a
     tier must be jumped, under the apex so it can be. Move either number and re-derive these. --- */
  /* --- stepped rock formations (items 34, 55): the only props you climb by jumping.
     Every knob below is a [base, range] pair sampled from one seeded stream, because SCALE IS
     PART OF THE GENERATION: a world has to be able to produce a knee-high step, a three-jump
     terrace and a six-tier landmark, sampled continuously rather than snapped to three sizes.
     stepRise is the load-bearing one: entities.js gives the feet a 2.02 m apex (JUMP_VY 11 vs
     gravity 30) and STEP 1.5 as the free walk-up, so every rise is authored between them —
     which is what makes a formation of ANY height a climb rather than a wall. --- */
  stepRiseMin: 1.55, stepRiseVar: 0.30,   // 1.55-1.85 m per tier: over STEP, under the apex
  // how many of each size class this world gets: [gentle world, badlands world], lerped by one
  // seeded bias roll, so seeds differ in CHARACTER (mesa badlands vs one dramatic tower) and not
  // just in where the same five rocks landed. Same principle as SHAPE for the silhouette.
  stepSmallN: [8, 4], stepMedN: [1, 5], stepBigN: [1, 3],
  // the size parameter u, per class. The bands OVERLAP so the realized distribution is continuous.
  stepUSmall: [0.02, 0.30], stepUMed: [0.30, 0.34], stepUBig: [0.62, 0.38],
  stepTierMax: 6, stepRMin: 1.5, stepRVar: 7.0, stepCellMin: 2, stepCellVar: 9,
  // independent of size, so two formations of the same height still differ: a tight shrink reads
  // as a tower and a loose one as a plateau, cap flatness decides fightable-top vs spiky.
  stepShrink: [0.62, 0.28], stepTaper: [0.78, 0.19], stepDrift: [0.18, 0.34],
  // A LEDGE HAS TO BE STANDABLE, so the shrink between tiers is capped by the footprint rather
  // than rolled freely: the ring left on top of a tier is cr*(1-shrink), surfaceAt pads the tier
  // above by PLAYER_R*0.55, and a ring narrower than this has nowhere to put the player's feet —
  // a "staircase" with no treads is just a wall with lines drawn on it.
  stepLedgeMin: 1.25,
  stepCapRise: [0.02, 0.30], stepCapJit: [0.02, 0.14], stepWobble: [0.10, 0.20],
  stepSpacing: [1.7, 0.6], stepSides: [5, 10], stepSink: 0.12,
  stepEdgeScale: 0.80,   // rim cells stay short and few-tiered: the ramp on, before the climb
  stepTallMul: 1.8,      // one rim block pushed past the apex, reachable only from a tier
  stepSlope: 0.42, stepMinH: -1.5, stepPadK: 0.6, stepPadMax: 14, stepCellPad: 2.0,
  stepDMin: 26, stepDMax: 168, stepEdgeBand: 16, stepSiteApron: 26,
  caveSecondChance: 0.5, caveDMin: 50, caveDVar: 110, caveSpikes: 4,
  caveWalls: 8, caveWallRMin: 2.6, caveWallRVar: 2.4, caveWallSMin: 2.2, caveWallSVar: 1.8,
  // underground chamber a cave mouth actually leads to: a flat disc far outside the playable
  // disc (terrainSpan is 500, so anything past ~300 is empty space to build a sealed room in),
  // walled by the same rockPlacements/InstancedMesh the surface uses so it costs zero extra
  // draw calls. Spaced by the golden angle per cave index so two chambers can never overlap.
  caveChamberDist: 420, caveChamberSpacing: 260, caveChamberR: 30, caveChamberWallR: 25,
  caveChamberWalls: 18, caveChamberWallSMin: 2.6, caveChamberWallSVar: 2.0,
  caveChamberFloorY: -6, caveChamberCrystals: 6, caveChamberShrooms: 7,
  boulderDMin: 30, boulderDVar: 140, boulderSMin: 3.2, boulderSVar: 1.2,
  // bushes / fallen logs
  bushCount: 70, bushRMin: 9, bushRVar: 160, bushSMin: 0.5, bushSVar: 0.7,
  logCount: 22, logRMin: 14, logRVar: 165, logSMin: 0.7, logSVar: 0.7,
  logBitsMin: 2, logBitsVar: 3, logBlobChance: 0.6,
  // ground cover
  grassCount: 22000, grassRMin: 4, grassRVar: 150,
  flowerCount: 300, flowerRMin: 6, flowerRVar: 160,
  // decorative harvestable mushrooms
  decoCount: 90, decoRMin: 8, decoRVar: 170, decoSMin: 0.6, decoSMax: 2.2,
  warrenMin: 24, warrenVar: 14, warrenDom: 0.7,
  caveShrooms: 4, respawnMin: 45, respawnVar: 35,
  // crystals — Crystal Hollow pocket + cave chambers only, no ambient map-wide scatter (removed
  // on purpose: a crystal seam is what Crystal Hollow IS, not background dressing)
  hollowMin: 5, hollowVar: 3, hollowShardMin: 3, hollowShardVar: 3,
  hollowSMin: 0.3, hollowSVar: 0.5,
  // withered hollow spikes
  witherSpikeMin: 4, witherSpikeVar: 4, witherHMin: 2, witherHVar: 2.5,
  // authored landmarks
  towerDMin: 130, towerDVar: 45,
  stoneCount: 7, stoneDMin: 85, stoneDVar: 55, stoneRing: 10, stoneHMin: 7, stoneHVar: 3,
  geyserCount: 4, geyserDMin: 45, geyserDVar: 115,
  pondDMin: 55, pondDVar: 90, pondPads: 9,
  ruinsDMin: 60, ruinsDVar: 110, ruinsWalls: 6, ruinsRubble: 14,
  summitDMin: 90, summitDVar: 70, summitTiers: 6, summitTierH: 1.7, summitR0: 7.5,
  shrineCount: 2, // plus one more, guaranteed, at the summit's peak if that landmark rolled
  // ambient life + sky dressing
  cloudCount: 20, mtnPerRing: 8, rayCount: 8,
  fireflies: 240, pollen: 200, petals: 24, birds: 6, butterflies: 8,
  frogs: 3, rabbits: 4,
  // placement: rejection sampling, exclusion clearances, spawn search (items 09, 28)
  scatterTries: 26,                 // attempts per accepted point before scatter gives up short
  scatterRMin: 8, scatterRMax: 178, // default sampling annulus = the playable ring
  exclRavine: 1.0,                  // keep-out beyond the ravine's own half-width
  exclCave: 6, exclBridge: 7, exclPond: 9.5,
  siteSlope: 0.7, sitePad: 3, siteClear: 3,   // what an authored landmark needs underfoot
  decoMinDist: 2.0, decoSlope: 1.1, decoClear: 1.0,
  decoCap: 220,                     // instance capacity for the harvestable batch (item 35)
  spawnTries: 900, spawnR: 42, spawnSlope: 0.55, spawnClear: 2.4,
};

/* ---------------- per-world noise fields (item 07) ----------------
   One INDEPENDENT field per subsystem, each built from its own derived stream. This replaced a
   single fixed field with a per-seed offset slid over it, and the difference is the whole point:
   an offset gives every world the SAME ridges in a new place — same character, different window.
   A separate permutation is a different lattice, so seeds differ in kind, not just in framing.
   It also decouples tuning: the warp and the coastline no longer read the same numbers, so
   changing one cannot reshape the other.
   Salts are arbitrary but must stay unique — reusing one silently re-couples two subsystems. */
let F = buildFields(1);   // built at load so a stray sample before buildWorld() can't hit null
function buildFields(seed){
  return {
    warp:   makeNoise(mulberry32(deriveSeed(seed, 0x0a11))),  // item 22 — domain warp
    coast:  makeNoise(mulberry32(deriveSeed(seed, 0xc0a5))),  // item 23 — edge radius + rim height
    region: makeNoise(mulberry32(deriveSeed(seed, 0x2e91))),  // item 27 — which region is where
    relief: makeNoise(mulberry32(deriveSeed(seed, 0x8e11))),  // item 27 — per-region relief
    mound:  makeNoise(mulberry32(deriveSeed(seed, 0x3707))),  // hill mask + broad mounds
    detail: makeNoise(mulberry32(deriveSeed(seed, 0xd37a))),  // fine relief, colour blotches, prop jitter
  };
}

/* ---------------- per-world layout, decided before the heightfield is sampled ----------------
   buildTerrain() owns all of this because the terrain mesh has to be able to see it: the ravine
   cuts the height, the authored sites carve it, and the pockets tint it. buildProps() then reads
   the same state, which is why props land in the places the terrain was shaped for. */
let THEME = null;                   // this world's palette, built by buildTerrain via makePalette()
// seeded ravine (gully) for this world — null if this world doesn't have one.
// a 2-segment bent path {ax,az -> bx,bz -> cx,cz} with a width/depth.
let RAVINE = null;
let POCKETS = {};                   // themed clusters, may be empty
let LANDMARKS = [];                 // which big set-pieces this world rolled
let QUALITY = 1;                    // buildWorld's quality argument, needed by both halves
// item 26 — authored sites, read by baseTerrainHeight(). Never reassigned: truncate in place.
const SITES = [];
// underground cave chambers — sealed rooms far outside the playable disc, one per cave mouth.
// groundHeight() checks this before the noise pipeline, so a chamber's flat floor overrides
// whatever the skirt/rim math would otherwise put out there. Never reassigned: truncate in place.
const CAVE_CHAMBERS = [];
/* items 24/27 — this world's pick from the shape RANGES in PARAMS. The curve is authored; which
   curve you get is rolled. Keeping the pick here rather than writing into PARAMS matters: PARAMS
   is the tuning surface item 10's panel edits, and a generator that mutated it would drift its own
   ranges away every rebuild. */
let SHAPE = rollShape(()=>0.5);   // midpoint defaults until buildTerrain rolls a real one
function rollShape(rng){
  const basin = PARAMS.silBasin + rng()*PARAMS.silBasinVar;
  const ramp  = PARAMS.silRamp  + rng()*PARAMS.silRampVar;
  const terr  = PARAMS.silTerr  + rng()*PARAMS.silTerrVar;
  return {
    basin, ramp: Math.max(basin+0.08, ramp), terr: Math.max(ramp+0.06, terr),
    terrace: PARAMS.terraceH + rng()*PARAMS.terraceHVar,
    rimScale: PARAMS.rimScaleMin + rng()*PARAMS.rimScaleVar,
    reliefMul: PARAMS.reliefMulMin + rng()*PARAMS.reliefMulVar,
    regBias: (rng()-0.5)*PARAMS.regBiasVar,
  };
}
let WORLD = null;                   // the world object buildTerrain built, so buildProps can be
                                    // called with the contract's 2-argument signature

/* item 41(b) — HSL arithmetic belongs in sRGB. THREE.Color.offsetHSL()/setHSL() default to the
   WORKING colour space, which is linear-sRGB on r160: an authored lightness of 0.42 ends up
   displaying around 0.68 (washed out) and a hue offset rotates non-perceptually, bunching up in
   the greens. Round-tripping through sRGB is the fix, and it has to happen at every call site —
   a single missed one shows up as one prop that doesn't match the palette. */
const _hsl = { h:0, s:0, l:0 };
function offsetHSLsRGB(c, dh, ds, dl){
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return c.setHSL(_hsl.h + dh, THREE.MathUtils.clamp(_hsl.s + ds, 0, 1),
    THREE.MathUtils.clamp(_hsl.l + dl, 0, 1), THREE.SRGBColorSpace);
}

/* THE WORLD COLOUR IS APPLIED EXACTLY ONCE PER SURFACE.
   MeshToonMaterial multiplies material.color * map * instanceColor. A palette hex sitting in the
   material AND in its paintTexture map AND in the per-instance colour therefore renders as that
   hex CUBED — a near-black forest, which is the exact failure palette.js's "a canopy is never
   effectively black" floor exists to prevent, and it would also throw away every contrast ratio
   the palette was solved against. So: material.color is white, the MAP carries the base tone
   (that is what makes it painterly), and the instance colour carries only the RATIO of this
   instance's own colour to that base tone. The product is the colour the palette solved, with
   the texture's own light/dark variation riding on top.
   Mutates and returns `col`, so a build loop reuses one Color and allocates nothing. */
const RATIO_FLOOR = 1/255;   // a base channel of exactly 0 would divide the ratio to Infinity
function ratioTo(col, base){
  return col.setRGB(col.r/Math.max(base.r, RATIO_FLOOR),
                    col.g/Math.max(base.g, RATIO_FLOOR),
                    col.b/Math.max(base.b, RATIO_FLOOR));
}

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

/* ================= terrain shape (items 08, 22, 23, 24, 26, 27, 29) =================

   AMPLITUDE CONVENTION (item 08). fbmOf() is NORMALIZED: it divides by the summed octave
   amplitude, so its range is the underlying field's range (measured: ~-0.45..+0.49, sd 0.15)
   whatever `oct` is. The legacy unnormalized fbm() shrank as you removed octaves, which is why
   changing "detail" used to silently change the height of the world. Consequences:
     - a coefficient written `* 20` is a term that peaks near +/-9 m, and 20 is the only number
       you need to touch to change that;
     - `oct` is now a pure detail control — raise it and the silhouette does not move;
     - thresholds compared against fbmOf output (the hill mask, the region split) live on the
       +/-0.45 scale, NOT the old +/-0.40 one. All of these are in PARAMS.

   COMPOSITION ORDER (item 29). Read top to bottom. Each term knows whether it NEGOTIATES (adds
   into the running height and can be overruled) or WINS (overwrites what came before). Anything
   added later belongs in this list, at the position its authority demands — not on the end.
     1. domain warp     (item 22)  displaces (x,z) BEFORE any distance or angle is taken, ramped
                                   in with radius so the origin cannot pinwheel.
     2. base silhouette (item 24)  an AUTHORED radial curve: basin, quadratic ramp, terrace,
                                   quintic ease into the rim. The profile of the world.
     3. region relief   (item 27)  one field at a per-region offset/frequency/amplitude, weighted
                                   by that region's mask.                          NEGOTIATES
     4. mounds + detail            broad masked hills and fine roughness.          NEGOTIATES
     5. authored carve  (item 26)  hand-placed sites blend the terrain TOWARD their own profile,
                                   so a site beats whatever the noise wanted.       WINS locally
     6. edge falloff    (item 23)  the rim overwrites everything past edgeLock*crest, so no
                                   amount of relief or carving can gap the boundary. WINS
   Terms 3 and 4 are muted inside the spawn clearing, so spawn stays flat and readable no matter
   what the noise rolled — that mask is on the negotiating terms only, deliberately: an authored
   site or the rim would still win there, and neither is ever placed that close. */

// item 22. Warped coordinates in a shared 2-slot object. groundHeight() runs for every entity
// every frame, so returning a literal here would be hundreds of garbage objects a second —
// read .x/.z immediately and never keep the reference.
const W = { x:0, z:0 };
function warpAt(x, z, d){
  const amt = THREE.MathUtils.smoothstep(d, PARAMS.warpR0, PARAMS.warpR1) * PARAMS.warpAmp;
  if(amt <= 0){ W.x = x; W.z = z; return W; }
  const f = PARAMS.warpFreq;
  W.x = x + fbmOf(F.warp, x*f + 3.1, z*f - 1.7, 2)*amt;
  W.z = z + fbmOf(F.warp, x*f - 8.3, z*f + 5.9, 2)*amt;
  return W;
}

// item 23. The world edge is a shaped curve, not a circle. Sampling the wobble along a CIRCLE in
// noise space is the whole trick: the path is closed, so R(-pi) === R(+pi) and the boundary is
// continuous where the angle wraps. Sampling fbm(angle) directly leaves a cliff there, which is
// why a "wobbly coastline" usually can't be done at all.
// PLAYABILITY INVARIANT: crest = edgeRMin + a strictly POSITIVE wobble. entities.js clamps the
// player to radius 195 and the enemy spawner rejects past 190, so edgeRMin (200) is the floor
// that keeps the boundary wall outside the playable disc in EVERY direction of EVERY world.
// Do not make the wobble signed, and do not lower edgeRMin below 195.
function edgeWob(ang, ox, oz){
  const v = fbmOf(F.coast, Math.cos(ang)*PARAMS.edgeLoopR + ox, Math.sin(ang)*PARAMS.edgeLoopR + oz, 3);
  return THREE.MathUtils.clamp(0.5 + PARAMS.edgeGain*v, 0, 1);
}
// Both the crest radius and the rim height are functions of ANGLE ALONE, so they are baked once
// per world into a wrap-around table instead of running two 3-octave fBms inside every height
// query. baseTerrainHeight() runs for every entity every frame; six noise samples that can only
// depend on atan2(z,x) have no business in it (measured 0.43 -> 0.33 us per query). 512 bins is
// 0.7 degrees, finer than the wobble's own wavelength, and slot [BINS] repeats slot [0] so the
// interpolation needs no wrap test.
const EDGE_BINS = 512, TAU = Math.PI*2;
const EDGE_R = new Float32Array(EDGE_BINS+1), EDGE_H = new Float32Array(EDGE_BINS+1);
const E = { r:0, h:0 };   // shared, like SURF and W: read immediately, never store
function bakeEdge(){
  for(let i=0;i<EDGE_BINS;i++){
    const a = i/EDGE_BINS*TAU;
    EDGE_R[i] = PARAMS.edgeRMin + PARAMS.edgeRVar*edgeWob(a, 0, 0);
    EDGE_H[i] = (PARAMS.rimHMin + PARAMS.rimHVar*edgeWob(a, 17.3, -9.1))*SHAPE.rimScale;
  }
  EDGE_R[EDGE_BINS] = EDGE_R[0]; EDGE_H[EDGE_BINS] = EDGE_H[0];
}
function edgeAt(ang){
  let t = (ang < 0 ? ang + TAU : ang)*(EDGE_BINS/TAU);
  if(!(t >= 0)) t = 0; else if(t > EDGE_BINS) t = EDGE_BINS;   // atan2 returns exactly +pi
  const i = t < EDGE_BINS ? t|0 : EDGE_BINS-1, f = t - i;
  E.r = EDGE_R[i] + (EDGE_R[i+1]-EDGE_R[i])*f;
  E.h = EDGE_H[i] + (EDGE_H[i+1]-EDGE_H[i])*f;
  return E;
}
export function edgeCrest(ang){ return edgeAt(ang).r; }
bakeEdge();   // default SHAPE, so a sample before buildTerrain still reads a sane edge

// item 24. The authored radial profile — drawn, then roughened, never summed out of noise.
// A quadratic ramp leaves the basin lip gentle and steepens outward; a quintic ease is flat at
// BOTH ends, which is what makes the shelf read as a terrace and the rim as a shoulder instead
// of the uniform bowl two multiplied smoothsteps give you. u = 0 at the centre, 1 at the crest.
function silhouette(u, terrace, rim){
  if(u <= SHAPE.basin) return 0;                           // basin: dead flat. spawn must READ.
  if(u < SHAPE.ramp){
    const t = (u - SHAPE.basin)/(SHAPE.ramp - SHAPE.basin);
    return terrace*t*t;                                    // quadratic ramp out of the basin
  }
  if(u < SHAPE.terr) return terrace;                        // the terrace shelf
  const t = Math.min(1, (u - SHAPE.terr)/(1 - SHAPE.terr));
  return terrace + (rim - terrace)*(t*t*t*(t*(t*6-15)+10)); // quintic ease into the rim
}

// item 27. Three regions from one weight field, then the SAME relief field sampled at a different
// offset, frequency and amplitude per region. Variety for the cost of the samples we already pay:
// no extra fields, no extra tuning surface, and because the weights sum to 1 the regions
// cross-fade into each other instead of stacking into one lumpy average.
function regionRelief(wx, wz){
  const rv = fbmOf(F.region, wx*PARAMS.regFreq + 11.4, wz*PARAMS.regFreq - 4.2, 2);
  // regBias slides the whole split per world, so one world is mostly plains with a hill shoulder
  // and the next is mostly hills with a broken spine — same three regions, different country.
  const lo = PARAMS.regLo + SHAPE.regBias, hi = PARAMS.regHi + SHAPE.regBias;
  const wPlain = 1 - THREE.MathUtils.smoothstep(rv, lo, lo + PARAMS.regBand);
  const wHill  = THREE.MathUtils.smoothstep(rv, hi - PARAMS.regBand, hi);
  const wBroke = Math.max(0, 1 - wPlain - wHill);
  let h = 0;
  if(wPlain > 0.002) h += wPlain*PARAMS.regPlainA*fbmOf(F.relief, wx*PARAMS.regPlainF + 61, wz*PARAMS.regPlainF + 23, 2);
  if(wHill  > 0.002) h += wHill *PARAMS.regHillA *fbmOf(F.relief, wx*PARAMS.regHillF - 140, wz*PARAMS.regHillF + 88, 3);
  if(wBroke > 0.002){
    // ridged: folding |n| turns the same field into sharp crests, so the transition band reads as
    // broken rock rather than a softer version of the dunes either side of it.
    const n = fbmOf(F.relief, wx*PARAMS.regBrokeF + 300, wz*PARAMS.regBrokeF - 210, 3);
    h += wBroke*PARAMS.regBrokeA*(0.45 - 2*Math.abs(n));
  }
  return h*SHAPE.reliefMul;
}

// item 26. One site's authored cross-section, relative to its own base elevation: a flat plinth
// for the payoff to stand on, a dished basin around it, then a raised rim that falls back to
// grade. Pure arithmetic — no noise — so the shape is identical in every world that rolls a site.
function siteProfile(u, s){
  if(u < PARAMS.siteCoreR) return s.coreH;                                     // plinth top, flat
  // Widths here are level design, not styling: at 0.08 of the radius the plinth and rim faces came
  // out near-vertical (measured gradient 5.9), and the player's vertical resolve snaps them up a
  // wall like that, which reads as a collision bug. 0.20/0.28 keep both faces runnable.
  if(u < PARAMS.siteCoreR + 0.20){
    const t = (u - PARAMS.siteCoreR)/0.20;
    return s.coreH + (-s.bowlD - s.coreH)*(t*t*(3-2*t));                       // plinth flank
  }
  if(u < 0.62) return -s.bowlD;                                                // basin floor
  if(u < 0.90){
    const t = (u - 0.62)/0.28;
    return -s.bowlD + (s.rimH + s.bowlD)*(t*t*(3-2*t));                        // inner rim face
  }
  const t = Math.min(1, (u - 0.90)/0.22);
  return s.rimH*(1-t)*(1-t);                                                   // rim back to grade
}

// terrain height *without* the ravine carve — this is "where the ground used to be" before the
// gully cut through it, which is what a bridge deck should rest at (and what a ravine is measured
// relative to). Exported so a bridge landmark can query it directly.
// HOT PATH: plain-number math only, zero allocations. Every helper it calls obeys the same rule.
export function baseTerrainHeight(x, z){
  const d = Math.sqrt(x*x + z*z);
  // 1. domain warp — everything below reads the warped position, so no boundary traces a circle
  const w = warpAt(x, z, d);
  const wx = w.x, wz = w.z;
  // 2. base silhouette
  const e = edgeAt(Math.atan2(wz, wx));
  const crest = e.r, rim = e.h;
  const u = d/crest;
  let h = silhouette(u, SHAPE.terrace, rim);
  // 3 + 4. negotiating terms, muted in the spawn clearing and faded out under the rim
  const soft = THREE.MathUtils.smoothstep(d, PARAMS.clearR0, PARAMS.clearR1)
    * (1 - PARAMS.reliefFadeAmt*THREE.MathUtils.smoothstep(u, PARAMS.reliefFade, 1));
  if(soft > 0.002){
    h += regionRelief(wx, wz)*soft;
    const mask = THREE.MathUtils.smoothstep(fbmOf(F.mound, wx*PARAMS.moundMF, wz*PARAMS.moundMF, 2),
      PARAMS.moundMLo, PARAMS.moundMHi);
    if(mask > 0.002) h += fbmOf(F.mound, wx*PARAMS.moundF + 90, wz*PARAMS.moundF + 90, 3)*PARAMS.moundA*SHAPE.reliefMul*mask*soft;
    h += fbmOf(F.detail, wx*PARAMS.detailF, wz*PARAMS.detailF, 2)*PARAMS.detailA*soft;
  }
  // 5. authored carve. INVARIANT (the bug this shape exists to avoid): gather every site's
  // influence FIRST and apply it ONCE. Applying site by site lets a neighbour's rim bulge up
  // through the middle of this site's basin, because the second blend starts from an already
  // carved height. Taking the strongest single influence also means overlapping sites degrade
  // into "the nearer one wins" instead of into mush.
  let siteW = 0, siteH = 0;
  for(let i=0;i<SITES.length;i++){
    const s = SITES[i];
    const dx = wx - s.x, dz = wz - s.z;
    const sr = s.r*1.14;
    if(dx*dx + dz*dz > sr*sr) continue;
    const su = Math.sqrt(dx*dx + dz*dz)/s.r;
    const sw = 1 - THREE.MathUtils.smoothstep(su, 0.88, 1.14);
    if(sw <= siteW) continue;
    siteW = sw; siteH = s.base + siteProfile(su, s);
  }
  if(siteW > 0) h = h*(1-siteW) + siteH*siteW;
  // 6. edge falloff — WINS. Gated at edgeLock*crest, which is >= 195 by construction, so this
  // override can never reach into the disc the player is allowed to walk.
  const lock = THREE.MathUtils.smoothstep(d, crest*PARAMS.edgeLock, crest);
  if(lock > 0) h = h*(1-lock) + rim*lock;
  if(d > crest) h += Math.min(PARAMS.edgeSkirtMax, (d-crest)*PARAMS.edgeSkirt);
  return h;
}
// item: cave chambers sit far outside the playable disc, on the same infinite terrain function
// everything else uses — so groundHeight overrides to a flat floor for them instead of the skirt
// value baseTerrainHeight would otherwise return out there. HOT PATH, but CAVE_CHAMBERS never
// holds more than 2 entries, so the scan costs nothing next to the noise pipeline it replaces.
export function caveFloorAt(x, z){
  for(let i=0;i<CAVE_CHAMBERS.length;i++){
    const c = CAVE_CHAMBERS[i];
    const dx = x-c.x, dz = z-c.z;
    if(dx*dx + dz*dz < c.r*c.r) return c.floorY;
  }
  return null;
}
export function groundHeight(x, z){
  const cave = caveFloorAt(x, z);
  if(cave !== null) return cave;
  return baseTerrainHeight(x, z) - ravineDepth(x, z);
}

/* ---------------- collision + placement (items 01, 09, 28, 57) ---------------- */

// item 01. One flat array of upright cylinders: every prop tall enough to be a wall.
// INVARIANT: a collider is pushed by the SAME loop that builds its visual mesh, so geometry
// and collision cannot drift apart. The props are InstancedMesh, so the push happens where
// the instance's matrix is computed — never in a second pass over a list of positions.
// `off = true` retires one whose owner is destroyed; nothing ever splices this array, because
// surfaceAt() walks it by index for every entity every frame.
export const COLLIDERS = [];

// item 28. Keep-out circles for authored sites. The ravine is checked from RAVINE directly,
// since it is a path rather than a circle. `tag` lets a site's OWN props opt out of its zone
// while still respecting everyone else's.
const EXCLUSIONS = [];

// surfaceAt returns a SHARED object. It runs for every entity every frame and a fresh literal
// would be hundreds of garbage objects a second — read .h/.blocked immediately, never keep the
// reference around.
const SURF = { h: 0, blocked: false };

// item 01. THE movement query. HOT PATH: plain-number math, zero allocations, squared-distance
// early-out.
export function surfaceAt(x, z, fromY){
  let h = groundHeight(x, z);
  let blocked = false;
  const pad = PLAYER_R*0.55;
  for(let i=0;i<COLLIDERS.length;i++){
    const c = COLLIDERS[i];
    if(c.off) continue;
    const dx = x-c.x, dz = z-c.z, rr = c.r+pad;
    if(dx*dx + dz*dz > rr*rr) continue;
    if(c.top <= h) continue;                                // buried in the terrain
    if(fromY + STEP >= c.top){ if(c.top > h) h = c.top; }    // low enough to walk onto
    else if(fromY + PLAYER_H > c.bot) blocked = true;        // body is inside the column: wall
  }
  SURF.h = h; SURF.blocked = blocked;
  return SURF;
}

// camera + projectiles: what is the top of this column, ignoring how high we came in from
export function groundOnly(x, z){ return surfaceAt(x, z, 1e6).h; }

// item 57. Local steepness, central difference. INDEPENDENT of the STEP collider check:
// a cylinder tells you about walls, a gradient tells you about hillsides. Epsilon is just over
// one terrain quad, so this reads the slope you would actually walk rather than vertex noise.
const SLOPE_EPS = 1.1;
export function slopeAt(x, z){
  const dx = groundHeight(x+SLOPE_EPS, z) - groundHeight(x-SLOPE_EPS, z);
  const dz = groundHeight(x, z+SLOPE_EPS) - groundHeight(x, z-SLOPE_EPS);
  return Math.sqrt(dx*dx + dz*dz) / (2*SLOPE_EPS);
}

/* ---------------- reachability: "can the player actually get there" ----------------
   THE BUG THIS EXISTS TO PREVENT: a critter, a chest or a pod on a perfectly flat, perfectly
   legal shelf on top of a mesa tier whose every neighbour is 3 m lower. Slope catches cliff
   FACES and the collider list catches "inside a rock"; neither can see a legal surface with no
   legal way onto it, because locally that shelf looks exactly like open meadow.

   The only honest test for "can I get there" is to walk there, so this floods the walkable
   surface once from the run's spawn point and then answers by lookup. Edges are directional and
   that is the whole point: DOWN is free (you can always fall off something), UP costs a jump, so
   the set this computes is specifically "reachable *from where the player starts*" rather than
   the symmetric "connected to".

   BUILT LAZILY, ON FIRST QUERY, AND THAT ORDERING IS NOT OPTIONAL. The flood walks COLLIDERS, so
   it must not run until every prop that owns one has pushed it — props.js lands its rocks and
   vents after buildWorld() returns. Querying early would flood straight through a boulder and
   bless the ground behind it. resetReach() is called from every build and every dispose so a
   stale mask can never outlive the world it described. */
// One extra jump's worth of rise is what an "up" edge costs. Reading it off entities.js's real
// numbers means a JUMP_VY retune can never silently strand content: PARAMS.reachClimb is derived,
// not authored. Kept a hair under the true apex — landing on the exact pixel of your peak is not
// a move a player can rely on, so the mask shouldn't rely on it either.
const REACH_CLIMB = (11*11)/(2*30) - 0.15;      // JUMP_VY^2/2g, entities.js:29-30
const REACH_STEP = 3;                           // metres per cell: under the narrowest mesa tier
const REACH_R = 196;                            // just past the playable ring, so nothing legal is cropped
const REACH_FLOOR = -3.0;                       // the ravine floor and pond beds are not standing room
let REACH = null;                               // Uint8Array, lazily flooded
let REACH_N = 0, REACH_ORIGIN = 0;
let reachSeed = null;                           // {x,z} — set by buildWorld from the spawn point

export function resetReach(){ REACH = null; }
// buildWorld hands us the spawn point it already found, so the flood starts where the player does
// instead of assuming the origin is standable (it usually is — but "usually" is how content goes
// missing on one seed in twenty).
export function setReachSeed(pt){ reachSeed = pt ? { x: pt.x, z: pt.z } : null; resetReach(); }

const REACH_DX = [1,-1,0,0,1,1,-1,-1], REACH_DZ = [0,0,1,-1,1,-1,1,-1];
function buildReach(){
  // THE CELL COUNT MUST BE ODD. REACH_ORIGIN is (n-1)/2 and every index is computed as
  // (gz + REACH_ORIGIN)*n + (gx + REACH_ORIGIN) from integer cell coords — an even n makes the
  // origin a half-cell, every index fractional, and a typed-array write at a fractional index is
  // SILENTLY DISCARDED. The flood then reports zero reachable cells and rejects the whole map
  // without erroring anywhere. Derive the half-width first and double it; never round the total.
  REACH_ORIGIN = Math.ceil(REACH_R/REACH_STEP);
  REACH_N = REACH_ORIGIN*2 + 1;
  REACH = new Uint8Array(REACH_N*REACH_N);
  const hs = new Float32Array(REACH_N*REACH_N);
  // BFS, not DFS: a flood over ~17k cells recursed would blow the stack on a wide-open seed.
  // Two flat arrays for the queue rather than an array of pairs — this runs once, but it runs
  // during the boot frame, and the boot frame is the one the player is watching.
  const qi = new Int32Array(REACH_N*REACH_N);
  let head = 0, tail = 0;
  const sx = reachSeed ? reachSeed.x : 0, sz = reachSeed ? reachSeed.z : 0;
  const si = idxOf(sx, sz);
  if(si < 0) return;
  REACH[si] = 1; hs[si] = groundHeight(sx, sz); qi[tail++] = si;
  while(head < tail){
    const i = qi[head++];
    const cx = (i % REACH_N) - REACH_ORIGIN, cz = ((i / REACH_N)|0) - REACH_ORIGIN;
    const h = hs[i];
    for(let d=0;d<8;d++){
      const gx = cx + REACH_DX[d], gz = cz + REACH_DZ[d];
      if(gx < -REACH_ORIGIN || gx > REACH_ORIGIN || gz < -REACH_ORIGIN || gz > REACH_ORIGIN) continue;
      const ni = (gz + REACH_ORIGIN)*REACH_N + (gx + REACH_ORIGIN);
      if(REACH[ni]) continue;
      const nx = gx*REACH_STEP, nz = gz*REACH_STEP;
      if(nx*nx + nz*nz > REACH_R*REACH_R) continue;
      /* THE MIDPOINT CHECK, and it is what stops the mask lying. Cells are REACH_STEP apart, so
         testing only the endpoints lets the flood tunnel straight through anything narrower than
         one cell — a 3 m-wide, 6 m-tall spine between two low cells reads as "both low, walk
         across" and the mask blesses the far side. Sampling halfway costs one more surfaceAt per
         edge and turns a grid walk into something that actually respects walls.
         HAZARD: surfaceAt returns a SHARED object, so each call's fields go into locals on the
         very next line — never hold the reference across the second call. */
      const mid = surfaceAt((cx*REACH_STEP + nx)*0.5, (cz*REACH_STEP + nz)*0.5, h);
      const mh = mid.h, mblocked = mid.blocked;
      if(mblocked || mh - h > REACH_CLIMB) continue;
      // the movement query itself decides the edge, so the mask and the collision agree by
      // construction.
      const surf = surfaceAt(nx, nz, mh);
      const nh = surf.h, blocked = surf.blocked;
      if(blocked) continue;                       // a wall from where we stand
      if(nh < REACH_FLOOR) continue;              // stepping into the void
      if(nh - mh > REACH_CLIMB) continue;         // too tall to jump; DOWN is deliberately free
      REACH[ni] = 1; hs[ni] = nh; qi[tail++] = ni;
    }
  }
}
function idxOf(x, z){
  const gx = Math.round(x/REACH_STEP), gz = Math.round(z/REACH_STEP);
  if(gx < -REACH_ORIGIN || gx > REACH_ORIGIN || gz < -REACH_ORIGIN || gz > REACH_ORIGIN) return -1;
  return (gz + REACH_ORIGIN)*REACH_N + (gx + REACH_ORIGIN);
}
/* The placement predicate. Samples the cell plus its four neighbours and passes if ANY is
   reachable, because a 3 m grid quantises a spot near a cell boundary onto whichever side it
   rounded to — demanding the exact cell would reject legal ground at every tier edge. Callers
   that place a whole cluster of points should test each member, not just the first. */
export function reachable(x, z){
  if(!REACH) buildReach();
  const i = idxOf(x, z);
  if(i < 0) return false;
  if(REACH[i]) return true;
  const gx = Math.round(x/REACH_STEP), gz = Math.round(z/REACH_STEP);
  for(let d=0;d<4;d++){
    const ax = gx + REACH_DX[d], az = gz + REACH_DZ[d];
    if(ax < -REACH_ORIGIN || ax > REACH_ORIGIN || az < -REACH_ORIGIN || az > REACH_ORIGIN) continue;
    if(REACH[(az + REACH_ORIGIN)*REACH_N + (ax + REACH_ORIGIN)]) return true;
  }
  return false;
}
// diagnostics for ?probe and the verification pass: what fraction of the ring the player can hold
export function reachStats(){
  if(!REACH) buildReach();
  let on = 0, total = 0;
  for(let i=0;i<REACH.length;i++){
    const gx = (i % REACH_N) - REACH_ORIGIN, gz = ((i / REACH_N)|0) - REACH_ORIGIN;
    const x = gx*REACH_STEP, z = gz*REACH_STEP;
    if(x*x + z*z > REACH_R*REACH_R) continue;
    total++; if(REACH[i]) on++;
  }
  return { cells: total, reachable: on, frac: total ? on/total : 0, step: REACH_STEP };
}

// item 28. One cheap "keep out of here" query every placement predicate consults; the caller
// picks its own clearance, because a mushroom and a 42m tower need different room.
export function inExclusion(x, z, pad=2, skipTag=null){
  if(RAVINE){
    const d = Math.min(
      distToSeg(x, z, RAVINE.ax, RAVINE.az, RAVINE.bx, RAVINE.bz),
      distToSeg(x, z, RAVINE.bx, RAVINE.bz, RAVINE.cx, RAVINE.cz));
    if(d < RAVINE.width + PARAMS.exclRavine + pad) return true;
  }
  for(let i=0;i<EXCLUSIONS.length;i++){
    const e = EXCLUSIONS[i];
    if(skipTag && e.tag === skipTag) continue;
    const dx = x-e.x, dz = z-e.z, rr = e.r+pad;
    if(dx*dx + dz*dz < rr*rr) return true;
  }
  return false;
}

// the placement half of item 01: does anything already standing occupy this spot
function clearOf(x, z, pad){
  for(let i=0;i<COLLIDERS.length;i++){
    const c = COLLIDERS[i];
    if(c.off) continue;
    const dx = x-c.x, dz = z-c.z, rr = c.r+pad;
    if(dx*dx + dz*dz < rr*rr) return false;
  }
  return true;
}

// item 09. Rejection sampling with minimum spacing and a guard counter, so a predicate that
// can never pass returns short instead of hanging the boot.
// `test(x,z)` must query the FINISHED world — height, slopeAt, inExclusion, COLLIDERS — not
// just the noise. That is the difference between a generator that makes places and one that
// makes scatter, and it is what stops a prop spawning inside a rock.
// `area` = {x, z, r0, r1}; default is the playable ring.
export function scatter(rng, count, minDist, test, area=null){
  const out = [];
  const ax = area && area.x !== undefined ? area.x : 0;
  const az = area && area.z !== undefined ? area.z : 0;
  const r0 = area && area.r0 !== undefined ? area.r0 : PARAMS.scatterRMin;
  const r1 = area && area.r1 !== undefined ? area.r1 : PARAMS.scatterRMax;
  const md2 = minDist*minDist;
  let guard = count*PARAMS.scatterTries + 200;
  while(out.length < count && guard-- > 0){
    const a = rng()*Math.PI*2, r = r0 + rng()*(r1-r0);
    const x = ax + Math.cos(a)*r, z = az + Math.sin(a)*r;
    let ok = true;
    if(md2 > 0){
      for(let i=0;i<out.length;i++){
        const dx = x-out[i].x, dz = z-out[i].z;
        if(dx*dx + dz*dz < md2){ ok = false; break; }
      }
    }
    if(ok && test(x, z)) out.push({ x, z });
  }
  return out;
}

// item 09. Deterministic per seed: flat, clear of every collider, outside every exclusion.
// Call it AFTER buildWorld — "clear" means clear of the FINISHED collider list, which is the
// whole point; sampling the bare noise is how you end up spawning inside a rock formation.
export function findSpawnPoint(seed){
  const r = mulberry32(deriveSeed(seed, 0x5eed1));
  for(let i=0;i<PARAMS.spawnTries;i++){
    const a = r()*Math.PI*2, d = r()*PARAMS.spawnR;
    const x = Math.cos(a)*d, z = Math.sin(a)*d;
    if(inExclusion(x, z, 4)) continue;
    if(slopeAt(x, z) > PARAMS.spawnSlope) continue;
    if(!clearOf(x, z, PARAMS.spawnClear)) continue;
    return { x, z, h: groundHeight(x, z) };
  }
  // fallback after ~900 misses: baseTerrainHeight flattens the origin clearing by design, so
  // the middle of the map is standable in every world even when every sample missed.
  return { x: 0, z: 0, h: groundHeight(0, 0) };
}

/* ---------------- shared layout helpers ----------------
   These read the module-level layout, so both build halves (item 31) see the same world. They
   used to be closures inside one 1300-line buildWorld; splitting the build is what forced them
   out, and the split is what makes a live rebuild possible at all. */

// corruption used to be a perfect ring around the origin — same every world. now a
// witheredHollow pocket can push a patch of it much closer to spawn, unpredictably, and both the
// ring and the pocket edge are read at WARPED coordinates (item 22) so neither traces a circle.
function corruptionAt(x, z){
  const d = Math.hypot(x, z);
  const w = warpAt(x, z, d);
  const wx = w.x, wz = w.z;
  let c = THREE.MathUtils.smoothstep(Math.hypot(wx, wz), 65, 195);
  const wh = POCKETS.witheredHollow;
  if(wh){
    const pd = Math.hypot(wx-wh.x, wz-wh.z);
    c = Math.max(c, (1 - THREE.MathUtils.smoothstep(pd, wh.r*0.4, wh.r)) * 0.85);
  }
  return c;
}
function hasLandmark(id){ return LANDMARKS.indexOf(id) >= 0; }

// Fen Hollow's bog: 0 outside the pocket, ramping to 1 toward its center. Exported — this is the
// one pocket that reaches past decoration into the player's own move speed (see entities.js),
// so unlike corruptionAt it has to be readable from outside this module.
export function fenBogAt(x, z){
  const fh = POCKETS.fenHollow;
  if(!fh) return 0;
  const d = Math.hypot(x-fh.x, z-fh.z);
  return 1 - THREE.MathUtils.smoothstep(d, fh.r*0.3, fh.r);
}

// item 09: every authored site picks its spot through the same rejection sampler, so a
// landmark can no longer land in the ravine, on a cliff face, or on top of an earlier
// landmark. Sites are placed in file order, so each one sees everything built before it.
function siteTest(pad, tag){
  return (x,z)=> slopeAt(x,z) < PARAMS.siteSlope && !inExclusion(x,z,pad,tag) && clearOf(x,z,PARAMS.siteClear);
}
function spot(rng, r0, r1, pad=PARAMS.sitePad, tag=null){
  const p = scatter(rng, 1, 0, siteTest(pad, tag), { x:0, z:0, r0, r1 })[0];
  if(p) return p;
  // a world missing its set-piece is worse than a set-piece on an awkward site
  const a = rng()*Math.PI*2, d = r0 + rng()*(r1-r0);
  return { x: Math.cos(a)*d, z: Math.sin(a)*d };
}

/* ---------------- item 42: everything this module put in the scene ----------------
   Every addTo(scene, ) in this file goes through addTo(), so dispose() can remove exactly what
   world.js owns and nothing else. Counting from scene.children.length instead would sweep away
   the player, the particle pool and anything else main.js added after the build. */
const OWNED = [];
function addTo(sc, ...objs){ for(const o of objs){ sc.add(o); OWNED.push(o); } }

/* ---------------- item 31: staged build ----------------
   buildWorld keeps its exact signature (main.js calls it and is owned by someone else) and is
   now just the two halves plus the queries that need the FINISHED world. Splitting them is what
   lets item 10's dev panel re-run terrain at a new resolution without rebuilding 20 instanced
   prop batches — generation you can re-run in a frame is generation you can tune. */
export function buildWorld(scene, quality=1, seed=1){
  const world = buildTerrain(scene, seed, PARAMS.terrainSegs, quality);
  buildProps(scene, seed, world);
  world.update = (dt, t)=>{ for(const u of world.updaters) u(dt,t); };
  // items 01 / 09: handed to main.js so it never has to reach for the module-level arrays, and
  // so the spawn search runs once against the FINISHED collider list instead of per frame.
  world.colliders = COLLIDERS;
  world.spawnPoint = findSpawnPoint(seed);
  // the flood has to start where the player does, and stay invalid until someone asks for it —
  // props.js still has colliders to push after we return.
  setReachSeed(world.spawnPoint);
  markOwnership(world);
  return world;
}

// item 31. Heightfield + mesh + the atmosphere the terrain is lit and faded by. It also rolls the
// LAYOUT (theme, ravine, pockets, landmark set, authored sites) because the heightfield has to be
// able to see it — the ravine cuts the height and the sites carve it, so they cannot be decided
// after the mesh exists. `res` is the segment count: lower it for a fast preview rebuild.
export function buildTerrain(scene, seed, res=PARAMS.terrainSegs, quality=1){
  // this half owns the arrays' lifetime. Truncate in place, never reassign: other modules
  // already hold the exported COLLIDERS reference.
  COLLIDERS.length = 0; EXCLUSIONS.length = 0; SITES.length = 0; OWNED.length = 0; CAVE_CHAMBERS.length = 0;
  QUALITY = quality;
  // item 07: every field this world will ever sample, built once from the world seed.
  F = buildFields(seed);
  // rolled from its own stream, so adding a knob to the layout below cannot reshape the terrain
  SHAPE = rollShape(mulberry32(deriveSeed(seed, 0x54a9e)));
  bakeEdge();   // depends on both F.coast and SHAPE.rimScale, so it re-bakes after both are set
  const rng = mulberry32(deriveSeed(seed, 0x51ed));
  /* item: generative palettes. ONE roll, one level up: makePalette() picks a SCHEME (base hue,
     harmony, season, hour, ground family) and derives every element colour from it, so a world
     cannot come out muddy for a seed nobody tested. It is a pure function of this stream and
     consumes it in a fixed order, so the seed still determines the world exactly.
     The field stays named `theme`: main.js prints `world.theme.name` in the Tome, the pause
     screen, game over and victory, and the generated palette carries its own `name`. */
  const theme = THEME = makePalette(rng);
  const world = WORLD = { updaters: [], seed, theme, terrainRes: res };
  // seeded ravine: ~60% of worlds get one, giving a bridge-crossing layout feature; the rest don't
  RAVINE = null;
  if(rng() < PARAMS.ravChance){
    const a0 = rng()*Math.PI*2, d0 = PARAMS.ravDMin + rng()*PARAMS.ravDVar;
    const ax = Math.cos(a0)*d0, az = Math.sin(a0)*d0;
    const curveA = a0 + (rng()-0.5)*PARAMS.ravBend, segLen = PARAMS.ravSegMin + rng()*PARAMS.ravSegVar;
    const bx = ax + Math.cos(curveA)*segLen, bz = az + Math.sin(curveA)*segLen;
    const curveB = curveA + (rng()-0.5)*PARAMS.ravBend;
    const cx = bx + Math.cos(curveB)*segLen, cz = bz + Math.sin(curveB)*segLen;
    RAVINE = { ax, az, bx, bz, cx, cz, width: PARAMS.ravWMin+rng()*PARAMS.ravWVar, depth: PARAMS.ravDepthMin+rng()*PARAMS.ravDepthVar };
  }

  // ---- seeded regional "pockets": optional themed clusters so each world's zones read
  // as distinct places worth remembering, not just a uniform prop scatter with a palette
  // swap. each is independently rolled — a world can have none, some, or all of them. ----
  POCKETS = {};
  const rollPocket = (minD, maxD)=>{
    const a = rng()*Math.PI*2, d = minD + rng()*(maxD-minD);
    return { x: Math.cos(a)*d, z: Math.sin(a)*d, r: PARAMS.pockRMin + rng()*PARAMS.pockRVar };
  };
  if(rng() < PARAMS.crystalChance) POCKETS.crystalHollow = rollPocket(PARAMS.crystalPMin, PARAMS.crystalPMax);
  if(rng() < PARAMS.warrenChance) POCKETS.fungalWarren = { ...rollPocket(PARAMS.warrenPMin, PARAMS.warrenPMax), species: MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0].id };
  if(rng() < PARAMS.witherChance) POCKETS.witheredHollow = rollPocket(PARAMS.witherPMin, PARAMS.witherPMax);
  if(rng() < PARAMS.fenChance) POCKETS.fenHollow = rollPocket(PARAMS.fenPMin, PARAMS.fenPMax);
  if(rng() < PARAMS.scorchChance) POCKETS.scorchedHollow = rollPocket(PARAMS.scorchPMin, PARAMS.scorchPMax);
  // which "big" set-piece landmarks this world gets — not all of them every time, so the
  // landmark *set itself* reads as different between worlds, not just repositioned.
  // guaranteed >=2 so no world ends up feeling like a bare field.
  const BIG_LANDMARKS = ['tower','stones','geysers','pond','ruins','summit'];
  LANDMARKS = BIG_LANDMARKS.filter(()=> rng() < PARAMS.landmarkChance);
  if(LANDMARKS.length < PARAMS.landmarkMin){
    const missing = BIG_LANDMARKS.filter(id=>LANDMARKS.indexOf(id) < 0);
    while(LANDMARKS.length < PARAMS.landmarkMin && missing.length) LANDMARKS.push(missing.splice((rng()*missing.length)|0, 1)[0]);
  }
  // item 28: a themed pocket is a *place*, so ambient scatter stays out of it. Its own props
  // ask for their zone back by passing their tag to inExclusion().
  for(const tag of Object.keys(POCKETS)) EXCLUSIONS.push({ x:POCKETS[tag].x, z:POCKETS[tag].z, r:POCKETS[tag].r, tag });

  /* ----- item 26: authored sites — the hand-placed payoff the noise carves around -----
     Rolled through the SAME rejection sampler as every other set-piece, which is how a site is
     kept out of the ravine, off the bridge and out of the spawn clearing (siteDMin is beyond the
     basin, and inExclusion covers the rest). Caves are rolled later against these exclusions.
     `base` is the natural ground height at the centre, captured BEFORE the site is pushed into
     SITES, so a site sits on the land instead of floating at an authored altitude. */
  const siteCount = 1 + (rng() < PARAMS.siteChance2 ? 1 : 0);
  for(let i=0;i<siteCount;i++){
    const r = PARAMS.siteRMin + rng()*PARAMS.siteRVar;
    const p = spot(rng, PARAMS.siteDMin, PARAMS.siteDMin + PARAMS.siteDVar, r + 6, 'site');
    const s = { x:p.x, z:p.z, r, base: groundHeight(p.x, p.z),
      coreH: PARAMS.siteCoreMin + rng()*PARAMS.siteCoreVar,
      bowlD: PARAMS.siteBowlMin + rng()*PARAMS.siteBowlVar,
      rimH:  PARAMS.siteRimMin  + rng()*PARAMS.siteRimVar };
    SITES.push(s);
    EXCLUSIONS.push({ x:s.x, z:s.z, r:s.r, tag:'site' });
  }
  // item 18's guaranteed reward needs to find these: {x, z, r, base, coreH, bowlD, rimH}. The
  // plinth top is at base + coreH and is flat out to r*siteCoreR, so that is where it goes.
  world.sites = SITES;
  world.shape = SHAPE;   // item 10's panel wants to see the roll it is overriding

  /* ----- fog + lighting ----- */
  // item 43: ONE horizon colour, not three that can disagree. There used to be a per-theme fog
  // colour, a separate scene background, and a sky dome whose horizon band was authored on its
  // own — so distant terrain could fade to a colour the sky never drew, leaving a seam. Now the
  // fog Color is the single source: the background is cloned from it and the dome's lowest band
  // is mixed INTO it (uFog below), so terrain dissolves into exactly the pixel behind it.
  const fogCol = new THREE.Color(theme.fog);
  scene.fog = new THREE.FogExp2(fogCol, PARAMS.fogDensity);
  scene.background = fogCol.clone();
  world.fogColor = fogCol;   // hook: main.js sets a placeholder background before buildWorld runs
  // item 06: THE shadow-casting sun. main.js retargets sun.target at the player every frame, so
  // the ortho box only has to cover what is near the player — hence +/-shadowBox, not the world.
  const sun = new THREE.DirectionalLight(theme.sun, 2.9);
  sun.position.set(60, 90, 30);
  sun.castShadow = true;
  // quality scales the map, not the box: halving the box would tighten the shadowed area, which
  // is a visible content change, where halving the map is only softer edges.
  const smap = Math.max(512, Math.round(PARAMS.shadowMap*Math.min(1, Math.max(0.25, quality))));
  sun.shadow.mapSize.set(smap, smap);
  const sc = sun.shadow.camera;
  sc.left = -PARAMS.shadowBox; sc.right = PARAMS.shadowBox;
  sc.top = PARAMS.shadowBox; sc.bottom = -PARAMS.shadowBox;
  sc.near = 1; sc.far = 420; sc.updateProjectionMatrix();
  sun.shadow.bias = PARAMS.shadowBias;
  sun.shadow.normalBias = PARAMS.shadowNormalBias;
  // the target must be IN the scene or its world matrix never updates and the shadow camera
  // silently keeps aiming at the origin.
  addTo(scene, sun, sun.target);
  world.sun = sun;
  const hemi = new THREE.HemisphereLight(theme.hemiSky, theme.hemiGround, 0.85);
  addTo(scene, hemi);

  /* ----- sky dome ----- */
  const skyGeo = new THREE.SphereGeometry(900, 32, 20);
  const sunBaseDir = new THREE.Vector3(0.55,0.38,0.28).normalize();
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite:false, fog:false,
    uniforms:{ uTime:{value:0},
      uTop:{value:new THREE.Color(theme.skyTop)},
      uMid:{value:new THREE.Color(theme.skyMid)},
      uBot:{value:new THREE.Color(theme.skyBot)},
      uSunDir:{value:sunBaseDir.clone()},
      uFog:{value:fogCol} },
    vertexShader:`varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}`,
    fragmentShader:`varying vec3 vP; uniform float uTime;
      uniform vec3 uTop; uniform vec3 uMid; uniform vec3 uBot; uniform vec3 uSunDir; uniform vec3 uFog;
      void main(){
        float h = normalize(vP).y;
        vec3 top = uTop;
        vec3 mid = uMid;
        vec3 bot = uBot;
        vec3 col = mix(bot, mid, smoothstep(-0.05,0.22,h));
        col = mix(col, top, smoothstep(0.16,0.7,h));
        // item 43: the band the horizon actually sits in IS the fog colour, so terrain fading out
        // at distance and the sky behind it converge on the same pixel — no seam to hide.
        col = mix(uFog, col, smoothstep(-0.03, 0.13, h));
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
  addTo(scene, new THREE.Mesh(skyGeo, skyMat));
  // slow day-cycle sweep: rotate the sun direction + light together, dip warmth at low sun angle
  const sunDist = Math.hypot(60,90,30);
  const sunAxisZ = new THREE.Vector3(0,0,1), sunAxisY = new THREE.Vector3(0,1,0);
  const sunDir = new THREE.Vector3(); // reused every frame — no per-frame allocation
  /* THE DAY CYCLE, and the two constants that keep it from turning the world brown.

     WHY THIS MATTERED: cream is a load-bearing colour here. Mushroom stems, spore pods and the
     hunter's own face band are all PROP_CREAM, and palette.js solves the ground's luminance
     against it so those props stay readable. But readability was solved against the ALBEDO, and
     what reaches the eye is albedo x light. Measured with the old numbers, this sweep took the sun
     from elevation 0.824 down to 0.096 — five and a half degrees, effectively grazing the horizon.
     At that angle an upward-facing surface gets almost nothing from the sun, so the dominant light
     on it becomes the hemisphere's GROUND bounce, which is the soil colour by construction
     (hemiGround, ~#663a25). Cream lit mostly by brown reads as brown. Nothing had changed about
     the stems; they were simply being lit by dirt for part of every cycle.

     ELEV_SWING is therefore the fix, and note what it does NOT touch. Rotation about Y sweeps the
     light around the compass and never changes elevation, so it keeps every bit of the moving
     shadows that make the world feel alive. Only the Z rotation raises and lowers the sun, and
     that is the one narrowed: 0.5 -> 0.28 turns a 0.10..0.82 range into 0.30..0.73, which is a
     day that still visibly changes but never becomes dusk. The intensity band is tightened for the
     same reason — a 1.37x swing bottoming out at 2.32 was doing as much of the darkening as the
     angle was. */
  const ELEV_SWING = 0.28;      // radians of up/down sweep; see the note above before raising it
  world.updaters.push((dt,t)=>{
    const cycle = t*0.05; // ~126s per full sweep
    sunDir.copy(sunBaseDir).applyAxisAngle(sunAxisZ, Math.sin(cycle)*ELEV_SWING).applyAxisAngle(sunAxisY, cycle*0.6);
    skyMat.uniforms.uSunDir.value.copy(sunDir);
    // item 06: the light is placed RELATIVE to its target, not to the origin. main.js moves
    // sun.target onto the player, and a sun parked at the origin would drag the ortho shadow box
    // off the player the moment they walked away from spawn.
    sun.position.copy(sun.target.position).addScaledVector(sunDir, sunDist);
    const elevation = sunDir.y;
    sun.intensity = 2.62 + Math.max(0, elevation)*0.88;   // ~2.88 .. 3.26 across the sweep
    hemi.intensity = 0.74 + Math.max(0, elevation)*0.16;
  });

  /* ----- terrain -----
     terrainSpan, not WORLD_SIZE: the mesh has to extend past the wobbled rim crest (item 23) far
     enough for the outer skirt to hide the mesh boundary behind it. WORLD_SIZE stays the playable
     box every prop scatter is expressed in. */
  const segs = Math.max(24, Math.round(res));
  const tg = new THREE.PlaneGeometry(PARAMS.terrainSpan, PARAMS.terrainSpan, segs, segs);
  tg.rotateX(-Math.PI/2);
  const tp = tg.attributes.position;
  const colors = new Float32Array(tp.count*3);
  /* The eight strata are the PALETTE's, not eight authored constants nudged by a hue offset.
     item 41 still holds: these are sRGB hex ints, so `new THREE.Color(hex)` is the single
     sRGB->working conversion. They are also the version the readability floors were measured on
     — theme.terra is solved so the cream-stemmed props and the dark critters both clear their
     contrast floor against every band of ground they can stand on. */
  const cGrass = new THREE.Color(theme.terra.grass), cEmerald = new THREE.Color(theme.terra.emerald);
  const cDry = new THREE.Color(theme.terra.dry), cMoss = new THREE.Color(theme.terra.moss);
  const cRock = new THREE.Color(theme.terra.rock);
  const cClear = new THREE.Color(theme.terra.clear), cPath = new THREE.Color(theme.terra.path);
  const cCorruptGround = new THREE.Color(theme.terra.corrupt);
  const tmpC = new THREE.Color();
  // worn dirt paths radiating from spawn (directions seeded)
  const pathRot = rng()*Math.PI*2;
  const pathDirs = [0, 2.2, 4.3].map(a=>{
    const t = a + pathRot;
    return new THREE.Vector2(Math.cos(t), Math.sin(t));
  });
  // PASS 1 — heights only. Keeping them means the colour pass reads the slope off its own
  // neighbours instead of calling groundHeight() twice more per vertex; on a grid the neighbour
  // IS the sample you would have taken, so this is two thirds of the height math for free, which
  // is what pays for the higher-resolution mesh the new edge needs.
  const heights = new Float32Array(tp.count);
  for(let i=0;i<tp.count;i++){
    const h = groundHeight(tp.getX(i), tp.getZ(i));
    heights[i] = h;
    tp.setY(i, h);
  }
  const stride = segs+1, quad = PARAMS.terrainSpan/segs;
  for(let i=0;i<tp.count;i++){
    const x=tp.getX(i), z=tp.getZ(i);
    const h = heights[i];
    const d = Math.sqrt(x*x+z*z);
    // multi-scale painterly blotches, now on this world's own detail field (item 07)
    const b1 = fbmOf(F.detail, x*0.018+99, z*0.018, 3);
    const b2 = fbmOf(F.detail, x*0.07+31, z*0.07+11, 2);
    const grove = THREE.MathUtils.smoothstep(F.mound(x*0.05, z*0.05), 0.02, 0.4);
    tmpC.copy(cGrass);
    tmpC.lerp(cEmerald, THREE.MathUtils.smoothstep(b1, 0.05, 0.45));       // deep emerald patches
    tmpC.lerp(cDry, THREE.MathUtils.smoothstep(-b1, 0.18, 0.5)*0.85);      // warm dry-grass patches
    tmpC.lerp(cMoss, THREE.MathUtils.smoothstep(-b2, 0.15, 0.45)*0.6);     // dark moss speckle
    tmpC.lerp(cMoss, grove*0.55);                                          // dark forest floor under groves
    // worn dirt paths from spawn
    let pathW = 0;
    for(const pd of pathDirs){
      const perp = Math.abs(x*(-pd.y) - z*pd.x) + fbmOf(F.detail, x*0.1, z*0.1, 2)*2.2;
      pathW = Math.max(pathW, (1 - THREE.MathUtils.smoothstep(perp, 1.8, 4.2)) * THREE.MathUtils.smoothstep(d, 6, 14));
    }
    tmpC.lerp(cPath, Math.min(0.85, pathW));
    if(h > 14) tmpC.lerp(cRock, THREE.MathUtils.smoothstep(h,14,30));      // rock band tracks the new terrace/rim scale
    // steep hillsides read as bare rock rather than grass, like a real slope would
    const ix = i%stride, iz = (i/stride)|0;
    const hx = heights[ix+1 < stride ? i+1 : i-1], hz = heights[iz+1 < stride ? i+stride : i-stride];
    const slope = (Math.abs(hx-h) + Math.abs(hz-h)) / quad;
    tmpC.lerp(cRock, Math.min(0.6, THREE.MathUtils.smoothstep(slope, 0.4, 1.15)*0.6));
    tmpC.lerp(cCorruptGround, corruptionAt(x,z)*0.5); // ground itself sickens along with the trees/rocks
    if(d < 9) tmpC.lerp(cClear, (1-d/9)*0.6);
    // painterly variation — offset in sRGB (item 41b), otherwise the lightness jitter is
    // non-linear in the wrong direction and the saturation bump lands somewhere else entirely
    offsetHSLsRGB(tmpC, F.detail(x*0.15,z*0.15)*0.015, 0.05, F.detail(x*0.3,z*0.3)*0.045);
    colors[i*3]=tmpC.r; colors[i*3+1]=tmpC.g; colors[i*3+2]=tmpC.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors,3));
  tg.computeVertexNormals();
  const terrain = new THREE.Mesh(tg, toonMat({ color:0xffffff, rim:0.12, coolTint:0xa8c8a0, warmTint:0xfff0c0 }));
  terrain.material.vertexColors = true;
  // item 06: the ground receives but never casts. A heightfield casting onto itself is what
  // acne and peter-panning come from, and every silhouette worth seeing is a prop on top of it.
  terrain.receiveShadow = true;
  addTo(scene, terrain);
  world.terrain = terrain;
  return world;
}

/* ---------------- item 31: props, landmarks and colliders ----------------
   Requires buildTerrain() to have run: it reads the layout (theme, ravine, pockets, sites) and
   places against the FINISHED heightfield, which is the whole reason the two are ordered. Its rng
   stream is derived separately from the terrain's, so re-running terrain at a different
   resolution cannot shuffle the props. */
export function buildProps(scene, seed, world = WORLD){
  const rng = mulberry32(deriveSeed(seed, 0x9209));
  const theme = THEME;
  const quality = QUALITY;

  /* ----- distant mountains (3 hazy purple-blue layers) ----- */
  const mGeo = new THREE.ConeGeometry(1,1,5);
  // theme.mountains is aerial perspective derived from THIS world's horizon: each ring is the
  // fog colour with a little more of the dome's hue left in it, so the haze sits BEHIND the fog
  // instead of being a purple band pasted over whatever sky the palette rolled.
  const mRings = [
    { col:theme.mountains[0], op:0.95, dist:430, h:170 },
    { col:theme.mountains[1], op:0.7,  dist:580, h:200 },
    { col:theme.mountains[2], op:0.45, dist:740, h:240 },
  ];
  for(let ring=0; ring<3; ring++){
    const R = mRings[ring];
    for(let i=0;i<PARAMS.mtnPerRing;i++){
      // FIXED with the migration to per-world fields: these used to be noise2(i, k) with INTEGER
      // arguments, and a lattice-based field is exactly 0 at integer coordinates — so every
      // "jitter" here evaluated to 0 and the peaks sat on a perfect ring. Fractional now.
      const a = (i/PARAMS.mtnPerRing)*Math.PI*2 + ring*0.35 + F.detail(i*0.37+3.1, ring*1.7+0.6)*0.9;
      const dist = R.dist + F.detail(i*0.51+9.4, 1.3)*90;
      const m = new THREE.Mesh(mGeo, new THREE.MeshBasicMaterial({ color:R.col, fog:false, transparent:true, opacity:R.op }));
      // per-peak jitter only. The ring colour is already this world's, so the old terraHue term
      // would now rotate the haze OFF the horizon it was derived from.
      offsetHSLsRGB(m.material.color, F.detail(i*0.63+7.2, 2.7)*0.04, 0, F.detail(i*0.29+5.5, 4.1)*0.10);
      m.position.set(Math.cos(a)*dist, 8, Math.sin(a)*dist);
      m.scale.set(150+rng()*110, R.h*(0.7+rng()*0.6), 150);
      addTo(scene, m);
    }
  }

  /* ----- toon clouds (billboards) ----- */
  const cloudTex = makeCloudTexture();
  const clouds = [];
  for(let i=0;i<PARAMS.cloudCount;i++){
    const sm = new THREE.SpriteMaterial({ map:cloudTex, transparent:true, opacity:0.9, depthWrite:false, fog:false });
    const s = new THREE.Sprite(sm);
    s.position.set((rng()-0.5)*800, 70+rng()*90, (rng()-0.5)*800);
    const sc = 80+rng()*120; s.scale.set(sc, sc*0.5, 1);
    addTo(scene, s); clouds.push(s);
  }
  world.updaters.push((dt)=>{
    for(const c of clouds){ c.position.x += dt*1.5; if(c.position.x>400) c.position.x=-400; }
  });

  /* ----- trees (instanced trunks + canopies) ----- */
  const treePos = [];
  for(let i=0;i<PARAMS.treeTries && treePos.length<PARAMS.treeMax;i++){
    const x=(rng()-0.5)*WORLD_SIZE*0.92, z=(rng()-0.5)*WORLD_SIZE*0.92;
    const d=Math.hypot(x,z);
    if(d<PARAMS.treeDMin || d>PARAMS.treeDMax) continue;
    if(F.mound(x*0.05, z*0.05) < PARAMS.treeGrove) continue; // groves — same field as the terrain's grove tint, so dark forest floor and trees agree
    treePos.push([x, groundHeight(x,z), z]);
  }
  const trunkGeo = new THREE.CylinderGeometry(0.35, 0.7, 6, 6);
  trunkGeo.translate(0,3,0);
  // bend the trunk
  { const p=trunkGeo.attributes.position;
    for(let i=0;i<p.count;i++){ const y=p.getY(i); p.setX(i, p.getX(i)+Math.sin(y*0.4)*0.8); } }
  /* Bark comes off the SOIL hue (theme.trunk / theme.trunkDark), folded into a wood-plausible
     band — so an ochre world gets pale bark and a slate world gets grey bark, and the trunk still
     reads as wood rather than as a recoloured prop. The material colour stays white: the map
     carries the bark colour once, and the per-instance colour below carries only this trunk's
     own deviation from it, so a jittered trunk is that colour plus texture, never that colour
     squared. */
  const cTrunk = new THREE.Color(theme.trunk), cTrunkDark = new THREE.Color(theme.trunkDark);
  const trunkMat = toonMat({ color:0xffffff,
    map:paintTexture('#'+cTrunk.getHexString(), [{c:'#'+cTrunkDark.getHexString(), n:26, r:6, a:0.35}], {dabs:200}), rim:0.25 });
  // hoisted OUT of the instance loop: jitterFor() writes into the object it is handed, so the
  // whole per-tree colour pass allocates nothing.
  const J = { h:0, s:0, l:0, hex:0 };
  const canGeo = new THREE.IcosahedronGeometry(3.4, 1);
  { const p=canGeo.attributes.position;
    for(let i=0;i<p.count;i++){
      const v=new THREE.Vector3(p.getX(i),p.getY(i),p.getZ(i));
      const n = 1 + F.detail(v.x*0.8+v.y, v.z*0.8)*0.25;
      p.setXYZ(i, v.x*n, v.y*n*0.8, v.z*n); } }
  const canBase = new THREE.Color(theme.canopyBase);
  const canDark = offsetHSLsRGB(canBase.clone(), 0, 0.05, -0.10);
  // `color` white + ratioTo() per instance — see the note above ratioTo(): the canopy hex used to
  // sit in the material, the map AND the instance colour, i.e. cubed.
  const canMat = toonMat({ color:0xffffff,
    map:paintTexture('#'+canBase.getHexString(),[{c:'#'+canDark.getHexString(),n:60,r:14,a:0.25}],{dabs:300}), rim:0.6, rimColor:0xe8ffb0 });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treePos.length);
  const cans = new THREE.InstancedMesh(canGeo, canMat, treePos.length);
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), S = new THREE.Vector3();
  // one Euler beside the other build scratch. The grass loop alone runs 22,000 times on the boot
  // frame, and it was building a throwaway Euler on every one of them.
  const EU = new THREE.Euler();
  const canColor = new THREE.Color();
  const corruptCol = new THREE.Color(0x2a1a3a);
  const trunkColor = new THREE.Color();
  const trunkCorrupt = new THREE.Color(0x241826);
  treePos.forEach(([x,y,z],i)=>{
    const s = PARAMS.treeSMin+rng()*PARAMS.treeSVar;
    Q.setFromEuler(EU.set(0, rng()*7, (rng()-0.5)*0.12));
    M.compose(V.set(x,y-0.3,z), Q, S.set(s,s,s));
    trunks.setMatrixAt(i,M);
    M.compose(V.set(x+Math.sin(2.4)*0.8*s, y+6.1*s, z), Q, S.set(s*(0.9+rng()*0.5), s, s*(0.9+rng()*0.5)));
    cans.setMatrixAt(i,M);
    // corruption gradient: healthy near spawn, twisted/dark deep in the Heart of the Bloom
    const corrupt = corruptionAt(x,z);
    /* THIS is what stops a forest being one flat green: jitterFor('tree') first picks one of the
       palette's three weighted canopy VARIANTS — the world's species, at fixed hue/sat/value
       offsets that pickL enforced the readability floors on all three of at once — and only then
       jitters that individual tree inside a budget narrower than the variant spacing, so an
       instance can never wander into another species' identity or out of its world's season band.
       item 41 is preserved exactly: jitterFor hands back {h,s,l} in sRGB precisely so this stays
       the setHSL(..., THREE.SRGBColorSpace) call it always was. */
    jitterFor(theme, 'tree', rng, J);
    canColor.setHSL(J.h, J.s, J.l, THREE.SRGBColorSpace);
    canColor.lerp(corruptCol, corrupt*0.85);          // corruption first: it is an absolute colour
    cans.setColorAt(i, ratioTo(canColor, canBase));   // ...then divide out what the map already paints
    jitterFor(theme, 'trunk', rng, J);
    trunkColor.setHSL(J.h, J.s, J.l, THREE.SRGBColorSpace);
    trunkColor.lerp(trunkCorrupt, corrupt*0.7);
    trunks.setColorAt(i, ratioTo(trunkColor, cTrunk));
    // collider straight out of the trunk's own matrix (item 01): r is the trunk's base radius,
    // top its visual height. Canopies stay walk-through — you duck under branches, not around.
    COLLIDERS.push({ x, z, r: 0.7*s, bot: y-0.3, top: y-0.3 + 6*s });
  });
  // item 06: the sweep the island never had to do. Casters are the props with a readable
  // silhouette; the ink-outline hulls deliberately do NOT cast (a BackSide shell casts a shadow
  // ~8% too big around its own owner) and neither does the 22k-blade grass batch.
  trunks.castShadow = true; cans.castShadow = true; cans.receiveShadow = true;
  addTo(scene, trunks, cans);
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
  addTo(scene, canHull);
  world.treePos = treePos;

  /* ----- rocks (dry grey + mossy variants) ----- */
  const rockGeo = new THREE.DodecahedronGeometry(1, 0);
  { const p = rockGeo.attributes.position; // knock off the perfect-solid look
    for(let i=0;i<p.count;i++){
      const x=p.getX(i), y=p.getY(i), z=p.getZ(i);
      const j = 1 + F.detail(x*1.6+y, z*1.6)*0.16;
      p.setXYZ(i, x*j, y*j, z*j);
    }
    rockGeo.computeVertexNormals(); }
  function makeStrataTexture(){
    const c=document.createElement('canvas'); c.width=64; c.height=64;
    const g=c.getContext('2d');
    /* The bands are a VALUE texture — the strata pattern is geology, the colour is the world's
       and arrives per instance below. Leaving the old authored purple-brown greys here would
       tint every world's rock back toward the same stone, which is the thing the palette's
       "rock is a desaturated relative of the soil" rule exists to avoid. */
    const bands = ['#9a9a9a','#848484','#727272','#8a8a8a','#6d6d6d','#949494'];
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
  for(let i=0;i<PARAMS.rockAmbient;i++){
    const x=(rng()-0.5)*WORLD_SIZE*PARAMS.rockSpread, z=(rng()-0.5)*WORLD_SIZE*PARAMS.rockSpread;
    const s=PARAMS.rockSMin+rng()*PARAMS.rockSVar;
    rockPlacements.push({ x, z, s, sy:s*0.75, rx:rng(), ry:rng()*7, rz:rng() });
  }
  // dramatic rock formations: small dense clusters of bigger rocks, so some places read as
  // a deliberate outcrop/cliff rather than scattered clutter — 3-5 per world, unique each time
  const formationCount = PARAMS.formMin + ((rng()*PARAMS.formVar)|0);
  for(let f=0; f<formationCount; f++){
    const fa=rng()*Math.PI*2, fd=PARAMS.formDMin+rng()*PARAMS.formDVar;
    const fx=Math.cos(fa)*fd, fz=Math.sin(fa)*fd;
    const memberCount = PARAMS.formMemMin + ((rng()*PARAMS.formMemVar)|0);
    for(let m=0;m<memberCount;m++){
      const oa=rng()*Math.PI*2, od=rng()*PARAMS.formSpread;
      const x=fx+Math.cos(oa)*od, z=fz+Math.sin(oa)*od;
      const s = PARAMS.formSMin+rng()*PARAMS.formSVar;
      rockPlacements.push({ x, z, s, sy:s*(0.7+rng()*0.5), rx:rng()*0.4, ry:rng()*7, rz:rng()*0.4 });
    }
  }
  // cave mouths: pick 1-2 spots, wall them in with big rocks on every side but the mouth
  // direction. actual cave interior (void/light/glow) is built later once decorative-mushroom
  // geometry is available to reuse; here we just reserve the spots + build the rock walls.
  const caveSpots = [];
  const caveCount = 1 + (rng()<PARAMS.caveSecondChance ? 1 : 0);
  for(let c=0;c<caveCount;c++){
    // item 26: through the shared sampler, so a cave mouth can't open into an authored site's
    // basin (or into the ravine) — the alternative was raw polar coordinates and a prayer.
    const cSite = spot(rng, PARAMS.caveDMin, PARAMS.caveDMin+PARAMS.caveDVar, PARAMS.exclCave);
    const cx=cSite.x, cz=cSite.z, cy=groundHeight(cx,cz);
    const mouthDir = rng()*Math.PI*2;
    caveSpots.push({ cx, cz, cy, mouthDir });
    // the wall rocks get their colliders from the shared rock loop below; the mouth itself
    // stays deliberately open. The exclusion keeps ambient props from blocking the entrance.
    EXCLUSIONS.push({ x:cx, z:cz, r:PARAMS.exclCave, tag:'cave' });
    for(let k=0;k<PARAMS.caveWalls;k++){
      const ang = mouthDir + Math.PI + (rng()-0.5)*2.6; // wall rocks opposite the mouth opening
      const rad = PARAMS.caveWallRMin+rng()*PARAMS.caveWallRVar;
      const x = cx+Math.cos(ang)*rad, z = cz+Math.sin(ang)*rad;
      const s = PARAMS.caveWallSMin+rng()*PARAMS.caveWallSVar;
      rockPlacements.push({ x, z, s, sy:s*(0.9+rng()*0.4), rx:rng()*0.3, ry:rng()*7, rz:rng()*0.3 });
    }
    // ---- the chamber this mouth actually leads to: a sealed disc far outside the playable
    // ring (2.4 rad ~= the golden angle, so a second chamber can never land near the first).
    // groundHeight() already returns caveChamberFloorY for anything inside its radius (the
    // override lives above ravineDepth in the pipeline), so every placement below — the wall
    // ring, the floor mesh, the crystal scatter — reads a flat floor for free.
    const mouthX = Math.cos(mouthDir), mouthZ = Math.sin(mouthDir);
    const chAngle = rng()*Math.PI*2 + c*2.4, chDist = PARAMS.caveChamberDist + c*PARAMS.caveChamberSpacing;
    const chX = Math.cos(chAngle)*chDist, chZ = Math.sin(chAngle)*chDist;
    const floorY = PARAMS.caveChamberFloorY;
    const chamber = { index:c, x:chX, z:chZ, r:PARAMS.caveChamberR, floorY,
      entryTrigger: { x: cx - mouthX*1.6, z: cz - mouthZ*1.6 },     // matches the void's position below
      exitWorld: { x: cx + mouthX*2.4, y: cy, z: cz + mouthZ*2.4 }, // just outside the mouth, so exiting can't re-trigger it
      cleared: false };
    CAVE_CHAMBERS.push(chamber);
    EXCLUSIONS.push({ x:chX, z:chZ, r:PARAMS.caveChamberR, tag:'caveChamber' });
    for(let k=0;k<PARAMS.caveChamberWalls;k++){
      const ang = (k/PARAMS.caveChamberWalls)*Math.PI*2 + (rng()-0.5)*0.3; // full ring: a sealed room, no gap
      const rad = PARAMS.caveChamberWallR + (rng()-0.5)*1.6;
      const x = chX+Math.cos(ang)*rad, z = chZ+Math.sin(ang)*rad;
      const s = PARAMS.caveChamberWallSMin+rng()*PARAMS.caveChamberWallSVar;
      rockPlacements.push({ x, z, s, sy:s*(1.1+rng()*0.5), rx:rng()*0.3, ry:rng()*7, rz:rng()*0.3 });
    }
  }
  world.caveSpots = caveSpots;
  world.caveChambers = CAVE_CHAMBERS;
  const rockCount = rockPlacements.length;
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, rockCount);
  // theme.moss for the mossy variant, per-instance jitterFor('rock') for the dry one: rock is a
  // desaturated relative of this world's soil, so the scatter reads as the same geology as the
  // terrain's rock band and the formations, not as grey props dropped on a coloured field.
  const rockMoss = new THREE.Color(theme.moss), rockCorrupt = new THREE.Color(0x241a30);
  const rockColor = new THREE.Color();
  rockPlacements.forEach((rp,i)=>{
    const gy = groundHeight(rp.x,rp.z);
    Q.setFromEuler(EU.set(rp.rx, rp.ry, rp.rz));
    M.compose(V.set(rp.x, gy+rp.s*0.2, rp.z), Q, S.set(rp.s, rp.sy, rp.s));
    rocks.setMatrixAt(i, M);
    // same loop as the matrix, so a rock's collision can't drift from the rock you can see.
    // THRESHOLD: only register if the top clears STEP above the ground. Anything shorter is
    // something you walk over, so a collider there would just be an invisible wall — which is
    // also why grass, bushes, flowers, moss and log rubble never register at all.
    const rTop = gy + rp.s*0.2 + rp.sy;
    if(rTop - gy > STEP) COLLIDERS.push({ x:rp.x, z:rp.z, r:rp.s*0.8, bot:gy, top:rTop });
    const mossAmt = rng() < 0.4 ? 0.35+rng()*0.5 : rng()*0.12;
    const corrupt = corruptionAt(rp.x,rp.z);
    jitterFor(theme, 'rock', rng, J);
    rockColor.setHSL(J.h, J.s, J.l, THREE.SRGBColorSpace);
    // one reused Color, not a clone per rock: the strata map is neutral, so no ratio is needed
    rocks.setColorAt(i, rockColor.lerp(rockMoss, mossAmt).lerp(rockCorrupt, corrupt*0.75));
  });
  rocks.castShadow = true; rocks.receiveShadow = true;
  addTo(scene, rocks);
  const rockHull = new THREE.InstancedMesh(rockGeo, hullMat, rockCount);
  { const P3 = new THREE.Vector3(), Q3 = new THREE.Quaternion(), S3 = new THREE.Vector3();
    for(let i=0;i<rockCount;i++){
      rocks.getMatrixAt(i, M);
      M.decompose(P3, Q3, S3);
      rockHull.setMatrixAt(i, M.compose(P3, Q3, S3.multiplyScalar(1.09)));
    } }
  addTo(scene, rockHull);

  /* ----- stepped rock formations (items 34, 55) — the props you PLATFORM up -----
     The instanced batch above is rubble: one silhouette, repeated, walked over. This is the other
     thing rock can be — a multi-tier outcrop where every tier is a floor. rockgen pushes one
     collider per tier from the same loop that writes that tier's vertices, so "if you can see it
     you can stand on it" holds by construction instead of by agreement.

     SIZE IS A ROLE, NOT A LOOK. A one-tier lump is a step you take mid-fight; a three-tier
     terrace is a route; a six-tier tower is a destination you can see from across the valley and
     decide to walk to. So the size parameter `u` is sampled continuously, every other dial is
     rolled independently of it, and WHERE a formation goes depends on how big it came out: the
     big ones have to earn their place on a site apron, a ravine bank or a landmark forecourt,
     while the small ones scatter freely. A six-tier tower dropped at random in a flat glade is
     how you end up with landmarks that mean nothing.

     THE ROUTE IS THE POINT. Rises stay inside the 1.55-1.85 m band whatever the size, so every
     tier is one jump; the tier count falls off toward the rim, so a formation is a ramp on the
     outside and a staircase in the middle; and one rim block is pushed past the apex so the thing
     keeps a corner you can only reach from a tier you already climbed. */
  const stepRng = mulberry32(deriveSeed(seed, 0x57e99));
  {
    const pick = (pair)=> pair[0] + stepRng()*pair[1];
    const lerpN = (pair, t)=> Math.max(0, Math.round(pair[0] + (pair[1] - pair[0])*t));
    // this world's character, rolled once: 0 = gentle ground with one dramatic tower, 1 = badlands
    const bias = stepRng();
    const plan = [];
    for(let i=0;i<lerpN(PARAMS.stepBigN, bias);i++)   plan.push({ cls:'big',   u: pick(PARAMS.stepUBig) });
    for(let i=0;i<lerpN(PARAMS.stepMedN, bias);i++)   plan.push({ cls:'med',   u: pick(PARAMS.stepUMed) });
    for(let i=0;i<lerpN(PARAMS.stepSmallN, bias);i++) plan.push({ cls:'small', u: pick(PARAMS.stepUSmall) });

    const stepBase = (x, z, pad)=> slopeAt(x, z) < PARAMS.stepSlope
      && !inExclusion(x, z, pad) && groundHeight(x, z) > PARAMS.stepMinH && clearOf(x, z, pad);

    const geos = [];
    const stats = { bias:+bias.toFixed(3), clusters:0, stacks:0, tiers:0, tall:0, at:[],
                    byClass:{ small:0, med:0, big:0 }, rises:[], heights:[], radii:[], tierN:[] };
    const sitesLeft = SITES.slice();

    for(const item of plan){
      const u = item.u;
      // ---- derive the formation from u, then roll every other dial independently of it ----
      const tiersMax = Math.max(1, Math.min(PARAMS.stepTierMax,
        Math.round(1 + Math.pow(u, 0.85)*(PARAMS.stepTierMax - 1))));
      const baseR = PARAMS.stepRMin + u*PARAMS.stepRVar;
      const cells = Math.max(2, Math.round(PARAMS.stepCellMin + u*PARAMS.stepCellVar));
      const spacing = pick(PARAMS.stepSpacing);
      const shrink = Math.min(pick(PARAMS.stepShrink),
        1 - Math.min(0.38, PARAMS.stepLedgeMin/Math.max(1.6, baseR)));
      const cols = Math.max(1, Math.round(Math.sqrt(cells*1.3)));
      const rows = Math.max(1, Math.ceil(cells/cols));
      // footprint drives the clearance it asks for: a tower needs a forecourt, a step needs none
      const foot = baseR + baseR*spacing*(Math.max(cols, rows) - 1)*0.5;
      const pad = Math.min(PARAMS.stepPadMax, Math.max(2, foot*PARAMS.stepPadK));

      // ---- WHERE. Big formations are destinations, so they take the authored anchors first. ----
      let spot = null, why = 'open';
      if(item.cls === 'big'){
        while(!spot && sitesLeft.length){
          const s = sitesLeft.shift();
          for(let k=0;k<14;k++){
            const a = stepRng()*Math.PI*2, d = s.r + PARAMS.stepSiteApron*(0.6 + stepRng()*0.7);
            const x = s.x + Math.cos(a)*d, z = s.z + Math.sin(a)*d;
            if(stepBase(x, z, pad)){ spot = { x, z }; why = 'site'; break; }
          }
        }
        if(!spot && RAVINE){
          // a ravine lip is a point legal to stand on a few metres from one that is not: the gap
          // between two clearances IS the edge, so RAVINE never has to be published to find it.
          const p = scatter(stepRng, 1, 0, (x,z)=> stepBase(x,z,pad) && inExclusion(x, z, PARAMS.stepEdgeBand),
            { r0:PARAMS.stepDMin, r1:PARAMS.stepDMax })[0];
          if(p){ spot = p; why = 'ravine'; }
        }
      }
      if(!spot){
        const minD = item.cls === 'big' ? 70 : item.cls === 'med' ? 44 : 20;
        const p = scatter(stepRng, 1, 0, (x,z)=>{
          if(!stepBase(x, z, pad)) return false;
          for(const a of stats.at){ const dx = x-a.x, dz = z-a.z; if(dx*dx + dz*dz < minD*minD) return false; }
          return true;
        }, { r0:PARAMS.stepDMin, r1:PARAMS.stepDMax })[0];
        if(!p) continue;
        spot = p;
      }

      /* One {base, side, tint} per FORMATION, off one of this world's five rock families, with a
         single hue/sat/value shift applied to all three together — which is why a jittered
         formation still reads as one rock instead of three unrelated greys stacked up. A pocket
         forces its own geology, so a crystal hollow is this world's rock that grew a seam rather
         than a prop imported from another palette. */
      const fam = POCKETS.crystalHollow && Math.hypot(spot.x-POCKETS.crystalHollow.x, spot.z-POCKETS.crystalHollow.z) < POCKETS.crystalHollow.r ? 'crystal'
                : POCKETS.witheredHollow && Math.hypot(spot.x-POCKETS.witheredHollow.x, spot.z-POCKETS.witheredHollow.z) < POCKETS.witheredHollow.r ? 'rot'
                : undefined;
      const pal = rockSetFor(theme, stepRng, fam);
      // A formation's own tiers must not reject its own neighbours, so the cell clearance only
      // looks at what was already standing here when this formation started.
      const before = COLLIDERS.length;
      const cellClear = (x, z)=>{
        for(let i=0;i<before;i++){
          const c = COLLIDERS[i];
          if(c.off) continue;
          const dx = x-c.x, dz = z-c.z, rr = c.r + PARAMS.stepCellPad;
          if(dx*dx + dz*dz < rr*rr) return false;
        }
        return true;
      };
      // item 55: the lattice step stays keyed to the UNJITTERED base radius, so the mosaic tiles
      // cleanly while every cell reads as its own broken chunk.
      const lat = jitterLattice(stepRng, {
        shape: cells <= 4 ? 'line' : 'hex',
        r: baseR, h: PARAMS.stepRiseMin + stepRng()*PARAMS.stepRiseVar, spacing,
        cx: spot.x, cz: spot.z, cols, rows, count: cells, angle: stepRng()*Math.PI*2,
        rMul:[0.82, 1.28], hMul:[0.94, 1.0], sides: PARAMS.stepSides, tiers:[1,1],
        // edgeScale stays 1 here and the crest fall-off is applied below instead: a hex lattice's
        // own `edge` is measured from the row-offset grid, so on a 3x3 hex NO cell reads as the
        // centre and the tier gradient silently flattens — which is a five-tier tower coming out
        // three tiers tall. Distance from the formation's own centre is the honest measure.
        pos:0.22, tilt:0.04, edgeScale: 1,
        test: (x,z)=> slopeAt(x,z) < PARAMS.stepSlope && !inExclusion(x, z, PARAMS.stepCellPad)
          && groundHeight(x, z) > PARAMS.stepMinH && cellClear(x, z),
      });
      if(lat.length < 1) continue;
      // A formation whose crest cell got rejected reads as a ring of rim blocks with nothing in
      // the middle — i.e. a "big" landmark that is 2 m tall. If nothing landed near the centre and
      // the centre is legal, the crest goes there explicitly.
      let hasCore = false;
      for(const c of lat) if(Math.hypot(c.x - spot.x, c.z - spot.z) < foot*0.35){ hasCore = true; break; }
      if(!hasCore && cellClear(spot.x, spot.z) && slopeAt(spot.x, spot.z) < PARAMS.stepSlope)
        lat.unshift({ x:spot.x, z:spot.z, edge:0, r:baseR,
          h: PARAMS.stepRiseMin + stepRng()*PARAMS.stepRiseVar, tiers:1,
          sides: PARAMS.stepSides[0] + ((stepRng()*(PARAMS.stepSides[1]-PARAMS.stepSides[0]+1))|0),
          rotY: stepRng()*Math.PI*2, tiltX:0, tiltZ:0 });
      // the unreachable corner comes from the RIM, never the crest: pushing a crest cell past the
      // apex would put the whole staircase out of reach instead of just its last block.
      let tall = -1;
      if(tiersMax >= 3) for(let i=0;i<lat.length;i++)
        if(Math.hypot(lat[i].x - spot.x, lat[i].z - spot.z) >= foot*0.4){ tall = i; break; }
      const taper = pick(PARAMS.stepTaper);
      // drift has a FLOOR on anything you are meant to climb: offsetting each tier's centre gives
      // one flank a ledge much wider than the bare annulus, which is the side the route goes up.
      // Perfectly concentric tiers narrow to nothing by the third one.
      const drift = tiersMax >= 3 ? Math.max(0.22, pick(PARAMS.stepDrift)) : pick(PARAMS.stepDrift);
      const capRise = pick(PARAMS.stepCapRise), capJit = pick(PARAMS.stepCapJit);
      const wobble = pick(PARAMS.stepWobble);

      let top = 0;
      const eNorm = Math.max(1e-6, foot*0.9);
      for(let i=0;i<lat.length;i++){
        const c = lat[i];
        const e = Math.min(1, Math.hypot(c.x - spot.x, c.z - spot.z)/eNorm);
        const fall = 1 + (PARAMS.stepEdgeScale - 1)*e;
        // tiers fall off toward the rim: that gradient IS the route. A uniform stack height would
        // be a ring of pillars with nothing to climb.
        const isTall = i === tall;
        // ^0.7 widens the crest: with a linear fall-off half the cells come out single-tier and
        // the formation reads as a plinth with one spike on it rather than as terraces.
        const tiers = isTall ? 1 : Math.max(1, Math.min(tiersMax,
          Math.round(1 + Math.pow(1 - e, 0.7)*(tiersMax - 1))));
        const rise = (isTall ? c.h*PARAMS.stepTallMul : c.h) * fall;
        const g = makeStack(stepRng, Object.assign({}, PRESETS.tower, {
          r: c.r*fall, h: rise, tiers, sides: c.sides,
          taper, bulge: 1.0, wobble, shrink: [shrink, Math.min(0.95, shrink + 0.08)],
          hScale: [0.94, 1.0], drift, sink: PARAMS.stepSink,
          capJitter: capJit, capRise,
          hull: 0.07, base: pal.base, side: pal.side, tint: pal.tint,
          x: c.x, y: groundHeight(c.x, c.z), z: c.z,
          rotY: c.rotY, tiltX: c.tiltX, tiltZ: c.tiltZ,
        }), COLLIDERS);
        if(g.userData.height > top) top = g.userData.height;
        stats.rises.push(+rise.toFixed(2));
        stats.tierN.push(tiers);
        stats.radii.push(+(c.r*fall).toFixed(2));
        if(isTall) stats.tall++;
        stats.tiers += tiers;
        geos.push(g);
      }
      stats.clusters++; stats.byClass[item.cls]++;
      stats.heights.push(+top.toFixed(2));
      // exactly the colliders THIS formation pushed, so a climbability probe can ask about its own
      // tiers instead of guessing which nearby cylinder was a tree
      const tops = [];
      for(let i=before;i<COLLIDERS.length;i++) tops.push(+COLLIDERS[i].top.toFixed(2));
      tops.sort((a,b)=>a-b);
      stats.at.push({ x:+spot.x.toFixed(2), z:+spot.z.toFixed(2), cls:item.cls, u:+u.toFixed(3),
        why, cells:lat.length, tiersMax, r:+baseR.toFixed(2), h:+top.toFixed(2), foot:+foot.toFixed(1),
        shrink:+shrink.toFixed(3), taper:+taper.toFixed(3), drift:+drift.toFixed(3), tops });
    }
    stats.stacks = geos.length;
    if(geos.length){
      const { geo, hull } = mergeStacks(geos);
      // Dozens of individually shaped, individually placed rocks in ONE draw call: the placement is
      // baked into the vertices, which is the one thing an InstancedMesh cannot do.
      const form = new THREE.Mesh(geo, toonMat({ color:0xffffff, vertexColors:true, rim:0.3 }));
      form.name = 'rockFormations';   // named so a panel (or a draw-call probe) can find the batch
      form.castShadow = true; form.receiveShadow = true;
      addTo(scene, form);
      // NEVER addOutline() here. It scales a mesh about its own origin, and these vertices are
      // already in world space, so scaling would push every rock AWAY from the world origin
      // instead of thickening it. rockgen bakes the ink shell per rock, in local space, before
      // placement, and merges it separately — that is what `hull` is.
      if(hull){
        const ink = new THREE.Mesh(hull, hullMat);
        ink.name = 'rockFormationsInk';
        addTo(scene, ink);
      }
    }
    world.rockFormations = stats;   // dev panel / verification: the realized distribution
  }

  /* ----- LANDMARK: rune boulder ----- */
  {
    const bSite = spot(rng, PARAMS.boulderDMin, PARAMS.boulderDMin + PARAMS.boulderDVar);
    const ba = Math.atan2(bSite.z, bSite.x);
    const bx = bSite.x, bz = bSite.z, by = groundHeight(bx, bz);
    const boulder = new THREE.Mesh(rockGeo, rockMat.clone());
    // the rune boulder is a mossy specimen of this world's rock, not a second grey
    boulder.material.color.set(rockMoss.clone().lerp(new THREE.Color(theme.rock.stone.side), 0.3));
    const bs = PARAMS.boulderSMin + rng()*PARAMS.boulderSVar;
    boulder.scale.set(bs, bs*0.8, bs);
    boulder.rotation.set(rng(), rng()*7, rng()*0.3);
    boulder.position.set(bx, by+bs*0.35, bz);
    COLLIDERS.push({ x:bx, z:bz, r:bs*0.8, bot:by, top:by+bs*0.35+bs*0.8 });
    boulder.castShadow = true; boulder.receiveShadow = true;
    addOutline(boulder, 0.03);
    addTo(scene, boulder);
    const runeMat2 = new THREE.MeshBasicMaterial({ color:0x7de8ff, transparent:true, opacity:0.85,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });
    const rune2 = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.9, 3), runeMat2);
    rune2.position.set(bx + Math.cos(ba+1.6)*bs*0.75, by+bs*0.55, bz + Math.sin(ba+1.6)*bs*0.75);
    rune2.lookAt(bx, by+bs*0.55, bz); rune2.rotateY(Math.PI);
    addTo(scene, rune2);
    const pl3 = new THREE.PointLight(0x7de8ff, 8, 14); pl3.position.set(bx, by+bs*0.6, bz);
    addTo(scene, pl3);
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
    const spanLen = RAVINE.width*2.4;
    /* The deck is PITCHED to meet both banks, not levelled at the midpoint. A movement constant is
       a level-design constraint: STEP is 1.5, so a deck end sitting more than 1.5 m above its bank
       is a bridge you cannot get onto — and with the new relief (item 27) the pre-carve grade
       across a crossing can differ by 4+ m between the two banks. Sampling BOTH ends and tilting
       between them is what keeps the crossing usable in every world instead of most of them. */
    const yA = baseTerrainHeight(bx - dirX*spanLen*0.5, bz - dirZ*spanLen*0.5);
    const yB = baseTerrainHeight(bx + dirX*spanLen*0.5, bz + dirZ*spanLen*0.5);
    const baseY = (yA + yB)*0.5, pitch = -Math.atan2(yB - yA, spanLen);
    // the bridge is cut from this world's trees, so its planks are this world's bark.
    const deckC = new THREE.Color(theme.trunkDark);
    const deckMat = toonMat({ color:0xffffff,
      map: paintTexture('#'+deckC.getHexString(),
        [{c:'#'+offsetHSLsRGB(deckC.clone(), 0, 0.02, -0.08).getHexString(), n:24, r:5, a:0.45}], {dabs:220}), rim:0.25 });
    const railMat = toonMat({ color:theme.trunkDark, rim:0.3 });
    const group = new THREE.Group();
    const deck = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.22, spanLen), deckMat);
    deck.castShadow = true; deck.receiveShadow = true;
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
    // YXZ: yaw the span onto the ravine first, THEN pitch about the deck's own long axis. With the
    // default XYZ order the pitch would happen about the world X and twist the deck sideways.
    group.rotation.order = 'YXZ';
    group.rotation.y = Math.atan2(dirX, dirZ);
    group.rotation.x = pitch;
    addTo(scene, group);
    // the deck is a STANDABLE collider, not a wall: top sits at the deck surface so surfaceAt
    // carries you over the gully instead of dropping you in. One short cylinder per metre of
    // span — a single disc wide enough to cover the deck would wall off the ravine beside it,
    // and `bot` stays just under the deck so you can still walk through underneath.
    const deckSegs = Math.max(3, Math.round(spanLen));
    for(let i=0;i<deckSegs;i++){
      const f = i/(deckSegs-1), t = (f - 0.5)*spanLen;
      // each collider's top is the deck surface AT THAT POINT along the pitch, out of the same
      // loop that walks the span — so the standable height can't drift from the plank you see.
      const deckTop = yA + (yB - yA)*f - 0.11;
      COLLIDERS.push({ x: bx + dirX*t, z: bz + dirZ*t, r: 0.95, bot: deckTop-0.6, top: deckTop });
    }
    EXCLUSIONS.push({ x:bx, z:bz, r:PARAMS.exclBridge, tag:'bridge' });
  }

  /* ----- bushes (mid-height clutter between grass and trees) ----- */
  const bushGeo = new THREE.IcosahedronGeometry(0.85, 1);
  { const p = bushGeo.attributes.position;
    for(let i=0;i<p.count;i++){
      const v = new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i));
      const n = 1 + F.detail(v.x*0.9+v.y, v.z*0.9)*0.22;
      p.setXYZ(i, v.x*n, v.y*n*0.72, v.z*n);
    } }
  /* theme.bush / theme.bushDeep replace the authored 0x4a7a2e / #2f5a1c pair. bush is solved
     against the ground's luminance (bushVsGround), bushDeep is its own shadow tone, so the
     undergrowth layer separates from the terrain in every world instead of only in the four
     worlds the authored greens were picked for. */
  const bushBase = new THREE.Color(theme.bush), bushDeep = new THREE.Color(theme.bushDeep);
  const bushMat = toonMat({ color:0xffffff,
    map: paintTexture('#'+bushBase.getHexString(), [{c:'#'+bushDeep.getHexString(), n:40, r:12, a:0.3}], {dabs:220}),
    rim:0.45, rimColor:0xc8ffb0 });
  const bushCount = PARAMS.bushCount;
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, bushCount);
  const bushColor = new THREE.Color();
  for(let i=0;i<bushCount;i++){
    const a=rng()*Math.PI*2, r=PARAMS.bushRMin+rng()*PARAMS.bushRVar;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const s = PARAMS.bushSMin+rng()*PARAMS.bushSVar;
    Q.setFromEuler(EU.set(0, rng()*7, 0));
    M.compose(V.set(x, groundHeight(x,z)+0.3*s, z), Q, S.set(s, s*0.85, s));
    bushes.setMatrixAt(i, M);
    // same trick as the canopy: one shared J, one shared Color, ratio against what the map paints
    jitterFor(theme, 'bush', rng, J);
    bushColor.setHSL(J.h, J.s, J.l, THREE.SRGBColorSpace);
    bushes.setColorAt(i, ratioTo(bushColor, bushBase));
  }
  bushes.castShadow = true;
  addTo(scene, bushes);
  const bushHull = new THREE.InstancedMesh(bushGeo, hullMat, bushCount);
  { const Pb=new THREE.Vector3(), Qb=new THREE.Quaternion(), Sb=new THREE.Vector3();
    for(let i=0;i<bushCount;i++){
      bushes.getMatrixAt(i, M);
      M.decompose(Pb, Qb, Sb);
      bushHull.setMatrixAt(i, M.compose(Pb, Qb, Sb.multiplyScalar(1.08)));
    } }
  addTo(scene, bushHull);

  /* ----- fallen logs (knotted, moss-grown forest-floor debris) ----- */
  function makeRingTexture(){
    const c=document.createElement('canvas'); c.width=c.height=128;
    const g=c.getContext('2d');
    g.fillStyle='#e8d4a8'; g.fillRect(0,0,128,128);
    const rings=['#c9a86c','#a8824a','#8a6234','#c9a86c','#b08a52'];
    for(let r=58;r>4;r-=6+Math.random()*3){
      // PARENTHESES ARE LOAD-BEARING: `%` binds tighter than `|`, so `rings[(r/6)|0 % rings.length]`
      // parsed as `rings[(r/6) | (0 % 5)]` = `rings[(r/6)|0]`, an index running 9..0 into a 5-entry
      // array. Every ring at r > 29 read `undefined`, canvas fell back to black, and the outer half
      // of every log's end cap was drawn in ink instead of wood.
      g.strokeStyle=rings[((r/6)|0) % rings.length]; g.lineWidth=1.6+Math.random();
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
      const bulge = 1 + F.detail(y*1.3, Math.atan2(z,x)*1.4)*0.16 + Math.sin(y*2.1)*0.04;
      p.setXYZ(i, x*bulge, y, z*bulge);
    }
    logGeo.computeVertexNormals(); }
  // a fallen log is a tree that fell over, so it is the same bark the trunks are: theme.trunk
  // over theme.trunkDark, not a second authored brown that drifts from it.
  const logMat = toonMat({ color:0xffffff,
    map: paintTexture('#'+cTrunkDark.getHexString(),
      [{c:'#'+offsetHSLsRGB(cTrunkDark.clone(), 0, 0.02, -0.06).getHexString(), n:30, r:5, a:0.45}], {dabs:260}), rim:0.25 });
  const capMatLog = toonMat({ color:0xffffff, map: makeRingTexture(), rim:0.2 });
  const logCount = PARAMS.logCount;
  const logs = new THREE.InstancedMesh(logGeo, logMat, logCount);
  const logCaps = new THREE.InstancedMesh(new THREE.CircleGeometry(0.5, 14), capMatLog, logCount*2);
  const logData = [];
  for(let i=0;i<logCount;i++){
    const a=rng()*Math.PI*2, r=PARAMS.logRMin+rng()*PARAMS.logRVar;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    const s = PARAMS.logSMin+rng()*PARAMS.logSVar;
    const yaw = rng()*7, roll = (rng()-0.5)*0.2;
    /* 'YXZ', and the order is the whole fix. The default 'XYZ' applies the X quarter-turn FIRST,
       which lays the cylinder down — and then `yaw` rotates about what is now the log's own length
       axis, so it only spins the log in place instead of turning it on the ground. Every log came
       out pointing the same compass direction, and the end caps/moss offset along a local axis that
       was no longer where the code assumed. Yawing first, then tipping, is what the bridge group
       already does for the same reason. */
    Q.setFromEuler(EU.set(Math.PI/2, yaw, roll, 'YXZ'));
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
  logs.castShadow = true; logs.receiveShadow = true;
  addTo(scene, logs, logCaps);
  const logHull = new THREE.InstancedMesh(logGeo, hullMat, logCount);
  { const Pl=new THREE.Vector3(), Ql=new THREE.Quaternion(), Sl=new THREE.Vector3();
    for(let i=0;i<logCount;i++){
      logs.getMatrixAt(i, M);
      M.decompose(Pl, Ql, Sl);
      logHull.setMatrixAt(i, M.compose(Pl, Ql, Sl.multiplyScalar(1.07)));
    } }
  addTo(scene, logHull);
  // moss patches + tiny mushroom sprouts on ~half the logs — batched into at most
  // 3 InstancedMesh draws total (was 1 individual mesh/group per patch)
  const mossBlobGeo = new THREE.IcosahedronGeometry(0.22, 0);
  { const p = mossBlobGeo.attributes.position;
    for(let i=0;i<p.count;i++) p.setY(i, Math.max(-0.06, p.getY(i)*0.55)); }
  // theme.moss is the canopy hue pushed darker — moss on a log is the same vegetation family as
  // the tree it fell off, so it has to track the world's foliage rather than a fixed green.
  const mossBlobMat = toonMat({ color:theme.moss, rim:0.5, rimColor:0xc8ffb0 });
  const sproutStemMat = toonMat({ color:0xe8dcc0, rim:0.25 });
  const sproutCapMat = toonMat({ color:0xd97a4a, rim:0.4, rimColor:0xffcfa0 });
  const sproutStemGeo = new THREE.CylinderGeometry(0.03, 0.045, 0.16, 5);
  const sproutCapGeo = new THREE.SphereGeometry(0.09, 7, 5, 0, Math.PI*2, 0, Math.PI*0.6);
  const logBits = [];
  for(const ld of logData){
    const along = new THREE.Vector3(0,1,0).applyQuaternion(ld.q);
    const up = new THREE.Vector3(0,0,-1).applyQuaternion(ld.q); // top of the cylinder in world space
    const nBits = PARAMS.logBitsMin + ((rng()*PARAMS.logBitsVar)|0);
    for(let k=0;k<nBits;k++){
      const t = (rng()-0.5)*3.0*ld.s;
      const base = new THREE.Vector3(ld.x, ld.y, ld.z).addScaledVector(along, t).addScaledVector(up, 0.46*ld.s);
      logBits.push({ pos:base, scale:0.7+rng()*0.9, ry:rng()*7, isBlob: rng()<PARAMS.logBlobChance });
    }
  }
  const blobBits = logBits.filter(b=>b.isBlob);
  const sproutBits = logBits.filter(b=>!b.isBlob);
  if(blobBits.length){
    const mossBlobs = new THREE.InstancedMesh(mossBlobGeo, mossBlobMat, blobBits.length);
    blobBits.forEach((b,i)=>{
      Q.setFromEuler(EU.set(0,b.ry,0));
      M.compose(b.pos, Q, S.set(b.scale,b.scale,b.scale));
      mossBlobs.setMatrixAt(i, M);
    });
    addTo(scene, mossBlobs);
  }
  if(sproutBits.length){
    const sproutStems = new THREE.InstancedMesh(sproutStemGeo, sproutStemMat, sproutBits.length);
    sproutStems.userData.noReceive = true;      // same rule, 16 cm tall — a shadow here is one dark pixel
    const sproutCaps = new THREE.InstancedMesh(sproutCapGeo, sproutCapMat, sproutBits.length);
    const upY = new THREE.Vector3(0,1,0);
    sproutBits.forEach((b,i)=>{
      Q.setFromEuler(EU.set(0,b.ry,0));
      M.compose(V.copy(b.pos).addScaledVector(upY, 0.08*b.scale), Q, S.set(b.scale,b.scale,b.scale));
      sproutStems.setMatrixAt(i, M);
      M.compose(V.copy(b.pos).addScaledVector(upY, 0.16*b.scale), Q, S.set(b.scale,b.scale,b.scale));
      sproutCaps.setMatrixAt(i, M);
    });
    addTo(scene, sproutStems, sproutCaps);
  }

  /* ----- instanced grass with wind sway ----- */
  const bladeGeo = new THREE.PlaneGeometry(0.16, 1.1, 1, 3);
  bladeGeo.translate(0, 0.55, 0);
  { const p = bladeGeo.attributes.position; // taper to a point
    for(let i=0;i<p.count;i++){ const t = p.getY(i)/1.1; p.setX(i, p.getX(i)*(1-t*0.95)); } }
  const grassCount = Math.floor(PARAMS.grassCount*quality);
  const grassMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog:false,
    uniforms:{ uTime:{value:0}, uFog:{value:new THREE.Color(theme.fog)},
      // item 41(a): these are authored as sRGB 0-1 triples and used to be pushed at the shader
      // raw, so the base->tip gradient was interpolated between sRGB-encoded numbers under ACES —
      // the textbook muddy blend. srgbTriple() converts once, here, and the mix stays linear.
      uGB1:{value:srgbTriple(...theme.grassBase.slice(0,3))},
      uGB2:{value:srgbTriple(...theme.grassBase.slice(3,6))},
      uGT1:{value:srgbTriple(...theme.grassTip.slice(0,3))},
      uGT2:{value:srgbTriple(...theme.grassTip.slice(3,6))} },
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
    const a=rng()*Math.PI*2, r=PARAMS.grassRMin+Math.pow(rng(),0.8)*PARAMS.grassRVar;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    Q.setFromEuler(EU.set(0, rng()*7, (rng()-0.5)*0.3));
    // the fen's reeds and lily pads read as a bog only if ordinary meadow grass doesn't grow
    // straight through them — thinned by the same bog strength that slows the player, not a hard
    // cutoff, so the edge of the pocket still looks grown-in rather than mowed to a circle.
    const bog = fenBogAt(x,z);
    const s = (bog > 0.3 && rng() < bog) ? 0 : 0.6+rng()*0.9;
    M.compose(V.set(x, groundHeight(x,z), z), Q, S.set(s,s,s));
    grass.setMatrixAt(i,M);
  }
  addTo(scene, grass);
  world.updaters.push((dt,t)=>{ grassMat.uniforms.uTime.value = t; });

  /* ----- flowers ----- */
  const flowerGeo = new THREE.ConeGeometry(0.16, 0.22, 6);
  const flowerMat = new THREE.MeshBasicMaterial({ color:0xffffff });
  const flowers = new THREE.InstancedMesh(flowerGeo, flowerMat, PARAMS.flowerCount);
  /* theme.flowers is three hues either side of the accent, so the flecks of colour in the field
     belong to the same accent family as the crystals — a red-accent world gets warm flowers, not
     the same five authored candy colours in every world. White stays in the list as the neutral
     that reads against any ground. */
  const fCols = [theme.flowers[0], theme.flowers[1], theme.flowers[2], theme.accent, 0xffffff];
  const flowerColor = new THREE.Color();
  for(let i=0;i<PARAMS.flowerCount;i++){
    const a=rng()*Math.PI*2, r=PARAMS.flowerRMin+rng()*PARAMS.flowerRVar;
    const x=Math.cos(a)*r, z=Math.sin(a)*r;
    M.compose(V.set(x, groundHeight(x,z)+0.22, z), Q.identity(), S.set(1,1,1));
    flowers.setMatrixAt(i,M);
    flowers.setColorAt(i, flowerColor.set(fCols[(rng()*fCols.length)|0]));
  }
  addTo(scene, flowers);

  /* ----- decorative glowing mushrooms (harvestable — see world.harvestMushroom) -----
     item 35: instanced. One stem draw plus one cap draw per species covers every mushroom on
     the map; this was a Group with two meshes each, ~200 draw calls for decoration. Because
     harvest and respawn are per mushroom, hide/show is a per-instance scale-to-zero rather
     than a mesh toggle. Capacity is allocated up front so the cave and pocket mushrooms added
     further down the build push into these same instance arrays instead of new draw calls. */
  const deco = [];
  const capMats = {};
  for(const sp of MUSHROOM_SPECIES) capMats[sp.id] = toonMat({ color: sp.color, emissive: sp.emissive, emissiveIntensity:0.85, rim:0.5 });
  const stemGeo = new THREE.CylinderGeometry(0.12,0.2,0.7,5);
  const capGeo = new THREE.SphereGeometry(0.4, 8, 6, 0, Math.PI*2, 0, Math.PI/2);
  const stemMat = toonMat({ color:0xf2e4c8, rim:0.2 });
  const decoStems = new THREE.InstancedMesh(stemGeo, stemMat, PARAMS.decoCap);
  const decoCaps = {};
  decoStems.count = 0;
  // a batch that spans the whole map is never off screen, so frustum culling would only pay
  // for a bounding-sphere rebuild every time a mushroom sways
  decoStems.frustumCulled = false;
  /* The decorative/harvestable stems take no shadow either, for exactly the reason the enemy
     stems don't (see entities.js): a cap sits directly on top of a 0.7 m cylinder, so the stem is
     nearly always in shade from its own cap, and the one thing cream cannot survive is darkening.
     This is an InstancedMesh, so it is ONE flag for every mushroom in the world. */
  decoStems.userData.noReceive = true;
  addTo(scene, decoStems);
  for(const sp of MUSHROOM_SPECIES){
    const m = new THREE.InstancedMesh(capGeo, capMats[sp.id], PARAMS.decoCap);
    m.count = 0; m.frustumCulled = false;
    decoCaps[sp.id] = m; addTo(scene, m);
  }
  const decoM = new THREE.Matrix4(), decoQ = new THREE.Quaternion(), decoV = new THREE.Vector3();
  const decoS = new THREE.Vector3(), decoE = new THREE.Euler();
  // writes one mushroom's two instance matrices. 0.35 / 0.65 are the old Group's local stem and
  // cap offsets, and the group scale used to move them — so the sway looks exactly as before.
  // syMul <= 0 collapses the instance to nothing: that is how a harvested mushroom vanishes
  // without touching the scene graph.
  function writeDeco(e, syMul){
    const s = e.baseScale, on = syMul > 0;
    decoQ.setFromEuler(decoE.set(0, e.ry, 0));
    decoS.set(on ? s : 0, on ? s*syMul : 0, on ? s : 0);
    const px = e.g.position.x, py = e.g.position.y, pz = e.g.position.z;
    decoM.compose(decoV.set(px, py + 0.35*s*syMul, pz), decoQ, decoS);
    decoStems.setMatrixAt(e.si, decoM);
    decoM.compose(decoV.set(px, py + 0.65*s*syMul, pz), decoQ, decoS);
    const capMesh = decoCaps[e.species];
    capMesh.setMatrixAt(e.ci, decoM);
    decoStems.instanceMatrix.needsUpdate = true;
    capMesh.instanceMatrix.needsUpdate = true;
  }
  // main.js treats entry.g as an Object3D: it reads .position (and .clone()s it) and assigns
  // .visible. Instancing deletes the Object3D, so every entry gets this façade instead — a real
  // Vector3 plus a visible setter that writes the instance matrix. Same shape in, same shape
  // out, which is why main.js needs no change at all.
  class DecoHandle {
    constructor(x, y, z){ this.position = new THREE.Vector3(x, y, z); this.e = null; this._v = true; }
    get visible(){ return this._v; }
    set visible(v){ this._v = !!v; writeDeco(this.e, this._v ? 1 : 0); }
  }
  function placeMushroom(x, z, sp, sMin=PARAMS.decoSMin, sMax=PARAMS.decoSMax){
    if(deco.length >= PARAMS.decoCap) return null;  // the batch IS the budget; never grow past it
    const y = groundHeight(x,z);
    const s = sMin+rng()*(sMax-sMin);
    const capMesh = decoCaps[sp.id];
    const entry = { g:new DecoHandle(x,y,z), ph:rng()*7, species:sp.id, alive:true, respawnT:0,
      baseScale:s, ry:rng()*7, si:decoStems.count++, ci:capMesh.count++ };
    entry.g.e = entry;
    writeDeco(entry, 1);
    deco.push(entry);
    return entry;
  }
  // item 09: the baseline scatter now queries the finished world instead of taking whatever
  // polar coordinates it rolled, so mushrooms stop growing out of rock faces and cliff walls.
  const decoTest = (x,z)=> slopeAt(x,z) < PARAMS.decoSlope
    && !inExclusion(x,z,1,'fungalWarren') && clearOf(x,z,PARAMS.decoClear);
  for(const pt of scatter(rng, PARAMS.decoCount, PARAMS.decoMinDist, decoTest,
      { r0:PARAMS.decoRMin, r1:PARAMS.decoRMin+PARAMS.decoRVar })){
    const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
    placeMushroom(pt.x, pt.z, sp);
  }
  // Fungal Warren pocket: one species dominates a concentrated patch — an emergent "go
  // here for this contract" spot, on top of the baseline global scatter above.
  if(POCKETS.fungalWarren){
    const fw = POCKETS.fungalWarren;
    const dom = SPECIES_BY_ID[fw.species];
    const extra = PARAMS.warrenMin + ((rng()*PARAMS.warrenVar)|0);
    // decoTest skips the warren's own tag: its props belong inside it, everyone else's zones still apply
    for(const pt of scatter(rng, extra, PARAMS.decoMinDist*0.6, decoTest, { x:fw.x, z:fw.z, r0:0, r1:fw.r })){
      const sp = rng() < PARAMS.warrenDom ? dom : MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
      placeMushroom(pt.x, pt.z, sp);
    }
    // ambient signature: drifting spores tinted to the dominant species — crystal hollow has its
    // orbiting motes, fen hollow its rising wisps; this is the warren's own, so every pocket
    // reads as a distinct place rather than three of the four being "just decoration".
    const wsCount = PARAMS.warrenSpores;
    const wsGeo = new THREE.BufferGeometry();
    const wsPos = new Float32Array(wsCount*3), wsSeed = new Float32Array(wsCount);
    for(let i=0;i<wsCount;i++){
      const a = rng()*Math.PI*2, r = Math.sqrt(rng())*fw.r*0.85;
      wsPos[i*3] = fw.x+Math.cos(a)*r; wsPos[i*3+1] = groundHeight(fw.x+Math.cos(a)*r, fw.z+Math.sin(a)*r);
      wsPos[i*3+2] = fw.z+Math.sin(a)*r;
      wsSeed[i] = rng()*100;
    }
    wsGeo.setAttribute('position', new THREE.BufferAttribute(wsPos,3));
    wsGeo.setAttribute('aSeed', new THREE.BufferAttribute(wsSeed,1));
    const domCol = new THREE.Color(dom.color);
    const warrenSporeMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0}, uColor:{value:domCol} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          p.x += sin(uTime*0.4+aSeed*2.0)*1.4; p.z += cos(uTime*0.35+aSeed*1.6)*1.4;
          p.y += 1.0+sin(uTime*0.6+aSeed*3.0)*1.0;
          vA = 0.35+0.35*sin(uTime*1.5+aSeed*4.0);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 34.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`uniform vec3 uColor; varying float vA;
        void main(){ float r=length(gl_PointCoord-0.5);
          float a=smoothstep(0.5,0.05,r)*vA; gl_FragColor=vec4(uColor,a); if(a<0.02) discard; }`
    });
    const warrenSpores = new THREE.Points(wsGeo, warrenSporeMat);
    warrenSpores.frustumCulled = false;
    addTo(scene, warrenSpores);
    world.updaters.push((dt,t)=>{ warrenSporeMat.uniforms.uTime.value = t; });
  }
  world.updaters.push((dt,t)=>{
    for(const d of deco){
      if(d.alive) writeDeco(d, 1 + Math.sin(t*2+d.ph)*0.06);
      else if((d.respawnT -= dt) <= 0){ d.alive = true; d.g.visible = true; }
    }
  });

  /* ----- LANDMARK: cave mouths — dark alcoves in the rock walls built earlier ----- */
  if(world.caveSpots && world.caveSpots.length){
    const voidMat = new THREE.MeshBasicMaterial({ color:0x0a0810, side:THREE.BackSide, fog:false });
    // the chamber's roof — same unlit BackSide trick as the mouth's void, just big enough to
    // enclose the whole walled room, so nothing outside (sky dome, sun-lit haze) reads through
    const domeMat = new THREE.MeshBasicMaterial({ color:0x0c0a14, side:THREE.BackSide, fog:false });
    for(let i=0;i<world.caveSpots.length;i++){
      const spot = world.caveSpots[i];
      const { cx, cz, cy, mouthDir } = spot;
      const mouthX = Math.cos(mouthDir), mouthZ = Math.sin(mouthDir);
      // dark cavity, recessed behind the entrance so it never coincides with the wall rocks' surfaces
      const cavity = new THREE.Mesh(new THREE.SphereGeometry(3.4, 12, 8), voidMat);
      cavity.scale.set(1, 0.7, 0.85);
      cavity.position.set(cx - mouthX*1.6, cy+1.7, cz - mouthZ*1.6);
      addTo(scene, cavity);
      // hanging stalactites over the mouth
      for(let k=0;k<PARAMS.caveSpikes;k++){
        const along = (k-1.5)*0.7;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.25+rng()*0.15, 0.9+rng()*0.6, 6), rockMat);
        spike.rotation.x = Math.PI;
        spike.position.set(cx - mouthX*0.8 + mouthZ*along, cy+3.2+rng()*0.4, cz - mouthZ*0.8 - mouthX*along);
        addTo(scene, spike);
      }
      // warm light spilling from inside, out through the mouth
      const pl = new THREE.PointLight(0xffa855, 7, 13);
      pl.position.set(cx - mouthX*1.1, cy+1.6, cz - mouthZ*1.1);
      addTo(scene, pl);
      // beacon shaft: a point light only reaches ~13 m, nowhere near enough to spot a cave mouth
      // from across the valley. Reuses the grove god-ray technique (a fog:false additive plane)
      // tinted to the mouth's own warm colour, tall enough to read as a landmark from far off the
      // same way a crystal cluster or a landmark tower already does.
      const beaconMat = new THREE.MeshBasicMaterial({ map:makeRayTexture(), color:0xffa855,
        transparent:true, opacity:0.5, blending:THREE.AdditiveBlending, depthWrite:false,
        side:THREE.DoubleSide, fog:false });
      const beaconX = cx - mouthX*1.1, beaconZ = cz - mouthZ*1.1;
      for(let k=0;k<2;k++){
        const beam = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 46), beaconMat);
        beam.position.set(beaconX, cy+23, beaconZ);
        beam.rotation.y = k*Math.PI/2;      // two crossed planes read from every approach angle
        addTo(scene, beam);
      }
      const beaconPh = rng()*7;
      world.updaters.push((dt,t)=>{ beaconMat.opacity = 0.36 + Math.sin(t*0.8+beaconPh)*0.14; });
      // a few glowing mushrooms just inside for atmosphere — pushed into the same instance
      // arrays as every other mushroom, so zero extra draw calls. These are the one authored
      // exception to the clearance test: they are *meant* to sit inside the cave keep-out.
      for(let k=0;k<PARAMS.caveShrooms;k++){
        const a = mouthDir + Math.PI + (rng()-0.5)*1.8, r = 0.8+rng()*1.8;
        const gx = cx+Math.cos(a)*r, gz = cz+Math.sin(a)*r;
        const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
        placeMushroom(gx, gz, sp, 0.5, 1.0);
      }

      /* ----- the chamber this mouth actually leads to (main.js teleports the player here) ----- */
      const chamber = world.caveChambers[i];
      const floor = new THREE.Mesh(new THREE.CircleGeometry(chamber.r, 40), rockMat);
      floor.rotation.x = -Math.PI/2;
      floor.position.set(chamber.x, chamber.floorY, chamber.z);
      floor.receiveShadow = true;
      addTo(scene, floor);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(chamber.r+18, 16, 10), domeMat);
      dome.scale.set(1, 0.6, 1);
      dome.position.set(chamber.x, chamber.floorY+8, chamber.z);
      addTo(scene, dome);
      // stalactites hanging through the room, same silhouette as the mouth's
      for(let k=0;k<9;k++){
        const a = rng()*Math.PI*2, r = rng()*chamber.r*0.85;
        const spike = new THREE.Mesh(new THREE.ConeGeometry(0.3+rng()*0.2, 1.1+rng()*0.9, 6), rockMat);
        spike.rotation.x = Math.PI;
        spike.position.set(chamber.x+Math.cos(a)*r, chamber.floorY+9.5+rng()*2.5, chamber.z+Math.sin(a)*r);
        addTo(scene, spike);
      }
      // even warm fill around the room — static landmark lights, never spawned/despawned in bursts
      for(let k=0;k<3;k++){
        const a = (k/3)*Math.PI*2 + rng();
        const pl2 = new THREE.PointLight(0xffb877, 6, chamber.r*1.1);
        pl2.position.set(chamber.x+Math.cos(a)*chamber.r*0.4, chamber.floorY+3.5, chamber.z+Math.sin(a)*chamber.r*0.4);
        addTo(scene, pl2);
      }
      // exit alcove — a cool blue light distinct from the warm cave glow, so "the way back" reads
      // at a glance once the fight is over. main.js checks proximity to exitTrigger to warp out.
      // 0.6r, same radius as the arrival point on the opposite side: the wall ring sits at
      // caveChamberWallR (25) with rocks up to 3.68 in collider radius, so anything past ~0.68r
      // risks landing inside a wall rock's own column — same failure moveHoriz's escape valve
      // hits for any spawn-inside-a-collider case (see the arrival/loot/crystal keep-out above).
      const exitLocal = { x: chamber.x, z: chamber.z - chamber.r*0.6 };
      chamber.exitTrigger = exitLocal;
      const exitLight = new THREE.PointLight(0x8fd6ff, 9, 11);
      exitLight.position.set(exitLocal.x, chamber.floorY+1.9, exitLocal.z);
      addTo(scene, exitLight);
      for(let k=0;k<3;k++){
        const a = rng()*Math.PI*2, r = 0.9+rng()*1.6;
        const gx = exitLocal.x+Math.cos(a)*r, gz = exitLocal.z+Math.sin(a)*r;
        const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
        placeMushroom(gx, gz, sp, 0.5, 1.0);
      }
      // ambient decorative mushrooms scattered through the rest of the room
      for(let k=0;k<PARAMS.caveChamberShrooms;k++){
        const a = rng()*Math.PI*2, r = rng()*chamber.r*0.7;
        const gx = chamber.x+Math.cos(a)*r, gz = chamber.z+Math.sin(a)*r;
        if(Math.hypot(gx-exitLocal.x, gz-exitLocal.z) < 3) continue; // keep the exit readable
        const sp = MUSHROOM_SPECIES[(rng()*MUSHROOM_SPECIES.length)|0];
        placeMushroom(gx, gz, sp, 0.5, 1.2);
      }
      // where main.js lands the player on entry, and where it drops the clear reward
      chamber.arrival = { x: chamber.x, z: chamber.z + chamber.r*0.6 };
      chamber.lootSpot = { x: chamber.x, z: chamber.z + chamber.r*0.15 };
    }
  }

  /* ----- LANDMARK: withered hollow — a patch of visibly corrupted growth that isn't tied
     to distance-from-spawn, so early exploration can still stumble into somewhere unsettling ----- */
  if(POCKETS.witheredHollow){
    const wh = POCKETS.witheredHollow;
    const witherMat = toonMat({ color:0x2a1a30, emissive:0x140a1c, emissiveIntensity:0.5, rim:0.3, rimColor:0x8a5ac8 });
    const spikeCount = PARAMS.witherSpikeMin + ((rng()*PARAMS.witherSpikeVar)|0);
    // item 09: spikes are tall enough to be walls, so the same predicate that keeps them off
    // cliffs keeps them out of each other. The wither pocket is their own zone, hence the tag.
    const spikeTest = (x,z)=> slopeAt(x,z) < PARAMS.siteSlope
      && !inExclusion(x,z,1,'witheredHollow') && clearOf(x,z,1.2);
    for(const pt of scatter(rng, spikeCount, 1.6, spikeTest, { x:wh.x, z:wh.z, r0:0, r1:wh.r*0.7 })){
      const sx = pt.x, sz = pt.z, sy = groundHeight(sx,sz);
      const h = PARAMS.witherHMin+rng()*PARAMS.witherHVar;
      const sr = 0.3+rng()*0.35;
      const spike = new THREE.Mesh(new THREE.ConeGeometry(sr, h, 6), witherMat);
      spike.position.set(sx, sy+h*0.5, sz);
      spike.rotation.set((rng()-0.5)*0.3, rng()*7, (rng()-0.5)*0.3);
      spike.castShadow = true;
      COLLIDERS.push({ x:sx, z:sz, r:sr*1.3, bot:sy, top:sy+h });
      addOutline(spike, 0.03);
      addTo(scene, spike);
    }
    const whY = groundHeight(wh.x, wh.z);
    const pl4 = new THREE.PointLight(0x8a5ac8, 6, 16);
    pl4.position.set(wh.x, whY+3, wh.z);
    addTo(scene, pl4);
    // ambient signature: falling ash, not rising — the one pocket whose motes sink instead of
    // drift up, so it reads as a distinct kind of wrong rather than the fen's bog or the warren's
    // spores with a different tint.
    const amCount = PARAMS.witherMotes;
    const amGeo = new THREE.BufferGeometry();
    const amPos = new Float32Array(amCount*3), amSeed = new Float32Array(amCount);
    for(let i=0;i<amCount;i++){
      const a = rng()*Math.PI*2, r = Math.sqrt(rng())*wh.r*0.85;
      amPos[i*3] = wh.x+Math.cos(a)*r; amPos[i*3+1] = groundHeight(wh.x+Math.cos(a)*r, wh.z+Math.sin(a)*r)+4+rng()*3;
      amPos[i*3+2] = wh.z+Math.sin(a)*r;
      amSeed[i] = rng()*100;
    }
    amGeo.setAttribute('position', new THREE.BufferAttribute(amPos,3));
    amGeo.setAttribute('aSeed', new THREE.BufferAttribute(amSeed,1));
    const witherAshMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          float fall = mod(uTime*0.5+aSeed, 5.0);
          p.y -= fall;
          p.x += sin(uTime*0.3+aSeed*2.2)*0.6; p.z += cos(uTime*0.28+aSeed*1.9)*0.6;
          vA = smoothstep(0.0,0.4,fall)*smoothstep(5.0,4.0,fall);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 24.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`varying float vA;
        void main(){ float r=length(gl_PointCoord-0.5);
          float a=smoothstep(0.5,0.05,r)*vA*0.7; gl_FragColor=vec4(0.54,0.35,0.78,a); if(a<0.02) discard; }`
    });
    const witherAsh = new THREE.Points(amGeo, witherAshMat);
    witherAsh.frustumCulled = false;
    addTo(scene, witherAsh);
    world.updaters.push((dt,t)=>{ witherAshMat.uniforms.uTime.value = t; });
  }

  /* ----- LANDMARK: fen hollow — a boggy patch with its own props (reeds, lily pads), the
     game's fourth pocket and the only one that touches player speed. Reeds are passable —
     unlike the withered hollow's spikes they are NOT pushed into COLLIDERS, the same way
     ordinary grass is walked through, not around. */
  if(POCKETS.fenHollow){
    const fh = POCKETS.fenHollow;
    const reedMat = toonMat({ color:0x4a6a3a, emissive:0x1a2a12, emissiveIntensity:0.25, rim:0.4, rimColor:0xb8d888 });
    const padMat = toonMat({ color:0x2f5a3a, emissive:0x0f200f, emissiveIntensity:0.3, rim:0.35, rimColor:0x9fe0a0 });
    // reeds and lily pads used to be one THREE.Mesh per blade/pad — up to a hundred extra draw
    // calls for one pocket. Same instancing rule as every other batch of repeated geometry
    // (item: perf discipline): one unit cone / unit disc, per-instance transform in the matrix.
    const reedGeo = new THREE.ConeGeometry(1, 1, 5);
    const reedPlacements = [];
    const reedCount = PARAMS.fenReedMin + ((rng()*PARAMS.fenReedVar)|0);
    const reedTest = (x,z)=> slopeAt(x,z) < PARAMS.siteSlope && clearOf(x,z,0.4);
    for(const pt of scatter(rng, reedCount, 0.5, reedTest, { x:fh.x, z:fh.z, r0:0, r1:fh.r })){
      const rx = pt.x, rz = pt.z, ry = groundHeight(rx,rz);
      const h = PARAMS.fenReedHMin + rng()*PARAMS.fenReedHVar;
      // a loose cluster of 2-3 thin blades per spot reads as a reed clump, not one lone cone
      const blades = 2 + ((rng()*2)|0);
      for(let b=0; b<blades; b++){
        const bx = rx + (rng()-0.5)*0.35, bz = rz + (rng()-0.5)*0.35;
        reedPlacements.push({ x:bx, y:ry+h*0.5, z:bz, r:0.035, h,
          rx:(rng()-0.5)*0.15, ry2:rng()*7, rz:(rng()-0.5)*0.15 });
      }
    }
    if(reedPlacements.length){
      // thin as these are, they still clear STEP once a clump's jitter stacks blades near the
      // edge of a footstep — walked over like grass, per the shadow policy's "ground cover never
      // casts" rule, so no collider and no castShadow, same treatment as flowers and moss.
      const reeds = new THREE.InstancedMesh(reedGeo, reedMat, reedPlacements.length);
      reedPlacements.forEach((rp,i)=>{
        Q.setFromEuler(EU.set(rp.rx, rp.ry2, rp.rz));
        M.compose(V.set(rp.x, rp.y, rp.z), Q, S.set(rp.r, rp.h, rp.r));
        reeds.setMatrixAt(i, M);
      });
      addTo(scene, reeds);
    }
    // lily pads: flat discs, denser toward the pocket's own center — the "open water" read
    const padGeo = new THREE.CircleGeometry(1, 9);
    padGeo.rotateX(-Math.PI/2);
    const padPlacements = [];
    const padCount = PARAMS.fenPadMin + ((rng()*PARAMS.fenPadVar)|0);
    const padTest = (x,z)=> slopeAt(x,z) < PARAMS.siteSlope && clearOf(x,z,0.5);
    for(const pt of scatter(rng, padCount, 0.9, padTest, { x:fh.x, z:fh.z, r0:0, r1:fh.r*0.55 })){
      const py = groundHeight(pt.x, pt.z);
      padPlacements.push({ x:pt.x, y:py+0.03, z:pt.z, r:0.35+rng()*0.3, ry:(rng()-0.5)*0.06 });
    }
    if(padPlacements.length){
      const pads = new THREE.InstancedMesh(padGeo, padMat, padPlacements.length);
      pads.receiveShadow = true;
      padPlacements.forEach((pp,i)=>{
        Q.setFromEuler(EU.set(0, 0, pp.ry));
        M.compose(V.set(pp.x, pp.y, pp.z), Q, S.set(pp.r, 1, pp.r));
        pads.setMatrixAt(i, M);
      });
      addTo(scene, pads);
    }
    const fhY = groundHeight(fh.x, fh.z);
    const pl5 = new THREE.PointLight(0x6ab88a, 4.5, 15);
    pl5.position.set(fh.x, fhY+2.5, fh.z);
    addTo(scene, pl5);

    /* ----- marsh wisps: rising bog-gas motes, the fen's own signature the way the crystal
       clusters' orbiting spores are Crystal Hollow's — same GPU point-sprite technique as the
       fireflies above (one draw call, per-vertex shader animation), tuned into a slow bubble
       that rises out of the bog and pops rather than a firefly's drift, and confined to the
       pocket's own radius so it reads as THIS place's weather, not ambient dressing repeated
       from a different pocket. */
    const wCount = PARAMS.fenWisps;
    const wGeo = new THREE.BufferGeometry();
    const wPos = new Float32Array(wCount*3), wSeed = new Float32Array(wCount);
    for(let i=0;i<wCount;i++){
      const a = rng()*Math.PI*2, r = Math.sqrt(rng())*fh.r*0.85; // sqrt(rng) = uniform over the disc, not clumped at the center
      wPos[i*3] = fh.x+Math.cos(a)*r; wPos[i*3+1] = groundHeight(fh.x+Math.cos(a)*r, fh.z+Math.sin(a)*r);
      wPos[i*3+2] = fh.z+Math.sin(a)*r;
      wSeed[i] = rng()*100;
    }
    wGeo.setAttribute('position', new THREE.BufferAttribute(wPos,3));
    wGeo.setAttribute('aSeed', new THREE.BufferAttribute(wSeed,1));
    const wMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          // each mote loops its own 7-11s rise independently (aSeed staggers phase AND period),
          // so the bog reads as continuously bubbling rather than one synchronised pulse
          float period = 7.0+mod(aSeed,4.0);
          float cyc = mod(uTime+aSeed*3.7, period)/period;
          vec3 p = position;
          p.y += cyc*3.2;
          p.x += sin(uTime*0.35+aSeed*2.1)*0.35; p.z += cos(uTime*0.3+aSeed*1.6)*0.35;
          vA = smoothstep(0.0,0.12,cyc)*smoothstep(1.0,0.72,cyc);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 46.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`varying float vA;
        void main(){ float r=length(gl_PointCoord-0.5);
          float a=smoothstep(0.5,0.05,r)*vA*0.8;
          gl_FragColor=vec4(0.56,0.92,0.68,a); if(a<0.02) discard; }`
    });
    const wisps = new THREE.Points(wGeo, wMat);
    wisps.frustumCulled = false;
    addTo(scene, wisps);
    world.updaters.push((dt,t)=>{ wMat.uniforms.uTime.value = t; });
  }

  /* ----- LANDMARK: scorched hollow — ash and embers, the fifth pocket. Atmosphere only, like
     crystal/withered: no gameplay hook, just a place that reads as burned. ----- */
  if(POCKETS.scorchedHollow){
    const sch = POCKETS.scorchedHollow;
    const ashMat = toonMat({ color:0x2a2622, emissive:0x1a0f08, emissiveIntensity:0.3, rim:0.3, rimColor:0xff8a3a });
    const scorchRockCount = PARAMS.scorchRockMin + ((rng()*PARAMS.scorchRockVar)|0);
    const scorchTest = (x,z)=> slopeAt(x,z) < PARAMS.siteSlope
      && !inExclusion(x,z,1,'scorchedHollow') && clearOf(x,z,1.0);
    for(const pt of scatter(rng, scorchRockCount, 2.0, scorchTest, { x:sch.x, z:sch.z, r0:0, r1:sch.r*0.8 })){
      const bx=pt.x, bz=pt.z, by=groundHeight(bx,bz);
      const s = 0.5+rng()*0.9;
      const chunk = new THREE.Mesh(rockGeo, ashMat);
      chunk.scale.set(s, s*(0.6+rng()*0.5), s);
      chunk.position.set(bx, by+chunk.scale.y*0.3, bz);
      chunk.rotation.set(rng()*7, rng()*7, rng()*7);
      chunk.castShadow = true;
      addOutline(chunk, 0.03);
      addTo(scene, chunk);
      if(chunk.scale.y > STEP*0.7) COLLIDERS.push({ x:bx, z:bz, r:s*0.8, bot:by, top:by+chunk.scale.y*0.7 });
    }
    // rising embers — same GPU point-sprite technique as the fen's bog wisps, tuned into a
    // faster, more chaotic rise so the two pockets don't read as reskins of one effect
    const eCount = PARAMS.scorchEmbers;
    const eGeo = new THREE.BufferGeometry();
    const ePos = new Float32Array(eCount*3), eSeed = new Float32Array(eCount);
    for(let i=0;i<eCount;i++){
      const a = rng()*Math.PI*2, r = Math.sqrt(rng())*sch.r*0.85;
      ePos[i*3] = sch.x+Math.cos(a)*r; ePos[i*3+1] = groundHeight(sch.x+Math.cos(a)*r, sch.z+Math.sin(a)*r);
      ePos[i*3+2] = sch.z+Math.sin(a)*r;
      eSeed[i] = rng()*100;
    }
    eGeo.setAttribute('position', new THREE.BufferAttribute(ePos,3));
    eGeo.setAttribute('aSeed', new THREE.BufferAttribute(eSeed,1));
    const emberMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending, fog:false,
      uniforms:{ uTime:{value:0} },
      vertexShader:`uniform float uTime; attribute float aSeed; varying float vA;
        void main(){
          vec3 p = position;
          float period = 2.5+mod(aSeed,2.0);
          float cyc = mod(uTime+aSeed*4.1, period)/period;
          p.y += cyc*4.5;
          p.x += sin(uTime*1.1+aSeed*3.0)*0.5; p.z += cos(uTime*0.9+aSeed*2.4)*0.5;
          vA = smoothstep(0.0,0.1,cyc)*smoothstep(1.0,0.6,cyc);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          gl_PointSize = 22.0/-mv.z; gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`varying float vA;
        void main(){ float r=length(gl_PointCoord-0.5);
          float a=smoothstep(0.5,0.05,r)*vA; gl_FragColor=vec4(1.0,0.55,0.2,a); if(a<0.02) discard; }`
    });
    const embers = new THREE.Points(eGeo, emberMat);
    embers.frustumCulled = false;
    addTo(scene, embers);
    const schY = groundHeight(sch.x, sch.z);
    const plScorch = new THREE.PointLight(0xff7a3a, 5, 14);
    plScorch.position.set(sch.x, schY+2, sch.z);
    addTo(scene, plScorch);
    world.updaters.push((dt,t)=>{ emberMat.uniforms.uTime.value = t; });
  }

  // exposed for main.js: proximity checks read world.harvestables directly,
  // harvesting goes through world.harvestMushroom so respawn timing stays owned by world.js
  world.harvestables = deco;
  world.harvestMushroom = (entry)=>{
    if(!entry || !entry.alive) return false;
    entry.alive = false;
    entry.g.visible = false;
    entry.respawnT = PARAMS.respawnMin + Math.random()*PARAMS.respawnVar;
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
      const j = 1 + F.detail(x*2.6+seed, z*2.6-seed)*0.22;
      p.setXYZ(i, x*j, y*(2.3+F.detail(y*1.5+seed, x*1.5)*0.5), z*j);
    }
    geo.computeVertexNormals();
    return geo;
  }
  /* Crystals are the world's ACCENT made solid: separateHue() guaranteed the accent stays at
     least 0.11 of the hue circle from the foliage AND the soil, and pickL put it 1.9:1 above the
     ground luminance, so a cluster is a landmark you can navigate by at 60 m in every world.
     The two variants are the accent and its +0.17 hue sibling, so a hollow reads as one mineral.
     accentIntensity is 0.85 and MUST NOT be raised: we render ACES filmic at exposure 1.28, and
     an additive/emissive term reaching 1.0 clips to flat white — the crystal stops being a
     colour and becomes a blob. That bug has been fixed here twice already. */
  const accRGB = new THREE.Color(theme.accent), accRGB2 = new THREE.Color(theme.flowers[2]);
  const crystalPalette = [
    { color:theme.accent,     emissive:theme.accentEmissive, rgb:[accRGB.r, accRGB.g, accRGB.b] },
    { color:theme.flowers[2], emissive:theme.accentDark,     rgb:[accRGB2.r, accRGB2.g, accRGB2.b] },
  ];
  const crystalMats = crystalPalette.map(pal=>
    toonMat({ color:pal.color, emissive:pal.emissive, emissiveIntensity:theme.accentIntensity, rim:0.65, rimColor:pal.color }));
  const shardGeoVariants = [makeCrystalShardGeo(1.3), makeCrystalShardGeo(9.7)];
  const crystalClusters = []; // {cx,cy,cz,pal,ph} — drives the core sprites + mote system below
  const shardPlacements = [[],[],[],[]]; // bucketed by variant*2 + colorIdx
  // one collider per cluster, not per shard: a cluster reads as a single obstacle, and five
  // overlapping cylinders would only cost surfaceAt frames. Pushed from the loop that decides
  // each shard's transform, tracking the tallest shard, so it can't drift from the visuals.
  //
  // NOTE: crystals used to also scatter ambiently across almost the whole map (crystalCount:8,
  // r0-r1 spanning most of the playable radius) on top of this. Removed on purpose — a crystal
  // seam is meant to be what Crystal Hollow IS, not background dressing that shows up everywhere
  // whether or not a world even rolled that pocket. Now the only crystals in the world are the
  // pocket below and the cave-chamber seam further down, both deliberate, not incidental.
  // Crystal Hollow pocket: extra clusters concentrated in one region instead of scattered
  // uniformly, so a lucky world has a real "crystal cave" set-piece to remember. reuses the
  // exact same crystalClusters/shardPlacements arrays, so cores/motes/draw-calls below pick
  // these up automatically — zero additional draw calls no matter how many worlds get one.
  if(POCKETS.crystalHollow){
    const ch = POCKETS.crystalHollow;
    const extraClusters = PARAMS.hollowMin + ((rng()*PARAMS.hollowVar)|0);
    const hollowTest = (x,z)=> slopeAt(x,z) < PARAMS.siteSlope
      && !inExclusion(x,z,1,'crystalHollow') && clearOf(x,z,1.6);
    for(const site of scatter(rng, extraClusters, 4, hollowTest, { x:ch.x, z:ch.z, r0:0, r1:ch.r })){
      const cx=site.x, cz=site.z, cy=groundHeight(cx,cz);
      const colorIdx = (rng()*2)|0;
      crystalClusters.push({ cx, cy: cy+0.5, cz, pal:crystalPalette[colorIdx], ph: rng()*7 });
      const shardCount = PARAMS.hollowShardMin + ((rng()*PARAMS.hollowShardVar)|0); // slightly denser than ambient clusters
      let top = cy;
      for(let k=0;k<shardCount;k++){
        const variant = (rng()*2)|0;
        const s = PARAMS.hollowSMin + rng()*PARAMS.hollowSVar;
        const sh = { x:cx+(rng()-0.5)*0.5, y:cy+s*(0.9+rng()*0.3), z:cz+(rng()-0.5)*0.5,
          sx:s, sy:s*(0.8+rng()*0.7), sz:s, rx:(rng()-0.5)*0.6, ry:rng()*7, rz:(rng()-0.5)*0.6 };
        shardPlacements[variant*2+colorIdx].push(sh);
        top = Math.max(top, sh.y + sh.sy*1.15);
      }
      if(top - cy > STEP) COLLIDERS.push({ x:cx, z:cz, r:1.0, bot:cy, top });
    }
  }
  // cave chambers: a seam of the same crystal formations, so the underground room reads as the
  // same world's geology rather than a bolted-on arena. skipTag lets the scatter place inside the
  // chamber's own exclusion (it exists to keep OTHER systems out, not this one).
  if(world.caveChambers){
    for(const chamber of world.caveChambers){
      // keep the arrival spot, the exit alcove and the loot pedestal clear of shard colliders —
      // a shard placed where the player lands would leave them spawned INSIDE a collider, and
      // moveHoriz()'s escape valve for that case (item 01) waives collision entirely until they
      // step clear of it, which knockback could then carry straight through the chamber wall.
      const keepClear = (x,z)=> Math.hypot(x-chamber.arrival.x, z-chamber.arrival.z) > 4
        && Math.hypot(x-chamber.exitTrigger.x, z-chamber.exitTrigger.z) > 4
        && Math.hypot(x-chamber.lootSpot.x, z-chamber.lootSpot.z) > 4;
      const chTest = (x,z)=> !inExclusion(x,z,1,'caveChamber') && clearOf(x,z,1.6) && keepClear(x,z);
      for(const site of scatter(rng, PARAMS.caveChamberCrystals, 4, chTest,
        { x:chamber.x, z:chamber.z, r0:0, r1:chamber.r*0.65 })){
        const cx=site.x, cz=site.z, cy=groundHeight(cx,cz);
        const colorIdx = (rng()*2)|0;
        crystalClusters.push({ cx, cy: cy+0.5, cz, pal:crystalPalette[colorIdx], ph: rng()*7 });
        const shardCount = PARAMS.hollowShardMin + ((rng()*PARAMS.hollowShardVar)|0);
        let top = cy;
        for(let k=0;k<shardCount;k++){
          const variant = (rng()*2)|0;
          const s = PARAMS.hollowSMin + rng()*PARAMS.hollowSVar;
          const sh = { x:cx+(rng()-0.5)*0.5, y:cy+s*(0.9+rng()*0.3), z:cz+(rng()-0.5)*0.5,
            sx:s, sy:s*(0.8+rng()*0.7), sz:s, rx:(rng()-0.5)*0.6, ry:rng()*7, rz:(rng()-0.5)*0.6 };
          shardPlacements[variant*2+colorIdx].push(sh);
          top = Math.max(top, sh.y + sh.sy*1.15);
        }
        if(top - cy > STEP) COLLIDERS.push({ x:cx, z:cz, r:1.0, bot:cy, top });
      }
    }
  }
  for(let variant=0; variant<2; variant++){
    for(let colorIdx=0; colorIdx<2; colorIdx++){
      const placements = shardPlacements[variant*2+colorIdx];
      if(!placements.length) continue;
      const mesh = new THREE.InstancedMesh(shardGeoVariants[variant], crystalMats[colorIdx], placements.length);
      mesh.castShadow = true;
      placements.forEach((p,i)=>{
        Q.setFromEuler(EU.set(p.rx,p.ry,p.rz));
        M.compose(V.set(p.x,p.y,p.z), Q, S.set(p.sx,p.sy,p.sz));
        mesh.setMatrixAt(i, M);
      });
      addTo(scene, mesh);
    }
  }
  // inner glow cores — one lightweight sprite per cluster (sprites are cheap: always-billboarded, no outline)
  const clusterCores = crystalClusters.map(c=>{
    const core = new THREE.Sprite(new THREE.SpriteMaterial({ color:c.pal.color, transparent:true, opacity:0.5,
      blending:THREE.AdditiveBlending, depthWrite:false }));
    core.scale.setScalar(0.9); core.position.set(c.cx, c.cy-0.1, c.cz);
    addTo(scene, core);
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
  addTo(scene, crystalMotes);
  world.updaters.push((dt,t)=>{ moteMat.uniforms.uTime.value = t; });

  /* ----- god-ray shafts in groves ----- */
  const rayTex = makeRayTexture();
  const rayMat = new THREE.MeshBasicMaterial({ map:rayTex, transparent:true, opacity:0.35,
    blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false });
  for(let i=0;i<PARAMS.rayCount;i++){
    const [tx,ty,tz] = treePos[(rng()*treePos.length)|0] || [30,0,30];
    const geo = new THREE.PlaneGeometry(6, 30);
    const ray = new THREE.Mesh(geo, rayMat);
    ray.position.set(tx+3, ty+14, tz+2);
    ray.rotation.z = 0.35; ray.rotation.y = rng()*3;
    addTo(scene, ray);
  }

  /* ----- fireflies / ambient spores ----- */
  const fCount = PARAMS.fireflies;
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
  addTo(scene, fireflies);
  world.updaters.push((dt,t)=>{ fMat.uniforms.uTime.value = t; });

  /* ----- ground pollen (dense, slow, low-altitude drift distinct from the fireflies) ----- */
  {
    const pCount = PARAMS.pollen;
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
    addTo(scene, pollen);
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
    const petCount = PARAMS.petals;
    const petals = [];
    for(let i=0;i<petCount;i++){
      const mat = petMats[i%petMats.length];
      const m = new THREE.Mesh(petGeo, mat);
      const a=rng()*Math.PI*2, r=rng()*130;
      m.userData = { x:Math.cos(a)*r, z:Math.sin(a)*r, y0:4+rng()*10, ph:rng()*7, spd:0.3+rng()*0.3, spin:(rng()-0.5)*2 };
      addTo(scene, m); petals.push(m);
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

  // shrines: one-time run buffs the player finds rather than fights for (main.js owns the touch-
  // trigger and the buff grant — this half only decides WHERE they are). Pushed to by the summit
  // landmark below (a guaranteed one at the peak) and by the scattered pass further down.
  const shrines = [];

  /* ----- LANDMARK: ancient mother-mushroom tower (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('tower')){
    const lm = new THREE.Group();
    // seeded: always a far, visible landmark (130–175 from spawn)
    const lSite = spot(rng, PARAMS.towerDMin, PARAMS.towerDMin + PARAMS.towerDVar, 6);
    const lx = lSite.x, lz = lSite.z, ly = groundHeight(lx, lz);
    const stemMat2 = toonMat({ color:0xe8d8b8, map:paintTexture('#e8d8b8',[{c:'#c9b58f',n:14,r:8,a:0.4}],{dabs:300}), rim:0.4 });
    const capMat2 = toonMat({ color:0x3fa8cc, map:paintTexture('#3fa8cc',[{c:'#bfefff',n:16,r:12,a:0.9},{c:'#bfefff',n:8,r:6,a:0.8}],{dabs:260}),
      emissive:0x1a5a77, emissiveIntensity:0.7, rim:0.7, rimColor:0xbfefff });
    const stem2 = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 8, 42, 10), stemMat2);
    { const p = stem2.geometry.attributes.position;
      for(let i=0;i<p.count;i++){ const y=p.getY(i); p.setX(i, p.getX(i)+Math.sin(y*0.08)*4); } }
    stem2.position.y = 21; stem2.castShadow = true; addOutline(stem2, 0.02);
    const cap2 = new THREE.Mesh(new THREE.SphereGeometry(17, 18, 12, 0, Math.PI*2, 0, Math.PI*0.52), capMat2);
    cap2.position.y = 42; cap2.scale.set(1.25, 0.85, 1.25); cap2.castShadow = true; addOutline(cap2, 0.015);
    const halo2 = new THREE.Mesh(new THREE.SphereGeometry(24, 16, 12),
      new THREE.MeshBasicMaterial({ color:0x66d8ff, transparent:true, opacity:0.12, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.BackSide }));
    halo2.position.y = 44;
    const pl = new THREE.PointLight(0x66d8ff, 60, 90); pl.position.y = 40;
    lm.add(stem2, cap2, halo2, pl);
    lm.position.set(lx, ly, lz);
    addTo(scene, lm);
    world.motherShroom = lm;
    // the stem is the wall; the 17m cap deliberately isn't, so you can walk in under it.
    // r sits between the stem's base (8) and top (4.5) radius — the trunk tapers, the collider
    // doesn't, and splitting one landmark into a stack of cylinders isn't worth the frames.
    COLLIDERS.push({ x:lx, z:lz, r:6.5, bot:ly, top:ly+42 });
    world.updaters.push((dt,t)=>{ halo2.material.opacity = 0.10+Math.sin(t*1.2)*0.04; });
  }

  /* ----- LANDMARK: standing stones (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('stones')){
    const sSite = spot(rng, PARAMS.stoneDMin, PARAMS.stoneDMin + PARAMS.stoneDVar, PARAMS.stoneRing + 3);
    const sx = sSite.x, sz = sSite.z, sy = groundHeight(sx, sz);
    const stoneMat = toonMat({ color:0x8d86a0, map:paintTexture('#8d86a0',[{c:'#6d6580',n:10,r:10,a:0.5}],{dabs:200}), rim:0.4 });
    const runeMat = new THREE.MeshBasicMaterial({ color:0x7de8ff, transparent:true, opacity:0.9, blending:THREE.AdditiveBlending, depthWrite:false });
    for(let i=0;i<PARAMS.stoneCount;i++){
      const a = (i/PARAMS.stoneCount)*Math.PI*2;
      const sh = PARAMS.stoneHMin+rng()*PARAMS.stoneHVar;
      const st = new THREE.Mesh(new THREE.BoxGeometry(2.2, sh, 1.4), stoneMat);
      st.position.set(sx+Math.cos(a)*PARAMS.stoneRing, sy+3, sz+Math.sin(a)*PARAMS.stoneRing);
      st.rotation.set((rng()-0.5)*0.15, a, (rng()-0.5)*0.15);
      // collider from the same loop as the stone: r covers the 2.2x1.4 slab at any yaw, so the
      // circle you walk into always matches the stone you can see.
      st.castShadow = true; st.receiveShadow = true;
      COLLIDERS.push({ x:st.position.x, z:st.position.z, r:1.25, bot:sy, top:sy+3+sh*0.5 });
      addOutline(st, 0.04);
      const rune = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 3), runeMat);
      rune.position.set(st.position.x*1.001, sy+3.5, st.position.z*1.001);
      rune.lookAt(sx, sy+3.5, sz); rune.rotateY(Math.PI);
      addTo(scene, st, rune);
    }
    const pl2 = new THREE.PointLight(0x7de8ff, 20, 30); pl2.position.set(sx, sy+4, sz);
    addTo(scene, pl2);
  }

  /* ----- LANDMARK: spore geysers (not every world gets one — see hasLandmark) ----- */
  if(hasLandmark('geysers')){
    world.geysers = [];
    // seeded: 4 geysers spread around the ring, kept out of the spawn clearing
    const gSpots = [];
    for(let i=0;i<PARAMS.geyserCount;i++){
      const a = i*(Math.PI/2) + rng()*1.1;
      const d = PARAMS.geyserDMin + rng()*PARAMS.geyserDVar;
      gSpots.push([Math.cos(a)*d, Math.sin(a)*d]);
    }
    for(const [gx, gz] of gSpots){
      const gy = groundHeight(gx, gz);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 2.6, 26, 8, 1, true),
        new THREE.MeshBasicMaterial({ color:0xaef2c8, transparent:true, opacity:0.10, blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false }));
      col.position.set(gx, gy+13, gz);
      addTo(scene, col);
      // rising spore points
      const N = 26;
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(N*3); const seed = new Float32Array(N);
      for(let i=0;i<N;i++){ seed[i]=rng(); pos[i*3]=gx; pos[i*3+1]=gy; pos[i*3+2]=gz; }
      geo.setAttribute('position', new THREE.BufferAttribute(pos,3));
      const mat = new THREE.PointsMaterial({ color:0xc8ffd8, size:1.6, transparent:true, opacity:0.8,
        blending:THREE.AdditiveBlending, depthWrite:false, sizeAttenuation:true });
      const pts = new THREE.Points(geo, mat); pts.frustumCulled = false;
      addTo(scene, pts);
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
    const wSite = spot(rng, PARAMS.pondDMin, PARAMS.pondDMin + PARAMS.pondDVar, PARAMS.exclPond);
    const wx = wSite.x, wz = wSite.z, wy = groundHeight(wx, wz);
    world.pondPos = { x:wx, y:wy, z:wz };
    // the water itself stays walkable; nothing else should grow in it
    EXCLUSIONS.push({ x:wx, z:wz, r:PARAMS.exclPond, tag:'pond' });
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
    addTo(scene, pond);
    // lily pads + reeds around the rim
    // pads and reeds are this world's undergrowth standing in water, not a second green family:
    // theme.undergrowth is the foliage hue pushed dark, theme.bush its lit relative.
    const padMat = toonMat({ color:theme.undergrowth, rim:0.4, rimColor:0xc8ffb0 });
    const padGeo = new THREE.CircleGeometry(0.6, 10);
    const reedMat = toonMat({ color:theme.bush, rim:0.3 });
    const reedGeo = new THREE.CylinderGeometry(0.05, 0.08, 1.4, 5);
    for(let i=0;i<PARAMS.pondPads;i++){
      const a = rng()*Math.PI*2, r = 3+rng()*5.5;
      const px = wx+Math.cos(a)*r, pz = wz+Math.sin(a)*r;
      if(rng() < 0.5){
        const pad = new THREE.Mesh(padGeo, padMat);
        pad.rotation.x = -Math.PI/2; pad.rotation.z = rng()*7;
        pad.position.set(px, wy+0.16, pz);
        addTo(scene, pad);
      } else {
        const reed = new THREE.Mesh(reedGeo, reedMat);
        reed.position.set(wx+Math.cos(a)*9.4, wy+0.7, wz+Math.sin(a)*9.4);
        reed.rotation.z = (rng()-0.5)*0.2;
        addTo(scene, reed);
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
    ledge.castShadow = true;
    COLLIDERS.push({ x:ledgeX, z:ledgeZ, r:3.0, bot:wy, top:wy+ledgeH });
    addOutline(ledge, 0.03);
    addTo(scene, ledge);
    const fallMat = makeWaterMat();
    fallMat.uniforms.uShallow.value = waterFoam;
    const fall = new THREE.Mesh(new THREE.PlaneGeometry(2.2, ledgeH, 6, 14), fallMat);
    fall.position.set(ledgeX + (wx-ledgeX)*0.06, wy+ledgeH*0.5, ledgeZ + (wz-ledgeZ)*0.06);
    fall.lookAt(wx, fall.position.y, wz);
    addTo(scene, fall);
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
    addTo(scene, mist);
    world.updaters.push((dt,t)=>{
      pondMat.uniforms.uTime.value = t;
      fallMat.uniforms.uTime.value = t*2.2;
      mistMat.uniforms.uTime.value = t;
    });
  }

  /* ----- LANDMARK: village ruins — broken foundations of whatever stood here before the Bloom.
     The intro screen says "the valley where your village once stood"; this is that line's one
     physical payoff instead of just flavor text nothing in the world ever points back to. ----- */
  if(hasLandmark('ruins')){
    const rSite = spot(rng, PARAMS.ruinsDMin, PARAMS.ruinsDMin + PARAMS.ruinsDVar, 8);
    const rx = rSite.x, rz = rSite.z;
    const wallMat = toonMat({ color:0x8a8270, map:paintTexture('#8a8270',[{c:'#6a6252',n:12,r:9,a:0.45}],{dabs:220}), rim:0.35 });
    const beamMat = toonMat({ color:0x3a2a1a, rim:0.25 });
    const fw = 9 + rng()*4, fl = 7 + rng()*4;
    const wallYaw = rng()*Math.PI*2, cosY = Math.cos(wallYaw), sinY = Math.sin(wallYaw);
    // walk the footprint's perimeter in equal steps, jittered so it reads as a ruined room
    // outline rather than a CAD rectangle — every wall segment gets its OWN broken height, so
    // the skyline is stubs and near-standing sections, never one tidy consistent wall.
    for(let i=0;i<PARAMS.ruinsWalls;i++){
      const t = i/PARAMS.ruinsWalls, side = Math.floor(t*4), along = (t*4)%1;
      let lx, lz;
      if(side===0){ lx=-fw/2+along*fw; lz=-fl/2; }
      else if(side===1){ lx=fw/2; lz=-fl/2+along*fl; }
      else if(side===2){ lx=fw/2-along*fw; lz=fl/2; }
      else { lx=-fw/2; lz=fl/2-along*fl; }
      lx += (rng()-0.5)*1.2; lz += (rng()-0.5)*1.2;
      const wx = rx + lx*cosY - lz*sinY, wz = rz + lx*sinY + lz*cosY, wy = groundHeight(wx, wz);
      const h = 0.6 + rng()*2.2;
      const wall = new THREE.Mesh(new THREE.BoxGeometry(2.6+rng()*1.4, h, 0.6), wallMat);
      wall.position.set(wx, wy+h*0.5, wz);
      wall.rotation.y = wallYaw + t*Math.PI*2 + (rng()-0.5)*0.2;
      wall.castShadow = true; wall.receiveShadow = true;
      addOutline(wall, 0.035);
      addTo(scene, wall);
      if(h > STEP) COLLIDERS.push({ x:wx, z:wz, r:1.3, bot:wy, top:wy+h });
    }
    // fallen roof beams, lying across the footprint
    for(let i=0;i<2;i++){
      const bx = rx+(rng()-0.5)*fw*0.7, bz = rz+(rng()-0.5)*fl*0.7, by = groundHeight(bx,bz);
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.22, 4.5+rng()*2, 7), beamMat);
      beam.rotation.z = Math.PI/2; beam.rotation.y = rng()*Math.PI;
      beam.position.set(bx, by+0.2, bz);
      addOutline(beam, 0.05);
      addTo(scene, beam);
    }
    // rubble scatter — same stone family as the walls, reuses the shared ambient-rock geometry
    for(let i=0;i<PARAMS.ruinsRubble;i++){
      const a = rng()*Math.PI*2, r = rng()*Math.max(fw,fl)*0.65;
      const bx = rx+Math.cos(a)*r, bz = rz+Math.sin(a)*r, by = groundHeight(bx,bz);
      const s = 0.3+rng()*0.5;
      const chunk = new THREE.Mesh(rockGeo, wallMat);
      chunk.scale.setScalar(s);
      chunk.position.set(bx, by+s*0.3, bz);
      chunk.rotation.set(rng()*7, rng()*7, rng()*7);
      addTo(scene, chunk);
    }
  }

  /* ----- LANDMARK: summit — a climbable multi-tier spire, the map's one guaranteed high point.
     A shrine waits at the top (see the shrines pass below), so climbing it is a destination,
     not just scenery you can see from far away. ----- */
  if(hasLandmark('summit')){
    const suSite = spot(rng, PARAMS.summitDMin, PARAMS.summitDMin + PARAMS.summitDVar, PARAMS.summitR0 + 3);
    let curR = PARAMS.summitR0, curY = groundHeight(suSite.x, suSite.z), curX = suSite.x, curZ = suSite.z;
    for(let i=0;i<PARAMS.summitTiers;i++){
      const nextR = curR * (0.78 - rng()*0.06); // gentle shrink: stepped-formation rule (CLAUDE.md)
                                                  // — too tight a shrink and the tier above has
                                                  // nowhere to put the player's feet
      const h = PARAMS.summitTierH + rng()*0.2;  // 1.7-1.9 m: over STEP, under the jump apex —
                                                  // every tier is a climb, not a wall or a walk-up
      const tier = new THREE.Mesh(new THREE.CylinderGeometry(nextR, curR, h, 10), rockMat);
      tier.position.set(curX, curY+h*0.5, curZ);
      tier.castShadow = true; tier.receiveShadow = true;
      addOutline(tier, 0.04);
      addTo(scene, tier);
      COLLIDERS.push({ x:curX, z:curZ, r:curR, bot:curY, top:curY+h });
      curY += h; curR = nextR;
      // a little per-tier drift so the climb spirals instead of stacking dead straight — capped
      // small relative to the tier's OWN radius, so the tier above never drifts off the tier below
      const drift = curR*0.15;
      curX += (rng()-0.5)*drift; curZ += (rng()-0.5)*drift;
    }
    const capR = Math.max(curR*1.15, 2.2); // floor on the peak's own size: RNG shrink alone could
                                            // otherwise land a platform too small to comfortably stand on
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR, capR, 0.4, 10), rockMat);
    cap.position.set(curX, curY+0.2, curZ);
    cap.receiveShadow = true; addOutline(cap, 0.04);
    addTo(scene, cap);
    COLLIDERS.push({ x:curX, z:curZ, r:capR, bot:curY, top:curY+0.4 });
    shrines.push({ x:curX, z:curZ, y:curY+0.4 });
  }

  /* ----- shrines: one-time run buffs, found rather than fought for. summit's own (if it rolled)
     was pushed above; these fill out the rest on open ground, through the same siteTest sampler
     every other authored landmark uses. Geometry is one small pedestal + orb per shrine — there
     are at most 3 in any world, so this never needed instancing. ----- */
  for(let i=0;i<PARAMS.shrineCount;i++){
    const site = spot(rng, 30, 175, 5);
    shrines.push({ x:site.x, z:site.z, y:groundHeight(site.x, site.z) });
  }
  const SHRINE_KINDS = [
    { id:'vigor', color:0xff6a6a, name:'Shrine of Vigor' },
    { id:'fury',  color:0xffa347, name:'Shrine of Fury' },
    { id:'haste', color:0x6ad0ff, name:'Shrine of Haste' },
  ];
  if(shrines.length){
    const pedestalMat = toonMat({ color:0x7a7266, map:paintTexture('#7a7266',[{c:'#5a5248',n:10,r:8,a:0.4}],{dabs:180}), rim:0.35 });
    for(const sh of shrines){
      const kind = SHRINE_KINDS[(rng()*SHRINE_KINDS.length)|0];
      sh.kind = kind.id; sh.claimed = false;
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1.3, 8), pedestalMat);
      base.position.set(sh.x, sh.y+0.65, sh.z);
      base.castShadow = true; base.receiveShadow = true;
      addOutline(base, 0.05);
      addTo(scene, base);
      COLLIDERS.push({ x:sh.x, z:sh.z, r:1.1, bot:sh.y, top:sh.y+1.3 });
      const orbMat = toonMat({ color:kind.color, emissive:kind.color, emissiveIntensity:0.9, rim:0.8, rimColor:kind.color });
      const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 1), orbMat);
      orb.position.set(sh.x, sh.y+1.5, sh.z);
      addOutline(orb, 0.05);
      addTo(scene, orb);
      const shrineLight = new THREE.PointLight(kind.color, 5, 10);
      shrineLight.position.set(sh.x, sh.y+1.6, sh.z);
      addTo(scene, shrineLight);
      const ph = rng()*7;
      // claimed is toggled by main.js on the SAME object (world.shrines holds this exact
      // reference) — reading it here rather than copying it is what lets the orb visually die
      // the instant the player claims it, with no round trip back through world.js.
      world.updaters.push((dt,t)=>{
        orb.visible = !sh.claimed;
        if(sh.claimed){ shrineLight.intensity = 0; return; }
        orb.position.y = sh.y+1.5+Math.sin(t*1.3+ph)*0.08;
        orb.rotation.y = t*0.6;
        shrineLight.intensity = 5+Math.sin(t*2+ph)*1.5;
      });
    }
  }
  world.shrines = shrines;

  /* ----- birds ----- */
  {
    const birdMat = new THREE.MeshBasicMaterial({ color:0x2c2233, side:THREE.DoubleSide, fog:false });
    const birds = [];
    for(let i=0;i<PARAMS.birds;i++){
      const b = new THREE.Group();
      const w1 = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 0.9), birdMat);
      const w2 = w1.clone();
      w1.position.x = -1.1; w2.position.x = 1.1;
      b.add(w1, w2);
      b.userData = { a: rng()*7, r: 90+rng()*120, h: 55+rng()*40, sp: 0.05+rng()*0.06, w1, w2 };
      addTo(scene, b); birds.push(b);
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
      gr.addColorStop(0, '#'+offsetHSLsRGB(base.clone(),0,0,0.22).getHexString());
      gr.addColorStop(0.6, '#'+base.getHexString());
      gr.addColorStop(1, '#'+offsetHSLsRGB(base.clone(),0,0,-0.18).getHexString());
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
    for(let i=0;i<PARAMS.butterflies;i++){
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
      addTo(scene, b); flies.push(b);
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
      for(let i=0;i<PARAMS.frogs;i++){
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
        addTo(scene, g); frogs.push(g);
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
    for(let i=0;i<PARAMS.rabbits;i++){
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
      addTo(scene, g); rabbits.push(g);
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

  return world;
}

/* ---------------- item 42: owned-vs-shared disposal ----------------
   NOTE ON WHY THIS EXISTS TODAY: nothing calls it yet. main.js's rerollWorld() sets
   location.search, i.e. a full page reload, so buildWorld() runs exactly once per load. It is
   here because item 31's build split makes in-session rebuilds possible and item 10's dev panel
   will do one every time a slider moves — dozens per session — and a teardown bolted on later,
   after the props wave has added another twenty batches, is a teardown that misses things.

   Ownership is decided by USE COUNT, in one pass, instead of by hand at ~90 construction sites.
   A geometry or material used by exactly one of our meshes is that mesh's to drop; anything used
   by two or more is shared (rockGeo alone backs the rock batch, its hull, the rune boulder, the
   cave spikes and the waterfall ledge) and is left alone. Disposing a shared geometry is the bug
   the flags exist to prevent: it empties every OTHER prop that references it, and every prop
   built afterwards from the same source. Hand-marking is how you get that wrong. */
function markOwnership(world){
  const geoUse = new Map(), matUse = new Map();
  const bump = (map, k)=>{ if(k) map.set(k, (map.get(k)||0) + 1); };
  for(const root of OWNED) root.traverse(n=>{
    bump(geoUse, n.geometry);
    if(Array.isArray(n.material)) for(const m of n.material) bump(matUse, m);
    else bump(matUse, n.material);
  });
  let own = 0, shared = 0;
  for(const root of OWNED) root.traverse(n=>{
    n.userData.ownGeo = !!(n.geometry && geoUse.get(n.geometry) === 1);
    n.userData.ownMat = !Array.isArray(n.material) && !!(n.material && matUse.get(n.material) === 1);
    if(n.userData.ownGeo || n.userData.ownMat) own++;
  });
  for(const [, c] of geoUse) if(c > 1) shared++;
  for(const [, c] of matUse) if(c > 1) shared++;
  world.disposeStats = { roots: OWNED.length, owned: own, shared };
  world.dispose = ()=>{
    for(const root of OWNED){
      root.traverse(n=>{
        if(n.userData.ownGeo) n.geometry.dispose();
        if(n.userData.ownMat) n.material.dispose();
      });
      if(root.parent) root.parent.remove(root);
    }
    // truncate in place: entities.js and main.js hold the exported COLLIDERS reference, and an
    // updater list swapped for a new array would leave the old closures running off a stale world.
    OWNED.length = 0; COLLIDERS.length = 0; EXCLUSIONS.length = 0; SITES.length = 0; CAVE_CHAMBERS.length = 0;
    world.updaters.length = 0;
    world.update = ()=>{};
    RAVINE = null; POCKETS = {}; LANDMARKS = []; WORLD = null;
    // the mask describes a collider list that no longer exists; a stale one would bless ground
    // in the next world that is inside a rock in this one.
    resetReach();
  };
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
