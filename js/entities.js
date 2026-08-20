// entities.js — player, mushrooms, boss, powerups, projectiles
import * as THREE from 'three';
import { toonMat, addOutline, paintTexture, makeBlobShadow, glowTexture } from './fx.js';
import { groundHeight, surfaceAt, slopeAt, inExclusion } from './world.js';
import { WEAPONS_BY_ID } from './weapons.js';
import { POTIONS_BY_ID } from './potions.js';
import { buildSwordVariant } from './swordVisuals.js';
import { ARMOR_BY_ID, ARMOR_SLOTS } from './armor.js';

/* ---------------- movement constants (items 02, 03, 04) ----------------
   A movement constant is a level-design constraint, so each says which design it holds up.
   world.js declares its OWN copies of STEP/PLAYER_R/PLAYER_H at module scope (it cannot import
   them back without a TDZ cycle) and STEP does double duty there: it is both surfaceAt()'s climb
   threshold and the collider *registration* threshold — a prop whose top clears STEP above the
   ground gets a collider, anything shorter deliberately gets none. Change STEP in one file only
   and short props become invisible walls, or tall ones become unclimbable. Keep them identical. */
export const STEP = 1.5;        // tallest ledge you walk onto without jumping. Bridge kerbs, log
                                // piles and rock skirts are all authored under it on purpose.
export const PLAYER_R = 0.85;   // body radius — also the forward-probe distance, so the shoulders
                                // stop at a rock face instead of sinking into it
export const PLAYER_H = 2.55;   // body column: what a wall must overlap to block you, and what a
                                // spore pod's underside gets struck by
export const COYOTE = 0.13;     // grace after walking off a ledge. The ravine lip is meant to be a
                                // running jump; frame-perfect timing is not the skill being tested.
export const JUMP_BUF = 0.16;   // a jump pressed just before touchdown still fires on the landing
                                // frame, so chained hops over the rocks don't eat inputs
export const SNAP_DOWN = 0.55;  // downslope stick. Our hills roll over faster than gravity catches
                                // up, and skipping off every crest reads as a bug, not as air.
const JUMP_VY = 11;             // same impulse main.js's tryJump() has always applied
const LAND_HARD = -14;          // vy below this thumps (squash + sound). Walking downhill peaks
                                // around -8, so a stroll never squashes.
const SQUASH_EASE = 9;          // rate the squash scalar eases back to 1

/* ---------------- creature terrain rules (item 57) ----------------
   Slope is |grad h| from world.js. The ravine banks run ~1.0-1.6 and the valley rim ~0.45, so a
   ceiling just under 1 stops mushrooms scaling the mother-mushroom stem and ravine walls without
   shrinking the field they can actually use. */
const MOB_SLOPE_MAX = 0.85;
const BOSS_SLOPE_MAX = 4;   // bosses are effectively exempt: a boss that cannot reach the player is
                            // a soft-lock, which is strictly worse than a boss on a hillside
const MOB_DROP_MAX = 4;     // a creature won't step off a drop taller than itself — this is what
                            // keeps them out of the ravine without them knowing it exists
const MOB_RING = 195;       // same playable ring the player is clamped to
const MOB_DETOUR = 0.7;     // how long an alternative heading that cleared is kept. Re-rolling one
                            // every frame is exactly what makes a blocked animal look broken.

/* item 11 — spore pods (and anything else burst by jumping into it from below) register here.
   The Player only ever READS this array, so world.js/main.js own creation and lifetime; entries
   are `{x, z, bot, r, off?, onHead(player, game)}` where `bot` is the underside plane the head
   crosses. Empty registry = one length check per frame, so this is a no-op until someone places
   pods. `off = true` retires an entry; nothing splices, matching the COLLIDERS convention. */
export const HEAD_HITS = [];
export function registerHeadHit(entry){ HEAD_HITS.push(entry); return entry; }
export function clearHeadHits(){ HEAD_HITS.length = 0; }

// gradation: brown -> green -> red -> blue -> purple -> rainbow (lowest to highest)
export const RARITIES = [
  { name:'Common',    color:0x8a6a42, glow:0x8a6a42, hp:28,  dmg:7,  speed:3.1, scale:0.85, score:1,  weight:56 },
  { name:'Uncommon',  color:0x4aa832, glow:0x6fe65a, hp:52,  dmg:11, speed:3.7, scale:1.05, score:2,  weight:28 },
  { name:'Rare',      color:0xdb3a3a, glow:0xff5a4a, hp:95,  dmg:17, speed:4.3, scale:1.3,  score:4,  weight:12 },
  { name:'Epic',      color:0x3a7fe0, glow:0x5aa0ff, hp:175, dmg:25, speed:4.8, scale:1.6,  score:9,  weight:5 },
  { name:'Legendary', color:0x9a3ae0, glow:0xb46bff, hp:330, dmg:35, speed:5.3, scale:1.95, score:20, weight:1.6 },
  { name:'Mythic',    color:0xff5ad0, glow:0xffe066, hp:600, dmg:50, speed:6.0, scale:2.35, score:50, weight:0.35, rainbow:true },
];

const capTexCache = {};
function capTexture(color, rarityIdx=0){
  const key = color.toString(16)+'_'+rarityIdx;
  if(!capTexCache[key]){
    const c = new THREE.Color(color);
    const n = 5 + rarityIdx*3; // more ornate dappling at higher rarity
    capTexCache[key] = paintTexture('#'+c.getHexString(),
      [{c:'#fffaf0', n, r:18-rarityIdx, a:0.95},{c:'#fffaf0', n, r:9, a:0.9},{c:'#1c1410', n:0, r:0, a:0}], {dabs:320, dabsContrast:1});
  }
  return capTexCache[key];
}
let stemTex = null;
// shared temps (no per-frame allocations in hot paths)
const _fwd = new THREE.Vector3(), _tip = new THREE.Vector3(), _to = new THREE.Vector3();
// Mushroom.update's player-delta. Its OWN scratch, deliberately not _to: _to belongs to
// Player.attack's target loop, and one creature's update must never be able to stomp on a
// vector the attack resolve is mid-way through reading.
const _toP = new THREE.Vector3();

/* =============== MUSHROOM ENEMY =============== */
/* Elemental scratch + tuning shared by every creature. ELEM_BURN_TICK is here rather than in
   rings.js because it is a property of how a creature takes damage, not of the ring: 0.4 s is
   coarse enough that a burn is a handful of hit() calls rather than one per frame, and fine enough
   that the ticks still read as a rhythm. */
const ELEM_BURN_TICK = 0.4;
// seconds between terrain-steepness rechecks per creature; see the note in Mushroom.update
const SLOPE_RECHECK = 0.125;
const BURN_FROM = new THREE.Vector3();   // reused: burn ticks must not allocate

export class Mushroom {
  constructor(scene, rarityIdx, pos, zoneMult){
    const R = RARITIES[rarityIdx];
    this.rarity = rarityIdx; this.R = R;
    this.maxHp = R.hp * zoneMult; this.hp = this.maxHp;
    this.dmg = R.dmg * 0.85 * (1 + (zoneMult-1)*0.7);
    this.speed = R.speed * (1 + (zoneMult-1)*0.15);
    this.scene = scene; this.dead = false;
    this.state = 'idle'; this.t = Math.random()*10;
    this.attackCd = 2 + Math.random()*2; this.lungeT = 0;
    this.vel = new THREE.Vector3(); this.kb = new THREE.Vector3();
    this.flash = 0; this.auraT = 0;
    /* elemental status (rings.js). Two timers and two magnitudes — no objects, no arrays, because
       these are read on every enemy every frame. `_baseSpeed` is captured lazily in update()
       rather than here: Boss and GluttonBoss overwrite this.speed in their OWN constructors after
       super() runs, so reading it now would bank the base mushroom's speed for a boss. */
    this.burnT = 0; this.burnDps = 0; this.burnTick = 0;
    this.chillT = 0; this.chillSlow = 0;
    this._baseSpeed = undefined; this._elemLit = false;
    // item 57 wander/detour state. A heading is kept until it fails, and an alternative that
    // cleared is held for MOB_DETOUR seconds — the naive "add a fixed turn every blocked frame"
    // thrashes the same failing angle and reads as a broken animal.
    this.wanderA = Math.random()*Math.PI*2; this.wanderT = 1 + Math.random()*2;
    this.detourT = 0; this.detourX = 0; this.detourZ = 0;
    this.moved = false;              // walk-bob is gated on this: no step, no bob
    this._mx = 0; this._mz = 0; this._mdx = 0; this._mdz = 0;
    this._stuck = false; this._steep = false; this._slopeCd = 0;

    if(!stemTex) stemTex = paintTexture('#f2e4c8', [{c:'#d9c8a8',n:8,r:6,a:0.5}], {dabs:200});
    const g = this.group = new THREE.Group();
    const s = R.scale;
    // stem
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.42*s, 0.55*s, 1.3*s, 8), toonMat({color:0xf2e4c8, map:stemTex, rim:0.35}));
    stem.position.y = 0.65*s; addOutline(stem, 0.07);
    /* The stem takes no shadow. A cap is a wide disc directly above a narrow cylinder, so the stem
       is in shade from SOMETHING nearly always — and this cream is the one albedo with nowhere to
       go when it darkens, so what the player saw was a black-stemmed mushroom. The cap keeps its
       receiveShadow, which is what still grounds the creature in the scene.
       Set here rather than in shadowize() because the reason is about this mesh's ROLE, and only
       the file that knows the mushroom is built from a cap-over-stem can say so. */
    stem.userData.noReceive = true;
    // cap
    const cap = new THREE.Mesh(new THREE.SphereGeometry(1.0*s, 12, 9, 0, Math.PI*2, 0, Math.PI*0.55),
      toonMat({color:R.color, map:capTexture(R.color, rarityIdx), rim:0.55, rimColor:'#'+new THREE.Color(R.glow).getHexString()}));
    cap.position.y = 1.15*s; cap.scale.set(1.15, 0.95, 1.15); addOutline(cap, 0.055);
    // dark cap underside
    const under = new THREE.Mesh(new THREE.CircleGeometry(1.05*s, 12),
      new THREE.MeshBasicMaterial({ color:0x2c1f18 }));
    under.position.y = 1.17*s; under.rotation.x = Math.PI/2; g.add(under);
    // eyes (angry)
    const eyeMat = new THREE.MeshBasicMaterial({color:0xffffff});
    const pupMat = new THREE.MeshBasicMaterial({color:0x1c1410});
    this.eyes = [];
    for(const sx of [-1,1]){
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.17*s,8,6), eyeMat);
      e.position.set(0.27*s*sx, 0.74*s, 0.40*s);
      const p = new THREE.Mesh(new THREE.SphereGeometry(0.08*s,6,5), pupMat);
      p.position.set(0.27*s*sx, 0.72*s, 0.53*s);
      const brow = new THREE.Mesh(new THREE.BoxGeometry(0.30*s,0.07*s,0.06*s), pupMat);
      brow.position.set(0.27*s*sx, 0.90*s, 0.45*s); brow.rotation.z = -0.55*sx;
      g.add(e,p,brow); this.eyes.push(e);
    }
    // stubby arms
    this.arms = [];
    for(const sx of [-1,1]){
      const a = new THREE.Mesh(new THREE.SphereGeometry(0.16*s,6,5), toonMat({color:0xf2e4c8, rim:0.3}));
      a.position.set(0.55*s*sx, 0.55*s, 0); a.scale.set(1,1.6,1); addOutline(a,0.06);
      g.add(a); this.arms.push(a);
    }
    /* glow aura (rare+) — NO PointLight, on purpose. This is the same rule the Powerup below
       spells out, and it matters more here: enemies spawn and die in bursts, and three.js keys a
       shader program on the scene's light count, so every rare mushroom that appeared or died
       recompiled the program for every lit material on screen. Measured, spawning twelve of them:
       renderer.info.programs 152 -> 456 and a single 4.8 s frame. The rarity read is carried by
       three material-only layers instead:
         - the cap's own emissive, ramped by rarity, so the CREATURE is what glows;
         - a billboarded aura sprite carrying fx.glowTexture(). A sprite, not a sphere shell: an
           additive shell has FLAT alpha (a hard-edged disc, the mapless-halo bug in round form)
           and is a thing the camera can end up inside, which paints the whole viewport;
         - a soft pool of light on the ground, also mapped. A flat-alpha additive annulus is a
           pale wash with a hard edge on both sides; the radial map is what makes it light. */
    if(rarityIdx >= 2){
      // the creature glows, not the air around it — this is what replaces the light
      cap.material.emissive.set(R.glow);
      cap.material.emissiveIntensity = 0.22 + rarityIdx*0.16;
      const aura = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTexture(), color:R.glow,
        transparent:true, opacity:0.24+rarityIdx*0.06, blending:THREE.AdditiveBlending,
        depthWrite:false, fog:false }));   // fog off: fog on an additive layer adds sky to the sky
      aura.scale.setScalar(4.2*s); aura.position.y = 1.15*s; g.add(aura); this.aura = aura;
      // ground pool. Disc, not an annulus: with a radial map the falloff IS the ring, and there
      // is no inner edge left to read as a decal.
      const ring = new THREE.Mesh(new THREE.CircleGeometry(2.0*s, 24),
        new THREE.MeshBasicMaterial({ color:R.glow, map:glowTexture(), transparent:true,
          opacity:0.34+rarityIdx*0.04, blending:THREE.AdditiveBlending, depthWrite:false,
          side:THREE.DoubleSide, fog:false }));
      ring.rotation.x = -Math.PI/2; ring.position.y = 0.08; g.add(ring); this.groundRing = ring;
    }
    /* the hit flash WRITES cap.material.emissive, so the rarity glow has to be remembered
       somewhere or the first hit erases it permanently — flash now adds on top of this. */
    this.emissBase = cap.material.emissive.clone();
    this.blob = makeBlobShadow(2.4*s); this.blob.position.y = 0.05; g.add(this.blob);
    this.body = new THREE.Group(); this.body.add(stem, cap);
    this.cap = cap; this.stem = stem;
    g.add(this.body);
    g.position.copy(pos);
    g.position.y = groundHeight(pos.x, pos.z);
    scene.add(g);
    this.baseY = g.position.y;
  }
  /* THE ONE DOOR for every elemental effect, whatever applied it. Effects REFRESH rather than
     stack — max(), not += — and that is a balance decision, not laziness: a held cone re-touches
     the same creature every frame, so a stacking burn would multiply by frame rate and a 60 Hz
     player would do twice the damage of a 30 Hz one. Refresh-to-longest is the only rule that
     makes a held emitter frame-rate independent. */
  applyElement(kind, ring){
    if(this.dead || !ring) return;
    if(kind === 'burn'){
      if(ring.burnDur > this.burnT) this.burnT = ring.burnDur;
      if(ring.burnDps > this.burnDps) this.burnDps = ring.burnDps;
    } else if(kind === 'chill'){
      if(ring.chillDur > this.chillT) this.chillT = ring.chillDur;
      if(ring.chillSlow > this.chillSlow) this.chillSlow = ring.chillSlow;
    }
  }
  hit(dmg, from, game, kbMult=1){
    if(this.dead) return;
    this.hp -= dmg; this.flash = 1;
    const dir = this.group.position.clone().sub(from).setY(0).normalize();
    this.kb.addScaledVector(dir, (6 + dmg*0.15) * kbMult);
    if(this.hp <= 0) this.die(game);
  }
  die(game){
    this.dead = true;
    const p = this.group.position.clone(); p.y += 1;
    const c = new THREE.Color(this.R.glow);
    // counts halved (26+14 -> 14+8): fx.js caps sprite pixel size, and the cap only stays loose
    // if the burst does not hand it forty overlapping sprites to clamp
    game.particles.burst(p, 14, {r:c.r, g:c.g, b:c.b, spread:5, size:9, life:0.9, grav:6, drag:0.96});
    game.particles.burst(p, 8, {r:1,g:1,b:1, spread:3, size:6, life:0.5});
    game.audio.pop(this.rarity);
    game.onKill(this);
    this.scene.remove(this.group);
  }
  /* item 57 — ONE gate every enemy step passes through: chase, lunge, wander and knockback all
     call it, so a creature can never end up somewhere its own wander would have refused.
     (ddx, ddz) is the world-space delta attempted from where it stands; feetY is its CURRENT
     stand height, which is what decides climbable-vs-wall inside surfaceAt. */
  tryDir(ddx, ddz, feetY, zones){
    const p = this.group.position;
    const nx = p.x + ddx, nz = p.z + ddz;
    if(nx*nx + nz*nz > MOB_RING*MOB_RING) return false;            // playable ring
    // authored keep-outs are a WANDER rule only: a hunting creature follows you anywhere it can
    // physically stand, and a boss ignores them outright so its approach can't be fenced off.
    if(zones && !this.isBoss && inExclusion(nx, nz, 0)) return false;
    // _steep is the escape valve: something that spawned on a wall must be allowed to walk OFF
    // it, otherwise every candidate fails and it stands there forever.
    if(!this._steep && slopeAt(nx, nz) > (this.isBoss ? BOSS_SLOPE_MAX : MOB_SLOPE_MAX)) return false;
    const s = surfaceAt(nx, nz, feetY);
    const h = s.h, blocked = s.blocked;   // shared object: consume both fields immediately
    if(blocked && !this._stuck) return false;                      // wall (unless already inside one)
    if(h - feetY > STEP) return false;                             // too tall to walk onto
    if(feetY - h > MOB_DROP_MAX) return false;                     // won't step off a cliff
    this._mx = nx; this._mz = nz; this._mdx = ddx; this._mdz = ddz;
    return true;
  }
  commitStep(){
    const p = this.group.position;
    p.x = this._mx; p.z = this._mz;
    this.moved = true;
    return true;
  }
  // a refused diagonal is retried one axis at a time, so a creature grazes along a trunk
  // instead of stalling flat against it
  slideStep(ddx, ddz, feetY, zones){
    if(this.tryDir(ddx, ddz, feetY, zones)) return this.commitStep();
    if(ddx !== 0 && this.tryDir(ddx, 0, feetY, zones)) return this.commitStep();
    if(ddz !== 0 && this.tryDir(0, ddz, feetY, zones)) return this.commitStep();
    return false;
  }
  // the island's wander resolve: keep a detour that worked, else the intended heading, else
  // sample ~8 alternatives and take the first that clears. Nothing clears -> stand still.
  moveAlong(dt, ddx, ddz, feetY, zones){
    if(this.detourT > 0){
      this.detourT -= dt;
      const d = Math.hypot(ddx, ddz);
      if(this.slideStep(this.detourX*d, this.detourZ*d, feetY, zones)) return true;
      this.detourT = 0;
    }
    if(this.slideStep(ddx, ddz, feetY, zones)) return true;
    const d = Math.hypot(ddx, ddz);
    for(let i=0;i<8;i++){
      const a = Math.random()*Math.PI*2, cx = Math.sin(a), cz = Math.cos(a);
      if(this.tryDir(cx*d, cz*d, feetY, zones)){
        this.detourX = cx; this.detourZ = cz; this.detourT = MOB_DETOUR;
        return this.commitStep();
      }
    }
    return false;
  }
  update(dt, game){
    if(this.dead) return;
    this.t += dt;
    /* Elemental tick, FIRST, because the AI below reads this.speed a dozen times and the chill has
       to be in it before any of them. Writing this.speed is deliberately the whole mechanism: it
       means chase, lunge, hop and wander are all slowed by construction instead of each needing to
       remember to ask. `_baseSpeed` is captured here on the first frame — by which point every
       constructor in the hierarchy has finished writing its own speed. */
    if(this._baseSpeed === undefined) this._baseSpeed = this.speed;
    if(this.chillT > 0){
      this.chillT -= dt;
      if(this.chillT <= 0){ this.chillT = 0; this.chillSlow = 0; this.speed = this._baseSpeed; }
      else this.speed = this._baseSpeed * (1 - this.chillSlow);
    }
    if(this.burnT > 0){
      this.burnT -= dt;
      this.burnTick -= dt;
      if(this.burnTick <= 0){
        this.burnTick = ELEM_BURN_TICK;
        // through hit(), so a burn kill pays essence, coins, XP and the kill counter exactly like
        // a sword kill — one damage chokepoint, per the README. kbMult 0: fire does not shove.
        // BURN_FROM is a module scratch offset from the creature itself; hit() normalizes
        // (position - from), and a zero-length vector there would be NaN and launch it to infinity.
        BURN_FROM.copy(this.group.position); BURN_FROM.z -= 1;
        this.hit(this.burnDps*ELEM_BURN_TICK, BURN_FROM, game, 0);
        if(this.dead) return;
        if(game.particles) game.particles.puff(this.group.position.x, this.group.position.y + 0.9*this.R.scale,
          this.group.position.z, { color:0xff8a2a, n:2, size:8, life:0.42, rise:2.6, spread:1.1, grav:-1.4, alpha:0.8 });
      }
      if(this.burnT <= 0){ this.burnT = 0; this.burnDps = 0; }
    }
    const g = this.group;
    const player = game.player;
    // reused scratch, not clone(): this ran once per enemy per frame, so a 60-enemy fight was
    // making 60 throwaway Vector3s every frame for no reason. Hot-path rule, CLAUDE.md.
    const toP = _toP.copy(player.group.position).sub(g.position); toP.y = 0;
    const dist = toP.length();
    const R = this.R;

    // --- AI ---
    // feet reference is baseY, not position.y: mid-hop the transform floats above the ground and
    // a creature would then "step onto" ledges STEP above its hop apex.
    const feetY = this.baseY;
    this.moved = false;
    // per-frame escape valves, one query each: a creature that spawned inside a rock or on a wall
    // face must be able to leave it, or every candidate below fails and it freezes there.
    this._stuck = surfaceAt(g.position.x, g.position.z, feetY).blocked;
    /* slopeAt is the most expensive per-entity query in the game — it is four groundHeight calls
       for a central difference, measured at 1.02 us against groundHeight's 0.31 — and it was being
       asked once per creature per frame. It does not need to be: it reads the TERRAIN, which never
       changes, sampled under a creature that walks at 3-6 m/s. Re-asking at 8 Hz instead of the
       frame rate moves the answer by at most a few centimetres of travel, and _steep is a boolean
       that only gates the escape valve below.
       Deliberately staggered by the creature's own wander phase rather than a shared counter, or
       every enemy in the world would re-slope on the same frame and turn a smooth cost into a
       120 Hz spike. `_slopeCd` starts at 0 so the first frame always measures. */
    this._slopeCd -= dt;
    if(this._slopeCd <= 0){
      this._slopeCd = SLOPE_RECHECK * (0.75 + (this.wanderA % 1) * 0.5);
      this._steep = slopeAt(g.position.x, g.position.z) > (this.isBoss ? BOSS_SLOPE_MAX : MOB_SLOPE_MAX);
    }
    this.attackCd -= dt;
    if(this.state === 'lunge'){
      this.lungeT -= dt;
      // a lunge is committed, so it slides along walls but never re-aims: honouring the collider
      // set here is what stops a charge ending up inside a tree
      this.slideStep(this.lungeDir.x * dt * this.speed * 3.2, this.lungeDir.z * dt * this.speed * 3.2, feetY, false);
      if(this.lungeT <= 0) this.state = 'chase';
      if(dist < 1.6*R.scale && this.lungeT > 0){
        player.hurt(this.dmg, g.position, game); this.lungeT = 0; this.state='chase';
      }
    } else if(dist < 26 && dist > 0.1){
      this.state = 'chase';
      toP.normalize();
      const targetYaw = Math.atan2(toP.x, toP.z);
      g.rotation.y += (((targetYaw - g.rotation.y + Math.PI*3) % (Math.PI*2)) - Math.PI) * Math.min(1, dt*8);
      if(dist > 3.2*R.scale){
        // hop toward player — resolved, so the chase walks round a rock instead of into it
        const hop = Math.max(0, Math.sin(this.t*6));
        const step = dt * this.speed * hop;
        if(step > 1e-5) this.moveAlong(dt, toP.x*step, toP.z*step, feetY, false);
      } else if(this.attackCd <= 0){
        // attack: lunge or shoot
        if(this.rarity >= 1 && Math.random() < 0.45){
          game.spawnProjectile(g.position.clone().setY(g.position.y+1.4*R.scale),
            player.group.position.clone().setY(1).sub(g.position).normalize(), this.dmg, R.glow);
          this.attackCd = 2.2 + Math.random();
          game.audio.spit();
        } else {
          this.state = 'lunge'; this.lungeT = 0.55;
          this.lungeDir = toP.clone();
          this.attackCd = 1.6 + Math.random();
          game.audio.lunge();
        }
        if(this.rarity >= 3 && Math.random() < 0.3){
          game.spawnRing(g.position.clone(), this.dmg*0.8, R.glow);
        }
      }
    } else {
      this.state = 'idle';
      // idle wander (item 57): a heading is held for seconds at a time and only re-rolled when it
      // expires or gets refused, so a creature blocked by a rock walks somewhere else instead of
      // pivoting on the spot. Wander is the one mover that respects exclusion zones.
      this.wanderT -= dt;
      if(this.wanderT <= 0){ this.wanderT = 2 + Math.random()*3; this.wanderA = Math.random()*Math.PI*2; }
      const step = dt * this.speed * 0.28;
      if(this.moveAlong(dt, Math.sin(this.wanderA)*step, Math.cos(this.wanderA)*step, feetY, true)){
        const targetYaw = Math.atan2(this._mdx, this._mdz);
        g.rotation.y += (((targetYaw - g.rotation.y + Math.PI*3) % (Math.PI*2)) - Math.PI) * Math.min(1, dt*3);
      } else {
        this.wanderT = 0;   // nothing cleared: pick a fresh heading next frame, don't spin
      }
    }

    // knockback — through the same gate, so a shove can't push a creature inside a prop
    this.slideStep(this.kb.x*dt, this.kb.z*dt, feetY, false);
    this.kb.multiplyScalar(Math.pow(0.0001, dt));

    // stay on ground + bounds. surfaceAt, so a prop top (the bridge deck) is standable ground.
    const gy = surfaceAt(g.position.x, g.position.z, feetY).h;   // shared object: read immediately
    const hopY = (this.state==='chase' && this.moved) ? Math.abs(Math.sin(this.t*6))*0.5*R.scale : 0;
    this.baseY += (gy - this.baseY) * Math.min(1, dt*10);
    g.position.y = this.baseY + hopY + (this.state==='lunge' ? Math.sin((0.55-this.lungeT)/0.55*Math.PI)*0.8 : 0);

    // squash & stretch (bold)
    const squash = 1 + Math.sin(this.t*6)*0.14*(this.state==='chase'?1.5:0.5);
    this.body.scale.set(1/Math.sqrt(squash), squash, 1/Math.sqrt(squash));
    for(let i=0;i<2;i++) this.arms[i].rotation.z = Math.sin(this.t*6+i*3)*0.4;
    // rarity aura: pulsing ground ring + rising particles
    if(this.groundRing){
      this.groundRing.material.opacity = 0.4 + Math.sin(this.t*3)*0.2;
      this.groundRing.scale.setScalar(1 + Math.sin(this.t*3)*0.1);
      if(Math.random() < dt*4){
        const c = new THREE.Color(this.R.glow);
        game.particles.spawn(g.position.x+(Math.random()-0.5)*1.5, g.position.y+0.3, g.position.z+(Math.random()-0.5)*1.5,
          {r:c.r, g:c.g, b:c.b, spread:0.4, size:6, life:1.1, vy:1.6, drag:0.99});
      }
    }

    // hit flash
    if(this.flash > 0){
      this.flash -= dt*5;
      const f = Math.max(0, this.flash);
      const b = this.emissBase;   // flash ADDS to the rarity glow; the last write (f=0) restores it
      this.cap.material.emissive.setRGB(b.r + f, b.g + f*0.3, b.b + f*0.2);
    }
    if(this.aura) this.aura.material.opacity = (0.24+this.rarity*0.06) * (1+Math.sin(this.t*3)*0.22);
    if(this.R.rainbow){ // mythic: cycle hue live across cap, aura and ground pool
      const hue = (this.t*0.15) % 1;
      this._rc = this._rc || new THREE.Color();
      this._rc.setHSL(hue, 0.85, 0.55);
      if(this.flash <= 0) this.cap.material.color.copy(this._rc);
      this.cap.material.emissive.copy(this._rc);
      if(this.aura) this.aura.material.color.copy(this._rc);
      if(this.groundRing) this.groundRing.material.color.copy(this._rc);
    }
    /* Elemental tint LAST, so it beats both the hit flash and the mythic hue cycle above — both of
       those write cap.material.emissive every frame, so anything written before them is erased.
       `_elemLit` is what restores emissBase exactly once when the last effect expires: without it
       either the tint sticks forever or every un-lit creature pays an emissive write per frame. */
    if(this.burnT > 0 || this.chillT > 0){
      const b = this.emissBase, f = Math.max(0, this.flash);
      if(this.burnT > 0) this.cap.material.emissive.setRGB(b.r + f + 0.55, b.g + f*0.3 + 0.16, b.b + f*0.2);
      else this.cap.material.emissive.setRGB(b.r + f, b.g + f*0.3 + 0.22, b.b + f*0.2 + 0.52);
      this._elemLit = true;
    } else if(this._elemLit && this.flash <= 0){
      this.cap.material.emissive.copy(this.emissBase);
      this._elemLit = false;
    }
    this.blob.position.y = 0.05 - (g.position.y - this.baseY);
  }
}

/* =============== BOSS =============== */
export class Boss extends Mushroom {
  // trait: a {id,name,desc,tint,glow} entry from bossTraits.js, or null for a plain fight.
  // mult: seeded {hp,dmg,speed} multipliers so even the same trait doesn't feel identical twice.
  constructor(scene, pos, trait=null, mult={hp:1,dmg:1,speed:1}){
    super(scene, 4, pos, 1);
    this.trait = trait;
    this.R = { ...RARITIES[4], name:'Elder Myconid', hp:2200, dmg:34, speed:3.4, scale:3.4, score:100,
      color: trait ? trait.tint : 0x7a4dbb, glow: trait ? trait.glow : 0xb46bff };
    this.maxHp = Math.round(this.R.hp * mult.hp); this.hp = this.maxHp;
    this.dmg = this.R.dmg * mult.dmg; this.speed = this.R.speed * mult.speed;
    this.baseDmg = this.dmg; // wrathful ramps this live off missing-hp; everything else keeps it fixed
    this.group.scale.setScalar(3.4/1.7);
    this.isBoss = true; this.bossWeaponId = 'sporecleaver'; this.ringCd = 5; this.summonCd = 9;
    this._prevHp = this.hp; this._sinceHitT = 0;
    this.cap.material = toonMat({ color:this.R.color, map:capTexture(this.R.color),
      rim:0.7, rimColor:'#'+new THREE.Color(this.R.glow).getHexString(), emissive:0x220a44, emissiveIntensity:0.6 });
    this.emissBase = this.cap.material.emissive.clone();
    // a boss is singular, but it still SPAWNS and DIES mid-run, so it gets no light either —
    // the aura sprite is simply scaled up, which costs one quad and recompiles nothing
    if(this.aura){ this.aura.material.color.set(this.R.glow); this.aura.material.opacity = 0.34;
      this.aura.scale.setScalar(9.5); this.aura.position.y = 2.2; }
    if(this.groundRing) this.groundRing.material.color.set(this.R.glow);
  }
  update(dt, game){
    super.update(dt, game);
    if(this.dead) return;
    if(this.hp < this._prevHp) this._sinceHitT = 0; else this._sinceHitT += dt;
    this._prevHp = this.hp;
    const missing = 1 - this.hp/this.maxHp;
    const isTrait = id => this.trait && this.trait.id === id;

    if(isTrait('regen') && this._sinceHitT > 3 && this.hp < this.maxHp){
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp*0.025*dt);
    }
    this.dmg = isTrait('wrathful') ? this.baseDmg * (1 + missing*0.4) : this.baseDmg;

    this.ringCd -= dt; this.summonCd -= dt;
    if(this.ringCd <= 0){
      const enrage = isTrait('wrathful') ? missing*4 : missing*3;
      this.ringCd = 6 - Math.min(isTrait('wrathful') ? 4 : 2.5, enrage);
      game.spawnRing(this.group.position.clone(), this.dmg*0.9, 0xb46bff);
      game.spawnRing(this.group.position.clone(), this.dmg*0.7, 0xffb02e, 2.2);
      if(isTrait('mirror')) game.spawnRing(this.group.position.clone(), this.dmg*0.6, this.trait.glow, 4.4);
      game.audio.roar(0.5);
      game.shake(0.5);
    }
    if(this.summonCd <= 0){
      this.summonCd = isTrait('swarming') ? 7 : 11;
      game.audio.roar(1);
      const count = isTrait('swarming') ? 4 : 3;
      for(let i=0;i<count;i++){
        const a = Math.random()*Math.PI*2;
        const p = this.group.position.clone().add(new THREE.Vector3(Math.cos(a)*8, 0, Math.sin(a)*8));
        game.spawnEnemy(Math.min(3, (Math.random()*4)|0), p, 1);
      }
      game.announce('The Elder calls its brood!');
    }
  }
}

/* =============== SECOND BOSS: ROTMAW THE BLOATED =============== */
// a completely different silhouette (squat, wide, bloated) and attack kit
// (charge slam, vomit barrage, toxic puddles) from the tall, elegant Elder Myconid
export class GluttonBoss extends Mushroom {
  constructor(scene, pos, trait=null, mult={hp:1,dmg:1,speed:1}){
    super(scene, 4, pos, 1);
    this.trait = trait;
    this.R = { ...RARITIES[4], name:'Rotmaw the Bloated', hp:2600, dmg:30, speed:2.6, scale:3.4, score:100,
      color: trait ? trait.tint : 0x9acc3a, glow: trait ? trait.glow : 0xc8e066 };
    this.maxHp = Math.round(this.R.hp * mult.hp); this.hp = this.maxHp;
    this.dmg = this.R.dmg * mult.dmg; this.speed = this.R.speed * mult.speed;
    this.group.scale.set(4.6, 2.5, 4.6); // wide and squat, not tall — reads as fat rather than "bigger Elder"
    this.isBoss = true; this.bossWeaponId = 'ravenousmaw';
    // recolor + a bulging belly slung under the cap
    const bileMat = toonMat({ color:this.R.color, map:capTexture(this.R.color), rim:0.5,
      rimColor:'#'+new THREE.Color(this.R.glow).getHexString(), emissive:0x2a3a10, emissiveIntensity:0.4 });
    this.cap.material = bileMat;
    this.emissBase = this.cap.material.emissive.clone();
    const belly = new THREE.Mesh(new THREE.SphereGeometry(0.95, 12, 9), toonMat({ color:this.R.color, rim:0.4 }).clone());
    belly.material.color.offsetHSL(0, 0, -0.12);
    belly.position.y = 0.55; belly.scale.set(1.3, 1.05, 1.3); addOutline(belly, 0.06);
    this.body.add(belly); this.belly = belly;
    if(this.aura){ this.aura.material.color.set(this.R.glow); this.aura.material.opacity = 0.30;
      this.aura.scale.setScalar(8.5); this.aura.position.y = 1.8; }   // see Boss: no PointLight
    if(this.groundRing) this.groundRing.material.color.set(this.R.glow);
    this.chargeCd = 8; this.vomitCd = 5; this.puddleCd = 10; this.summonCd = 13;
    this.charging = false; this.telegraphT = 0;
  }
  hit(dmg, from, game, kbMult=1){
    if(this.trait && this.trait.id === 'thickhide') dmg *= 0.8;
    super.hit(dmg, from, game, kbMult);
  }
  update(dt, game){
    super.update(dt, game);
    if(this.dead) return;
    const isTrait = id => this.trait && this.trait.id === id;
    // belly wobble, independent of the base squash/stretch
    this.belly.scale.x = 1.3 + Math.sin(this.t*5)*0.05;
    this.belly.scale.z = 1.3 + Math.cos(this.t*5)*0.05;
    if(this.telegraphT > 0){
      this.telegraphT -= dt;
      const k = 1 - this.telegraphT/0.6;
      this.body.scale.setScalar(1 + Math.sin(k*Math.PI)*0.18); // visible "inhale" before the slam
      if(this.telegraphT <= 0 && game.player){
        this.charging = true;
        const toP = game.player.group.position.clone().sub(this.group.position).setY(0).normalize();
        this.state = 'lunge'; this.lungeDir = toP; this.lungeT = 1.1;
        game.audio.roar(1); game.shake(0.6);
      }
      return;
    }
    this.chargeCd -= dt; this.vomitCd -= dt; this.puddleCd -= dt; this.summonCd -= dt;
    if(this.charging && this.state !== 'lunge'){ this.charging = false; }
    if(!this.charging && this.chargeCd <= 0){
      let cd = 9 - Math.min(3, (1-this.hp/this.maxHp)*3.5);
      if(isTrait('frenzied')) cd -= Math.min(3, (1-this.hp/this.maxHp)*3); // stacks on top of the baseline enrage
      this.chargeCd = Math.max(2.5, cd);
      this.telegraphT = 0.6;
      game.announce('⚠ Rotmaw inhales... ⚠');
    }
    if(this.vomitCd <= 0 && game.player){
      this.vomitCd = 5.5;
      const corrosive = isTrait('corrosive');
      const projColor = corrosive ? this.trait.glow : this.R.glow;
      const base = game.player.group.position.clone().setY(1).sub(this.group.position).normalize();
      for(let i=-2;i<=2;i++){
        const ang = i*0.16;
        const dir = new THREE.Vector3(base.x*Math.cos(ang)-base.z*Math.sin(ang), base.y, base.x*Math.sin(ang)+base.z*Math.cos(ang));
        game.spawnProjectile(this.group.position.clone().setY(this.group.position.y+1.2), dir, this.dmg*0.6, projColor, corrosive);
      }
      game.audio.spit();
    }
    if(this.puddleCd <= 0){
      const toxic = isTrait('toxic');
      this.puddleCd = 11;
      for(let i=0;i<(toxic?4:3);i++){
        const a = Math.random()*Math.PI*2, d = 3+Math.random()*6;
        const pp = this.group.position.clone().add(new THREE.Vector3(Math.cos(a)*d, 0, Math.sin(a)*d));
        game.spawnPuddle(pp, this.dmg*0.35, toxic?3.4:2.6, toxic?9:6);
      }
      game.audio.roar(0.4);
    }
    if(this.summonCd <= 0){
      this.summonCd = 14;
      game.audio.roar(1);
      for(let i=0;i<2;i++){
        const a = Math.random()*Math.PI*2;
        const p = this.group.position.clone().add(new THREE.Vector3(Math.cos(a)*8, 0, Math.sin(a)*8));
        game.spawnEnemy(Math.min(3, (Math.random()*4)|0), p, 1);
      }
      game.announce('Rotmaw burps up its brood!');
    }
  }
}

/* =============== PLAYER =============== */
export class Player {
  constructor(scene){
    this.scene = scene;
    const g = this.group = new THREE.Group();
    // body — stylized hunter
    const cloakMat = toonMat({ color:0x1f8f6e, rim:0.6, rimColor:0xc0ffb0 });
    const skinMat = toonMat({ color:0xf2c89a, rim:0.4 });
    const body = this.body = new THREE.Group();
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.55, 4, 8), cloakMat);
    torso.position.y = 0.95; addOutline(torso, 0.09);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.30, 12, 10), skinMat);
    head.position.y = 1.62; addOutline(head, 0.09);
    // hood / hat (mushroom cap hat!)
    const hat = new THREE.Mesh(new THREE.SphereGeometry(0.42, 12, 8, 0, Math.PI*2, 0, Math.PI*0.5),
      toonMat({ color:0xe63a2e, map:capTexture(0xe63a2e), rim:0.55 }));
    hat.position.y = 1.72; addOutline(hat, 0.09);
    // scarf
    const scarf = new THREE.Mesh(new THREE.TorusGeometry(0.28, 0.09, 6, 12), toonMat({color:0xffb52e, rim:0.4}));
    scarf.position.y = 1.38; scarf.rotation.x = Math.PI/2; addOutline(scarf, 0.1);
    // eyes
    for(const sx of [-1,1]){
      const e = new THREE.Mesh(new THREE.SphereGeometry(0.045,6,5), new THREE.MeshBasicMaterial({color:0x1c1410}));
      e.position.set(0.11*sx, 1.62, 0.27); body.add(e);
    }
    // arms & legs
    this.armR = new THREE.Group(); this.armL = new THREE.Group();
    const armGeo = new THREE.CapsuleGeometry(0.09, 0.4, 3, 6);
    const aR = new THREE.Mesh(armGeo, cloakMat); aR.position.y = -0.25; addOutline(aR, 0.12);
    const aL = aR.clone();
    this.armR.add(aR); this.armL.add(aL);
    this.armR.position.set(0.42, 1.25, 0); this.armL.position.set(-0.42, 1.25, 0);
    // ornate sword — one prebuilt hilt+blade variant per rarity tier, only the
    // equipped one visible; equipWeapon() swaps which is shown + retints the blade
    this.swordVariants = [0,1,2,3,4].map(r=>{
      const v = buildSwordVariant(r);
      v.group.position.set(0, -0.85, 0);
      v.group.visible = false;
      this.armR.add(v.group);
      return v;
    });
    this.blade = this.swordVariants[0].blade;
    this.legR = new THREE.Mesh(new THREE.CapsuleGeometry(0.11, 0.35, 3, 6), toonMat({color:0x3a2f4d, rim:0.3}));
    this.legL = this.legR.clone();
    this.legR.position.set(0.16, 0.35, 0); this.legL.position.set(-0.16, 0.35, 0);
    body.add(torso, head, hat, scarf, this.armR, this.armL, this.legR, this.legL);
    this.blob = makeBlobShadow(1.6); this.blob.position.y = 0.04;
    g.add(body, this.blob);
    scene.add(g);

    // attack arc effect
    this.arc = new THREE.Mesh(new THREE.RingGeometry(0.6, 2.4, 24, 1, 0, Math.PI*0.9),
      new THREE.MeshBasicMaterial({ color:0x9fefff, transparent:true, opacity:0, side:THREE.DoubleSide,
        blending:THREE.AdditiveBlending, depthWrite:false }));
    this.arc.rotation.x = -Math.PI/2;
    scene.add(this.arc);

    // stats
    this.maxHp = 100; this.hp = 100;
    this.baseDmg = 14; this.dmgMult = 1;
    this.speed = 8; this.speedMult = 1;
    this.vel = new THREE.Vector3(); this.vy = 0; this.grounded = true;
    this.jumps = 0; this.maxJumps = 1;
    this.moveInput = new THREE.Vector3();
    // item 03 — a jump press is a REQUEST, not an event: coyoteT keeps the ground you just left
    // valid, jumpBuf remembers a press made just before you land. onJump is the caller's cue hook,
    // fired whenever a jump actually leaves the ground (which may be a later frame than the press).
    this.coyoteT = 0; this.jumpBuf = 0; this.onJump = null;
    // item 04 — one squash scalar, eased back to 1 and applied volume-preserving
    this.squash = 1;
    this.dashCd = 0; this.dashMaxCd = 2.2; this.dashT = 0; this.dashDir = new THREE.Vector3();
    this.attackT = 0; this.attackDur = 0.3; this.combo = 0; this.comboWindow = 0;
    this.impactT = 0; this.atkDip = 0;
    this.iframe = 0;
    // orb-drop boosts are temporary: each pickup grants/extends a timer (seconds remaining)
    // instead of a permanent stat. dash-reset and hp-heal stay instant one-shot effects.
    this.boostTimers = { dmg:0, spd:0, shield:0, jump:0, magnet:0 };
    this.yaw = 0;
    this.animT = 0;
    // weapon inventory (found this hunt; resets each run — forge tiers persist in Progress)
    this.weapons = ['blade']; this.equipped = 'blade';
    // backpack potions (stack counts) + active booster timers (seconds remaining)
    this.potions = { power:0, haste:0, swift:0, vitality:0, fortify:0 };
    this.potionTimers = { power:0, haste:0, swift:0, fortify:0 };
    /* rings.js — the elemental ring slot. Per-run state, so it lives here and is discarded with
       the hunt, exactly like `potions` and unlike anything in progress.js. ONE slot: picking up a
       second ring replaces the first, which is the whole reason the HUD only ever has to show one
       charge bar. `ringCharge` is in SECONDS of holding remaining, so the bar the player reads and
       the number the drain subtracts are the same quantity. */
    this.elemRing = null;      // a RINGS entry, or null
    this.ringCharge = 0;       // seconds left. 0 with a ring set means spent-and-not-yet-cleared.
    // armor: one equipped id per slot + everything found this run (forge tiers persist in Progress)
    this.armor = { helmet:null, ring:null, charm:null };
    this.armorOwned = { helmet:[], ring:[], charm:[] };
    this.equipWeapon('blade');
  }
  addArmor(slot, id){
    if(!this.armorOwned[slot].includes(id)) this.armorOwned[slot].push(id);
  }
  equipArmor(slot, id, game){
    if(!this.armorOwned[slot].includes(id)) return;
    const oldId = this.armor[slot];
    const oldHp = oldId ? (ARMOR_BY_ID[oldId].hp||0) * game.progress.gearMultOf('armor', oldId) : 0;
    this.armor[slot] = id;
    const newHp = (ARMOR_BY_ID[id].hp||0) * game.progress.gearMultOf('armor', id);
    const delta = newHp - oldHp;
    if(delta !== 0){ this.maxHp += delta; this.hp = Math.min(this.maxHp, Math.max(1, this.hp + delta)); }
  }
  // sums a named stat (hp, dmgReduction, crit, atkSpeed, dmg, magnet, dropBonus, lifesteal)
  // across all three equipped pieces, each scaled by its own collection stars+level
  getArmorBonus(key, game){
    let sum = 0;
    for(const slot of ARMOR_SLOTS){
      const id = this.armor[slot]; if(!id) continue;
      const item = ARMOR_BY_ID[id];
      if(item[key]) sum += item[key] * game.progress.gearMultOf('armor', id);
    }
    return sum;
  }
  addWeapon(id){
    if(!this.weapons.includes(id)) this.weapons.push(id);
  }
  equipWeapon(id){
    if(!this.weapons.includes(id)) return;
    this.equipped = id;
    const w = WEAPONS_BY_ID[id];
    for(const v of this.swordVariants) v.group.visible = false;
    const variant = this.swordVariants[w.rarity];
    variant.group.visible = true;
    this.blade = variant.blade;
    this.blade.scale.set(w.geomScale.x, w.geomScale.y, w.geomScale.z);
    this.blade.material.color.set(w.color);
    this.blade.material.emissive.set(w.emissive);
  }
  addPotion(id){
    const def = POTIONS_BY_ID[id];
    this.potions[id] = Math.min(def.stackCap, (this.potions[id]||0) + 1);
  }
  usePotion(id, game){
    const def = POTIONS_BY_ID[id];
    if(!def || (this.potions[id]||0) <= 0) return false;
    this.potions[id]--;
    if(def.kind === 'heal') this.hp = Math.min(this.maxHp, this.hp + this.maxHp*def.heal);
    else this.potionTimers[id] = def.dur;
    game.audio.pickup();
    game.particles.burst(this.group.position.clone().setY(1.3), 14,
      { r:((def.color>>16)&255)/255, g:((def.color>>8)&255)/255, b:(def.color&255)/255, spread:3, size:8, life:0.7 });
    return true;
  }
  getMaxJumps(){ return this.maxJumps + (this.boostTimers.jump > 0 ? 1 : 0); }
  /* item 03 — THE jump entry point. main.js's tryJump() should call this and nothing else: it
     remembers the press for JUMP_BUF seconds, so a jump pressed a frame before touchdown fires on
     the landing frame instead of being dropped. Returns true if it left the ground right now; a
     false return is not a rejection, it may still fire within the buffer window — which is why
     the audio/particle cue belongs on onJump, not on the return value. */
  bufferJump(){
    this.jumpBuf = JUMP_BUF;
    return this._consumeJump();
  }
  _consumeJump(){
    if(this.jumpBuf <= 0) return false;
    // the ground you left less than COYOTE ago still counts, and costs no air jump
    const fromGround = this.grounded || this.coyoteT > 0;
    if(!fromGround && this.jumps >= this.getMaxJumps()) return false;
    this.jumps = fromGround ? 1 : this.jumps + 1;
    this.vy = JUMP_VY;
    this.grounded = false; this.coyoteT = 0; this.jumpBuf = 0;
    this.squash = 1.22;                       // stretch on launch
    if(this.onJump) this.onJump(this);
    return true;
  }
  /* item 04 — one chokepoint for every touchdown, so a landing reads the same however you got
     there. Gated on vy so walking downhill (which peaks around -8) never squashes. */
  land(vy, game){
    if(vy > LAND_HARD) return;
    this.squash = 0.72;
    const p = this.group.position;
    for(let i=0;i<5;i++)
      game.particles.spawn(p.x+(Math.random()-0.5)*1.1, p.y+0.15, p.z+(Math.random()-0.5)*1.1,
        {r:0.85,g:0.8,b:0.7, spread:1.6, size:7, life:0.4, vy:1.1, drag:0.94});
    if(game.audio.land) game.audio.land();
    else { game.audio.beep(96, 0.13, 'sine', 0.17, 52); game.audio.hiss(0.09, 0.1, 180, 900); }
    game.shake(0.16);
  }
  /* item 02 — horizontal movement goes through here instead of straight into the transform, which
     is what makes a prop solid at all. Long frames and dashes (3.4x walk speed) are split into
     sub-PLAYER_R steps: a single 1.4-unit hop can straddle a whole trunk, and tunnelling through a
     tree is the one bug that makes collision look absent. */
  moveHoriz(mx, mz){
    const g = this.group;
    const d = Math.hypot(mx, mz);
    if(d < 1e-6) return;
    // escape valve: if we are ALREADY inside a column (spawned in it, knocked into it) every
    // candidate reads blocked and the player would be frozen. Only ever refuse a step that leaves
    // clear ground for a wall.
    if(surfaceAt(g.position.x, g.position.z, g.position.y).blocked){ g.position.x += mx; g.position.z += mz; return; }
    const n = d > PLAYER_R ? Math.ceil(d/PLAYER_R) : 1;
    const sx = mx/n, sz = mz/n;
    for(let i=0;i<n;i++){
      const feetY = g.position.y;
      if(this.tryStep(g.position.x+sx, g.position.z+sz, feetY, sx, sz)){
        g.position.x += sx; g.position.z += sz;
        continue;
      }
      // blocked diagonal: retry each axis alone, so we slide along the wall instead of stopping
      // dead against it. Order matters — the z test uses the x result, so a corner resolves once.
      let slid = false;
      if(sx !== 0 && this.tryStep(g.position.x+sx, g.position.z, feetY, sx, 0)){ g.position.x += sx; slid = true; }
      else this.vel.x = 0;
      if(sz !== 0 && this.tryStep(g.position.x, g.position.z+sz, feetY, 0, sz)){ g.position.z += sz; slid = true; }
      else this.vel.z = 0;
      if(!slid) break;                        // flat into a corner: stop, don't grind
    }
  }
  /* Resolve one candidate foot position. The forward probe is what stops the shoulders sinking
     into a rock face: the centre sample alone lets a body radius of geometry overlap first.
     NOTE: terrain height is never a wall for the player, only colliders are — a bowl you can walk
     down into has to stay walkable out of, and the ravine keeps its climbable banks. Prop tops
     under STEP are climbed by surfaceAt itself, and the vertical resolve lifts the feet onto them. */
  tryStep(nx, nz, feetY, dx, dz){
    const dl = Math.hypot(dx, dz);
    if(dl > 1e-6){
      const k = PLAYER_R/dl;
      if(surfaceAt(nx + dx*k, nz + dz*k, feetY).blocked) return false;
    }
    return !surfaceAt(nx, nz, feetY).blocked;
  }
  /* item 11 — head collision against spore pods. A crossing test, not a distance test: the crown
     has to pass through the pod's underside plane during THIS frame, travelling upward. A
     proximity check would also burst a pod you merely walked past. */
  headBonk(prevY, game){
    const g = this.group;
    const prevHead = prevY + PLAYER_H, headY = g.position.y + PLAYER_H;
    for(let i=0;i<HEAD_HITS.length;i++){
      const o = HEAD_HITS[i];
      if(o.off) continue;
      if(prevHead > o.bot || headY < o.bot) continue;
      const dx = g.position.x - o.x, dz = g.position.z - o.z, rr = (o.r || 1) + PLAYER_R*0.55;
      if(dx*dx + dz*dz > rr*rr) continue;
      // clamp just under it and bonk back down, so the impact reads instead of the head sliding
      // up through the pod on the next frame
      g.position.y = o.bot - PLAYER_H - 0.01;
      this.vy = -2;
      this.squash = 1.28;
      if(o.onHead) o.onHead(this, game);
      return o;                               // one pod per frame — the bonk kills our rise anyway
    }
    return null;
  }
  getMagnet(game){ return (this.boostTimers.magnet > 0 ? 2.2 : 0) + (game ? this.getArmorBonus('magnet', game) : 0); }
  hurt(dmg, from, game){
    if(this.iframe > 0 || this.dashT > 0 || game.state !== 'play') return;
    if(this.boostTimers.shield > 0){
      game.audio.shieldBreak(); game.updateBuffs();
      game.particles.burst(this.group.position.clone().setY(1.2), 16, {r:0.5,g:0.9,b:1, spread:4, size:8, life:0.6});
      this.iframe = 0.4; return;
    }
    if(this.potionTimers.fortify > 0) dmg = Math.round(dmg * (1 - POTIONS_BY_ID.fortify.reduce));
    const armorReduce = Math.min(0.6, this.getArmorBonus('dmgReduction', game)); // capped so armor can't zero out damage
    if(armorReduce > 0) dmg = Math.round(dmg * (1 - armorReduce));
    this.hp -= dmg; this.iframe = 0.8;
    game.audio.hurt(); game.shake(0.45); game.damageFlash();
    game.particles.burst(this.group.position.clone().setY(1.2), 12, {r:1,g:0.3,b:0.2, spread:4, size:8, life:0.6});
    const dir = this.group.position.clone().sub(from).setY(0).normalize();
    this.vel.addScaledVector(dir, 10);
    if(this.hp <= 0){ this.hp = 0; game.gameOver(); }
  }
  startDash(game){
    if(this.dashCd > 0) return;
    this.dashCd = this.dashMaxCd; this.dashT = 0.28;
    const f = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    this.dashDir.copy(this.moveInput.lengthSq() > 0.01 ? this.moveInput.clone().normalize() : f);
    game.audio.dash();
    game.particles.burst(this.group.position.clone().setY(1), 14, {r:0.7,g:0.95,b:1, spread:2, size:9, life:0.4});
  }
  attack(game){
    // allow chaining only once the current swing is past its apex (recover phase)
    if(this.attackT > this.attackDur*0.55) return;
    if(this.comboWindow <= 0) this.combo = 0;
    this.combo = (this.combo % 3) + 1;
    this.comboWindow = 0.9;
    const wSpd = WEAPONS_BY_ID[this.equipped].atkSpeed;
    const hasteMult = this.potionTimers.haste > 0 ? (1/POTIONS_BY_ID.haste.mult) : 1;
    const armorSpdMult = 1 / (1 + this.getArmorBonus('atkSpeed', game));
    this.attackDur = (this.combo === 3 ? 0.44 : 0.32) * wSpd * hasteMult * armorSpdMult;
    this.attackT = this.attackDur;
    this.didHit = false;
    game.audio.swing(this.combo);
  }
  update(dt, game){
    const g = this.group;
    this.animT += dt;
    this.iframe = Math.max(0, this.iframe - dt);
    this.dashCd = Math.max(0, this.dashCd - dt);
    this.comboWindow = Math.max(0, this.comboWindow - dt);
    for(const k in this.potionTimers) if(this.potionTimers[k] > 0) this.potionTimers[k] = Math.max(0, this.potionTimers[k] - dt);
    for(const k in this.boostTimers) if(this.boostTimers[k] > 0) this.boostTimers[k] = Math.max(0, this.boostTimers[k] - dt);
    this.squash += (1 - this.squash) * Math.min(1, dt*SQUASH_EASE);

    // movement
    const input = this.moveInput;
    const spd = this.speed * this.speedMult * (this.potionTimers.swift > 0 ? POTIONS_BY_ID.swift.mult : 1) * (this.boostTimers.spd > 0 ? 1.3 : 1);
    if(this.dashT > 0){
      this.dashT -= dt;
      this.vel.x = this.dashDir.x * spd * 3.4;
      this.vel.z = this.dashDir.z * spd * 3.4;
      if(Math.random()<0.6) game.particles.spawn(g.position.x, g.position.y+0.8, g.position.z,
        {r:0.6,g:0.9,b:1, spread:1.5, size:7, life:0.35});
    } else {
      const accel = this.grounded ? 40 : 18;
      this.vel.x += (input.x*spd - this.vel.x) * Math.min(1, accel*dt/spd*8);
      this.vel.z += (input.z*spd - this.vel.z) * Math.min(1, accel*dt/spd*8);
      if(this.grounded && input.lengthSq()<0.01){ this.vel.x *= Math.pow(0.0001,dt); this.vel.z *= Math.pow(0.0001,dt); }
    }
    this.moveHoriz(this.vel.x*dt, this.vel.z*dt);
    // playable ring: clamp x/z only. multiplyScalar() here scaled y too, which quietly sank the
    // player into the terrain whenever they touched the map edge.
    const bd = Math.hypot(g.position.x, g.position.z);
    if(bd > 195){ const k = 195/bd; g.position.x *= k; g.position.z *= k; }

    // gravity / jump / ground (items 02, 03, 11)
    const wasGrounded = this.grounded;
    const gy = surfaceAt(g.position.x, g.position.z, g.position.y).h;  // shared obj: read at once
    this.coyoteT = Math.max(0, this.coyoteT - dt);
    this.jumpBuf = Math.max(0, this.jumpBuf - dt);
    this.vy -= 30*dt;
    const prevY = g.position.y;
    g.position.y += this.vy*dt;
    if(this.vy > 0 && HEAD_HITS.length) this.headBonk(prevY, game);
    if(g.position.y <= gy){
      const impact = this.vy;
      g.position.y = gy; this.vy = 0;
      if(!wasGrounded) this.land(impact, game);
      this.grounded = true; this.jumps = 0; this.coyoteT = 0;
    } else if(this.vy < 0 && wasGrounded && g.position.y - gy <= SNAP_DOWN){
      // downslope stick: a hill crest must not fling you. Only reachable from a grounded frame,
      // so it can never swallow a real jump or shorten a fall.
      g.position.y = gy; this.vy = 0; this.grounded = true; this.jumps = 0;
    } else {
      if(wasGrounded) this.coyoteT = COYOTE;         // just walked off something
      this.grounded = false;
      // once the coyote window lapses unused, the ground jump is SPENT — otherwise stepping off a
      // ledge silently hands out a free extra jump for the rest of the fall.
      if(this.coyoteT <= 0 && this.jumps === 0) this.jumps = 1;
    }
    if(this.jumpBuf > 0) this._consumeJump();        // buffered press fires on the landing frame

    // face movement dir
    if(input.lengthSq() > 0.01){
      const targetYaw = Math.atan2(input.x, input.z);
      this.yaw += (((targetYaw - this.yaw + Math.PI*3) % (Math.PI*2)) - Math.PI) * Math.min(1, dt*12);
      g.rotation.y = this.yaw;
    }

    // attack anim + hit — procedural 3-hit combo: wind-up → swing → recover
    this.impactT = Math.max(0, this.impactT - dt);
    this.atkDip = 0;
    if(this.attackT > 0){
      this.attackT -= dt;
      const p = 1 - Math.max(0, this.attackT)/this.attackDur;
      const side = this.combo === 2 ? -1 : 1;   // combos 1/3 sweep right→left, combo 2 left→right
      const W = 0.24, S = 0.62;                  // wind-up end / swing end (normalized time)
      let armX = 0, armZ = 0, twist = 0;
      if(p < W){
        // wind-up: blade back, torso coiled, slight crouch
        const e = p/W, s = e*e*(3-2*e);
        armX = -2.4*s; armZ = 0.7*side*s; twist = 0.75*side*s;
        this.atkDip = 0.09*s;
        this.arc.material.opacity *= 0.6;
      } else if(p < S){
        // swing: snappy ease-out sweep, torso whips through, forward lunge
        const q = (p-W)/(S-W), e = 1-Math.pow(1-q, 3);
        if(this.combo === 3){ armX = -2.4 + 3.5*e; armZ = 0.7*side*(1-e); }
        else { armX = -2.0 + 1.6*e; armZ = (0.7 - 2.6*e)*side; }
        twist = (0.75 - 1.6*e)*side;
        _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        const lunge = (this.combo === 3 ? 30 : 18) * (1-q);
        this.vel.x += _fwd.x*lunge*dt; this.vel.z += _fwd.z*lunge*dt;
        // swing arc fx follows the blade sweep
        this.arc.position.copy(g.position); this.arc.position.y += 0.9;
        this.arc.rotation.x = -Math.PI/2 + (this.combo===3 ? 0.9 : 0.15);
        this.arc.rotation.z = -this.yaw + (1.2 - 2.4*e)*side;
        this.arc.material.opacity = Math.sin(q*Math.PI)*0.9;
        this.arc.scale.setScalar(1 + q*0.25 + (this.combo===3?0.35:0));
        // glowing blade trail
        _tip.set(0,-1.3,0); this.blade.localToWorld(_tip);
        game.particles.spawn(_tip.x, _tip.y, _tip.z, {r:0.55,g:0.95,b:1, spread:0.4, size:8, life:0.35});
      } else {
        // recover: ease back to neutral from the follow-through pose
        const q = (p-S)/(1-S), e = 1-Math.pow(1-q, 2), k = 1-e;
        if(this.combo === 3){ armX = 1.1*k; armZ = 0; }
        else { armX = -0.4*k; armZ = -1.9*side*k; }
        twist = -0.85*side*k;
        this.arc.material.opacity *= 0.65;
      }
      this.armR.rotation.x = armX; this.armR.rotation.z = armZ;
      this.body.rotation.y = twist;
      // hit registers at the apex of the swing (mid-sweep)
      if(!this.didHit && p > 0.42){
        this.didHit = true;
        const wdef = WEAPONS_BY_ID[this.equipped];
        const wGearMult = game.progress.gearMultOf('weapon', this.equipped);
        const powerMult = this.potionTimers.power > 0 ? POTIONS_BY_ID.power.mult : 1;
        const orbDmgMult = this.boostTimers.dmg > 0 ? 1.3 : 1;
        const armorDmgMult = 1 + this.getArmorBonus('dmg', game);
        const armorCrit = this.getArmorBonus('crit', game);
        const armorLifesteal = this.getArmorBonus('lifesteal', game);
        // combo-3 is each weapon's unique finisher, not just a bigger number
        const isFinisher = this.combo === 3;
        const fin = wdef.finisher;
        const finisherDmgMult = (isFinisher && fin && fin.type==='devour') ? (1+fin.mult) : 1;
        const dmgBase = (this.baseDmg + wdef.dmg) * this.dmgMult * wGearMult * powerMult * orbDmgMult * armorDmgMult * finisherDmgMult * (this.combo===3 ? 2.2 : 1);
        let arcDot = wdef.special && wdef.special.type==='cleave' ? 0.25 - wdef.special.arc : 0.25;
        let extraRange = 0;
        if(isFinisher && fin){
          if(fin.type==='sweep') arcDot -= fin.arcBonus;
          if(fin.type==='pierce') extraRange = fin.extraRange;
        }
        _fwd.set(Math.sin(this.yaw),0,Math.cos(this.yaw));
        let hitAny = false, critAny = false, killedAny = false;
        const hitList = [];
        for(const e of game.enemies){
          if(e.dead) continue;
          _to.copy(e.group.position).sub(g.position); _to.y = 0;
          const d = _to.length();
          if(d < 1.9 + wdef.range + extraRange + 1.6*e.R.scale && _to.normalize().dot(_fwd) > arcDot){
            const crit = Math.random() < 0.15 + wdef.crit + armorCrit;
            let dmg = Math.round(dmgBase * (0.9+Math.random()*0.2) * (crit?1.8:1));
            if(wdef.special && wdef.special.type==='execute' && e.hp/e.maxHp < wdef.special.threshold)
              dmg = Math.round(dmg * (1+wdef.special.bonus));
            let kbMult = wdef.knockback;
            if(isFinisher && fin && fin.type==='sweep') kbMult *= fin.knockMult;
            e.hit(dmg, g.position, game, kbMult);
            if(e.dead) killedAny = true;
            if(wdef.special && wdef.special.type==='lifesteal')
              this.hp = Math.min(this.maxHp, this.hp + dmg*wdef.special.amt);
            if(armorLifesteal > 0)
              this.hp = Math.min(this.maxHp, this.hp + dmg*armorLifesteal);
            if(game.addXP) game.addXP(e.isBoss ? 'boss' : e.rarity);
            _tip.copy(e.group.position); _tip.y += 2*e.R.scale;
            game.damageNumber(_tip, dmg, crit, false, e);   // keyed on the enemy: a combo is ONE growing number
            // one per ENEMY struck, not one per swing: see the rule list on game.comboHit
            if(game.comboHit) game.comboHit({ crit, killed: e.dead });
            hitAny = true; if(crit) critAny = true;
            hitList.push(e);
          }
        }
        if(hitAny){
          game.audio.hit(); game.hitStop(this.combo===3?0.09:0.05);
          game.shake(this.combo===3?0.35:0.18);
          this.impactT = 0.16; // squash on impact
          if(isFinisher && fin){
            game.particles.burst(g.position.clone().setY(1.3), 16,
              {r:((wdef.color>>16)&255)/255, g:((wdef.color>>8)&255)/255, b:(wdef.color&255)/255, spread:4, size:9, life:0.6});
            if(fin.type==='burst'){
              for(const e of game.enemies){
                if(e.dead || hitList.includes(e)) continue;
                if(e.group.position.distanceTo(g.position) < fin.radius){
                  const dmg2 = Math.round(dmgBase*fin.mult);
                  e.hit(dmg2, g.position, game, 1);
                  _tip.copy(e.group.position); _tip.y += 2*e.R.scale;
                  // FIVE args. Passing `e` into the `isPlayer` slot (the bug this replaces) made the
                  // collateral number key on PLAYER_KEY and take the .player class, so a burst that
                  // caught a second enemy printed its damage in the player-damage red AND added it
                  // into the same floating node as the player's own HP loss.
                  game.damageNumber(_tip, dmg2, false, false, e);
                  if(game.comboHit) game.comboHit({ killed: e.dead });
                }
              }
            } else if(fin.type==='chainhit' && critAny){
              this.attackT = 0; // next click chains immediately instead of waiting out recovery
            } else if(fin.type==='heal'){
              this.hp = Math.min(this.maxHp, this.hp + this.maxHp*fin.healFrac);
              this.boostTimers.spd = Math.max(this.boostTimers.spd, fin.spdDur);
            } else if(fin.type==='nova'){
              for(let i=0;i<fin.count;i++){
                const ang = (i/fin.count)*Math.PI*2;
                // friendly: this is the PLAYER's nova. Shared pool with the boss barrage, so the
                // flag is the only thing that decides who it can hit — see spawnProjectile.
                game.spawnProjectile(g.position.clone().setY(g.position.y+1),
                  new THREE.Vector3(Math.sin(ang),0,Math.cos(ang)), Math.round(dmgBase*fin.mult), wdef.color,
                  false, true);
              }
            } else if(fin.type==='devour' && killedAny){
              this.hp = Math.min(this.maxHp, this.hp + this.maxHp*fin.killHealFrac);
            }
          }
        }
        if(isFinisher && fin && fin.type==='shockwave'){
          // friendly: the PLAYER's shockwave. Same shared pool as the boss ring burst.
          game.spawnRing(g.position.clone(), Math.round(dmgBase*fin.mult), wdef.color, 0, true);
          game.audio.hit(); game.shake(0.4);
        }
      }
    } else {
      this.arc.material.opacity *= 0.7;
      this.armR.rotation.x *= 0.8; this.armR.rotation.z *= 0.8;
      this.body.rotation.y *= 0.8;
    }
    // item 04 — vertical squash & stretch composed with the attack-impact squash, not fighting it.
    // `squash` is one scalar (1.22 jump / 0.72 hard landing / 1.28 head bonk) eased back to 1 and
    // applied as (1/sqrt(s), s, 1/sqrt(s)) so the silhouette keeps its mass instead of ballooning;
    // the attack impact keeps its own bolder hand-tuned numbers multiplied on top.
    { const k = this.impactT/0.16, im = k*k, s = this.squash, lat = (1/Math.sqrt(s))*(1+0.26*im);
      this.body.scale.set(lat, s*(1-0.3*im), lat); }

    // run animation
    const runAmt = Math.min(1, Math.hypot(this.vel.x, this.vel.z)/spd);
    const rt = this.animT * 11;
    this.legR.rotation.x = Math.sin(rt)*0.9*runAmt;
    this.legL.rotation.x = -Math.sin(rt)*0.9*runAmt;
    if(this.attackT <= 0) this.armR.rotation.x = -Math.sin(rt)*0.7*runAmt;
    this.armL.rotation.x = Math.sin(rt)*0.7*runAmt;
    this.body.position.y = Math.abs(Math.sin(rt))*0.12*runAmt + Math.sin(this.animT*2.2)*0.03 - this.atkDip;
    this.body.rotation.z = Math.sin(rt)*0.05*runAmt;
    if(!this.grounded){ this.legR.rotation.x = 0.5; this.legL.rotation.x = -0.3; }

    // iframe blink
    this.body.visible = this.iframe <= 0 || Math.sin(this.animT*40) > 0;
    // shadow tracks the surface we are standing over, prop tops included
    this.blob.position.y = 0.04 - (g.position.y - surfaceAt(g.position.x, g.position.z, g.position.y).h);
  }
}

/* =============== POWERUPS =============== */
export const POWERUPS = [
  { id:'dmg',    icon:'⚔️', name:'+Damage',      color:0xff6b5a, w:20 },
  { id:'spd',    icon:'💨', name:'+Move Speed',  color:0x6bd8ff, w:18 },
  { id:'dash',   icon:'⚡', name:'Dash Reset',   color:0xffe066, w:14 },
  { id:'shield', icon:'🛡️', name:'Shield',       color:0x6bff9e, w:14 },
  { id:'jump',   icon:'🕊️', name:'Double Jump',  color:0xd8a6ff, w:10 },
  { id:'magnet', icon:'🧲', name:'Spore Magnet', color:0xff9adf, w:10 },
  { id:'hp',     icon:'❤️', name:'Max HP Up',    color:0xff5a5a, w:14 },
];
/* Every live drop registers here so a NEW drop can see what is already on the ground.
   INVARIANT (the bug this exists to prevent): three additive layers per drop is fine, nine is
   paper. One rare+ kill drops essence AND a coin AND possibly a weapon/potion/powerup, and they
   scatter into a couple of metres of each other — so the 9 m pillar, the layer with by far the
   most screen area, is the one that gets suppressed when it would be stacking on a neighbour.
   Entries are pruned by "left the scene", not by an unregister call, so resetRun() wiping
   game.powerups can never leak them. */
const _liveDrops = [];
const DROP_CROWD = 1.5;      // metres. Below this two pillars overlap for most of the camera arc.
function _pruneDrops(){
  for(let i=_liveDrops.length-1;i>=0;i--){
    const d = _liveDrops[i];
    if(d.dead || !d.group.parent) _liveDrops.splice(i,1);
  }
}
/* SHARED DROP GEOMETRY. Every Powerup used to build five fresh geometries — orb, outline hull,
   halo sphere, light pillar, ground ring — and four fresh materials, and nothing ever disposed
   any of it. Two problems in one place:
     - WASTE: the halo, pillar and ring are byte-identical for every drop in the game, and the orb
       has only four variants. Measured mid-run with 90 uncollected drops on the ground,
       renderer.info.memory.geometries stood at 1368.
     - LEAK: three.js frees GPU buffers on dispose() and nowhere else. A collected drop was removed
       from the scene and filtered out of the array, but its five geometries and four materials
       stayed resident for the life of the page. ~10 drops a kill over a 40-kill run is hundreds of
       orphaned buffers; it only escaped notice because a new hunt is a full page reload.
   Geometry is pure shape here — nothing is ever mutated per drop, only the mesh transform — so it
   shares safely. INVARIANT: because these are shared, a Powerup must NEVER dispose them; retire()
   below disposes only the per-drop materials, which have to stay per-drop because they carry the
   drop's colour. This is the same rule fauna.js's sharedGeo() carries, for the same reason. */
let DROP_GEO = null;
function dropGeo(){
  if(DROP_GEO) return DROP_GEO;
  DROP_GEO = {
    // shape reads the drop's kind at a glance: coin = flat spinning disc, gem = faceted essence,
    // ring = a torus, whose hole is identifiable from the silhouette alone at pickup distance,
    // orb = the default boost
    coin: new THREE.CylinderGeometry(0.38, 0.38, 0.09, 14),
    gem:  new THREE.OctahedronGeometry(0.36, 0),
    ring: new THREE.TorusGeometry(0.30, 0.11, 8, 16),
    orb:  new THREE.IcosahedronGeometry(0.5, 1),
    halo: new THREE.SphereGeometry(0.62, 10, 8),
    pillar: new THREE.CylinderGeometry(0.18, 0.32, 9, 10, 1, true),
    ground: new THREE.RingGeometry(0.7, 1.05, 24),
  };
  return DROP_GEO;
}

export class Powerup {
  constructor(scene, pos, def){
    this.def = def; this.scene = scene; this.dead = false; this.t = Math.random()*7;
    const g = this.group = new THREE.Group();
    const G = dropGeo();
    const orbGeo = G[def.shape] || G.orb;
    const orb = new THREE.Mesh(orbGeo,
      toonMat({ color:def.color, emissive:def.color, emissiveIntensity:0.9, rim:0.9 }));
    addOutline(orb, 0.08);         // shares orb's geometry AND fx's module-level outline material
    const halo = new THREE.Mesh(G.halo,
      new THREE.MeshBasicMaterial({ color:def.color, transparent:true, opacity:0.10,
        blending:THREE.AdditiveBlending, depthWrite:false }));
    // rarity-colored light pillar — visible across the map
    const pillar = new THREE.Mesh(G.pillar,
      new THREE.MeshBasicMaterial({ color:def.color, transparent:true, opacity:0.11,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
    pillar.position.y = 3.5;
    // spinning ground ring
    const ring = new THREE.Mesh(G.ground,
      new THREE.MeshBasicMaterial({ color:def.color, transparent:true, opacity:0.55,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
    ring.rotation.x = -Math.PI/2; ring.position.y = -0.85;
    // no real PointLight here on purpose: every kill can spawn several of these
    // (essence + coin + maybe weapon/potion/powerup) and three.js recompiles shader
    // programs whenever the scene's active light count changes, which is exactly
    // the "lag right after killing" hitch — the emissive orb + additive halo/pillar/ring
    // already read as glowing without paying that cost
    g.add(orb, halo, pillar, ring);
    this.orb = orb; this.halo = halo; this.pillar = pillar; this.ring = ring;
    this.c = new THREE.Color(def.color);
    this.shape = def.shape;
    // scatter: pop outward from the kill point to a random nearby spot, so every
    // drop has to be walked to rather than landing exactly underfoot
    const scatterA = Math.random()*Math.PI*2;
    const scatterDist = 1.8 + Math.random()*3.8;
    this.scatterFrom = pos.clone();
    const tx = pos.x + Math.cos(scatterA)*scatterDist, tz = pos.z + Math.sin(scatterA)*scatterDist;
    this.scatterTo = new THREE.Vector3(tx, groundHeight(tx,tz) + (pos.y - groundHeight(pos.x,pos.z)), tz);
    this.scatterT = 0; this.scatterDur = 0.35 + Math.random()*0.2;
    // the pillar is decided against where this drop LANDS, not where the kill happened, because
    // the scatter is what actually determines whether two of them share a metre of ground
    _pruneDrops();
    for(const d of _liveDrops){
      const t = d.scatterTo || d.group.position;
      const dx = t.x - tx, dz = t.z - tz;
      if(dx*dx + dz*dz < DROP_CROWD*DROP_CROWD){ pillar.visible = false; break; }
    }
    _liveDrops.push(this);
    g.position.copy(this.scatterFrom);
    this.baseY = this.scatterTo.y;
    scene.add(g);
  }
  /* THE one exit. Removes the group and disposes the four per-drop materials — and ONLY the
     materials: the geometries are shared by every other drop in the world (see dropGeo), so
     disposing one here would empty every drop built afterwards. Idempotent, because a drop can be
     picked up and then swept again by resetRun. */
  retire(){
    if(this._retired) return;
    this._retired = true;
    this.dead = true;
    if(this.group.parent) this.group.parent.remove(this.group);
    for(const m of [this.orb, this.halo, this.pillar, this.ring]){
      if(m && m.material && m.material.dispose) m.material.dispose();
    }
  }
  update(dt, game){
    this.t += dt;
    const gp = this.group.position;
    if(this.scatterT < this.scatterDur){
      this.scatterT += dt;
      const p = Math.min(1, this.scatterT/this.scatterDur);
      const e = 1 - Math.pow(1-p, 3);
      gp.lerpVectors(this.scatterFrom, this.scatterTo, e);
      gp.y = THREE.MathUtils.lerp(this.scatterFrom.y, this.scatterTo.y, e) + Math.sin(p*Math.PI)*1.3;
      this.orb.rotation.y += dt*12; this.orb.rotation.x += dt*7;
      return; // can't be picked up mid-flight — you have to go get it once it lands
    }
    const pp = game.player.group.position;
    // bob + spin
    this.orb.rotation.y += dt*3; this.orb.rotation.x += (this.shape==='coin'?dt*4:dt*1.3);
    this.ring.rotation.z += dt*1.5;
    const pulse = 1 + Math.sin(this.t*4)*0.08;
    this.orb.scale.setScalar(pulse);
    this.halo.material.opacity = 0.08 + Math.sin(this.t*4)*0.03;
    if(this.pillar.visible) this.pillar.material.opacity = 0.09 + Math.sin(this.t*3)*0.03;
    // sparkle particles
    if(Math.random() < dt*7){
      game.particles.spawn(gp.x+(Math.random()-0.5)*1.2, gp.y+(Math.random()-0.5)*1.4, gp.z+(Math.random()-0.5)*1.2,
        {r:this.c.r, g:this.c.g, b:this.c.b, spread:0.5, size:2.0, life:0.8, vy:1.2, drag:0.99, alpha:0.5});
    }
    // magnet pull (stronger/further with an active Spore Magnet booster)
    _to.copy(pp); _to.y += 1;
    const d = gp.distanceTo(_to);
    const magnet = game.player.getMagnet(game);
    const magnetR = (3.0 + magnet*3.5) * (1 + (game.player.magnetBoost||0));
    if(d < magnetR){
      const pull = (14 + magnet*10) * (1 + (game.player.magnetBoost||0)) / Math.max(d, 0.6);
      gp.lerp(_to, Math.min(1, dt*pull));
      this.baseY = gp.y; // follow while flying
    } else {
      gp.y = this.baseY + Math.sin(this.t*2.5)*0.35;
    }
    // applyPowerup FIRST, then retire: the payout reads this.def, and retire() is what frees the
    // per-drop materials — doing it the other way round would hand the payout a torn-down drop.
    if(d < 1.6){ game.applyPowerup(this.def); this.retire(); }
  }
}
