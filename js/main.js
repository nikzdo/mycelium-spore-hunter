// main.js — MYCELIUM: Spore Hunter — game orchestration
import * as THREE from 'three';
import { ParticlePool, RewardPops, FrameMarks, glowTexture } from './fx.js';
import { buildWorld, groundHeight, groundOnly, COLLIDERS, PARAMS as WORLD_PARAMS } from './world.js';
import { Mushroom, Boss, GluttonBoss, Player, Powerup, POWERUPS, RARITIES, clearHeadHits } from './entities.js';
import { buildInteractiveProps, PROP_PARAMS } from './props.js';
import { buildFauna, FAUNA } from './fauna.js';
import { GameAudio } from './audio.js';
import { mulberry32, deriveSeed, randomSeed } from './rng.js';
import { Progress, MUTATIONS, XP_PER_HIT, XP_PER_BOSS_HIT, xpForLevel, depthMult,
  questKind } from './progress.js';
import { WEAPONS, WEAPONS_BY_ID } from './weapons.js';
import { ARMOR, ARMOR_BY_ID, ARMOR_SLOTS, SLOT_ICON } from './armor.js';
import { POTIONS, POTIONS_BY_ID } from './potions.js';
import { RINGS, RINGS_BY_ID, RING_KEY, RING_KEY_LABEL } from './rings.js';
import { SPECIES_BY_ID, hexCss } from './mushrooms.js';
import { rollBossTrait } from './bossTraits.js';

const PARAMS = new URLSearchParams(location.search);
const DEMO = PARAMS.has('demo');
const QUALITY = parseFloat(PARAMS.get('q') || '1');
const SEED = (parseInt(PARAMS.get('seed')) >>> 0) || randomSeed();

// navigate to a fresh procedural world (full reload = clean rebuild)
function rerollWorld(){
  const q = new URLSearchParams(location.search);
  q.set('seed', randomSeed());
  location.search = q.toString();
}

/* ================= renderer ================= */
const renderer = new THREE.WebGLRenderer({ antialias:true, preserveDrawingBuffer: DEMO });
renderer.setPixelRatio(DEMO ? 1 : Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
/* ---- sun shadows (item 06) ----
   Every shadow decision is made HERE, before the first frame. Flipping shadowMap.enabled or
   resizing the map after materials have compiled invalidates every program in the scene, which
   is the same hitch as adding a light mid-run — so the tier is picked from QUALITY once and
   never touched again. `?shadows=off|low|med|high` overrides it for testing on weak GPUs. */
const SHADOW_SIZES = { off:0, low:512, med:1024, high:2048 };
const SHADOW_TIER = SHADOW_SIZES[PARAMS.get('shadows')] !== undefined ? PARAMS.get('shadows')
  : QUALITY >= 1 ? 'high' : QUALITY >= 0.7 ? 'med' : QUALITY > 0 ? 'low' : 'off';
const SHADOW_SIZE = SHADOW_SIZES[SHADOW_TIER];
renderer.shadowMap.enabled = SHADOW_SIZE > 0;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.getElementById('game').appendChild(renderer.domElement);
window.__renderer = renderer; // for verification

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8b07a);
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1200);
window.__camera = camera; // for verification
addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// item 50: generation is one long blocking frame, so it can't run during module eval any more —
// the #boot overlay has to paint FIRST. boot() below builds the world and starts the loop.
let world = null;
const particles = new ParticlePool(scene, 700);
// item 19: one pool for every payout, so a coin, an essence and a contract payout all read
// as the same "you got paid" beat.
const rewardPops = new RewardPops(scene);
const audio = new GameAudio();
const progress = new Progress(); // meta progression (essences + mutations, localStorage)

/* ================= projectiles & rings ================= */
const projPool = [];
const projGeo = new THREE.SphereGeometry(0.28, 8, 6);
const PROJ_HALO_OP = 0.35;          // the FAR value; the near fade in the update loop scales it
const PROJ_HALO_NEAR = 0.7, PROJ_HALO_FULL = 3.0;   // metres: fully faded / fully lit
function spawnProjectile(pos, dir, dmg, color, corrosive=false){
  let p = projPool.find(p=>!p.active);
  if(!p){
    if(projPool.length > 40) return;
    const mesh = new THREE.Mesh(projGeo, new THREE.MeshBasicMaterial({ color:0xffffff }));
    /* Billboard carrying fx.glowTexture(), not a sphere shell. A shell is something the lens can
       end up INSIDE — a projectile flies straight at the camera by design — and once it does, a
       flat-alpha additive layer paints the whole viewport. The near fade below is the other half:
       a quad whose world size we own still fills the frame at 30 cm. */
    const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map:glowTexture(),
      transparent:true, opacity:PROJ_HALO_OP, blending:THREE.AdditiveBlending,
      depthWrite:false, fog:false }));
    halo.scale.setScalar(1.5);
    mesh.add(halo); scene.add(mesh);
    p = { mesh, halo, vel:new THREE.Vector3(), active:false, dmg:0, life:0, corrosive:false };
    projPool.push(p);
  }
  p.mesh.material.color.set(color); p.halo.material.color.set(color);
  p.mesh.position.copy(pos); p.vel.copy(dir).multiplyScalar(14);
  p.dmg = dmg; p.life = 3.5; p.active = true; p.mesh.visible = true; p.corrosive = corrosive;
}
const rings = [];
const tmpV = new THREE.Vector3();
/* Flat alpha on an additive ring is the mapless-halo bug in annulus form: a pale plate with a
   hard edge on BOTH sides, and at 0.8 opacity a boss's three overlapping rings washed the ground
   to white. RingGeometry's UVs are radial (they come off the vertex position over the outer
   radius), so fx.glowTexture() maps straight onto it and the falloff becomes the ring — which is
   why the opacity can drop to 0.5 and still read brighter. One shared geometry: the ring is the
   same shape every time and only its scale animates. */
const RING_OP = 0.5;
const ringGeo = new THREE.RingGeometry(0.62, 1.38, 48);
function spawnRing(pos, dmg, color, delay=0){
  const mesh = new THREE.Mesh(ringGeo,
    new THREE.MeshBasicMaterial({ color, map:glowTexture(), transparent:true, opacity:RING_OP,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide, fog:false }));
  mesh.rotation.x = -Math.PI/2;
  mesh.position.copy(pos); mesh.position.y = groundHeight(pos.x,pos.z)+0.5;
  scene.add(mesh);
  rings.push({ mesh, r:1, dmg, delay, hitDone:false, speed:9 });
}
// lingering ground hazard (Rotmaw's toxic puddles) — ticks damage while the player stands in it
const puddles = [];
function spawnPuddle(pos, dmg, radius, duration){
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(radius, 20),
    new THREE.MeshBasicMaterial({ color:0x8acc2a, transparent:true, opacity:0.4,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide }));
  mesh.rotation.x = -Math.PI/2;
  mesh.position.copy(pos); mesh.position.y = groundHeight(pos.x,pos.z)+0.12;
  scene.add(mesh);
  puddles.push({ mesh, dmg, radius, life:duration, maxLife:duration, tickCd:0 });
}

/* ================= game state ================= */
const game = {
  state:'title', // title | intro | play | pause | tome | over | win
  player:null, enemies:[], powerups:[], boss:null,
  particles, audio, spawnProjectile, spawnRing, spawnPuddle,
  kills:[0,0,0,0,0,0], totalKills:0, rareKills:0,
  startTime:0, hitStopT:0, shakeT:0, shakeAmp:0,
  bossSpawned:false, zone:0,
  seed:SEED, theme:null, progress, // theme is filled in by boot(), once the world exists
  level:1, xp:0, runEssences:[0,0,0,0,0,0],
  dropBonus:0, rarityJitter:[1,1,1,1,1], density:1,
  nearestHarvest:null,
};
window.__game = game; // for verification

/* ---------- XP & leveling ---------- */
function xpNeed(){ return xpForLevel(game.level); }
game.addXP = (what)=>{
  if(game.state !== 'play') return;
  const amt = what === 'boss' ? XP_PER_BOSS_HIT : (XP_PER_HIT[what] || 2);
  game.xp += amt;
  while(game.xp >= xpNeed()){ game.xp -= xpNeed(); levelUp(); }
  updateHUD();
};
function applyLevelStats(){ // per-level growth
  const p = game.player;
  p.maxHp += 12; p.baseDmg += 1.5; p.hp = p.maxHp;
}
function levelUp(silent=false){
  game.level++;
  applyLevelStats();
  if(silent) return;
  const p = game.player;
  audio.levelup();
  game.shake(0.3);
  const gp = p.group.position;
  // 40+18 -> 20+10. fx.js caps sprite pixel size and cut per-sprite alpha ~4x; the cap only
  // stays loose if the burst does not hand it fifty-eight overlapping size-11 sprites to clamp.
  particles.burst(gp.clone().setY(gp.y+1.4), 20, {r:1,g:0.85,b:0.3, spread:5, size:11, life:1.1, grav:2.5, drag:0.97});
  particles.burst(gp.clone().setY(gp.y+1.4), 10, {r:1,g:1,b:1, spread:2.5, size:7, life:0.7});
  const el = document.getElementById('levelup');
  el.textContent = '✦ LEVEL UP! — LV ' + game.level + ' ✦';
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  announce('Healed to full — push deeper while it lasts', 'good');
}

/* ---------- mutations ---------- */
function applyMutations(){
  const p = game.player; if(!p) return;
  const t = id=>progress.tierOf(id);
  p.dmgMult *= 1 + 0.10*t('crimson');
  p.speedMult *= 1 + 0.08*t('swiftgill');
  if(t('ironstem')){ p.maxHp = Math.round(p.maxHp*(1+0.15*t('ironstem'))); p.hp = p.maxHp; }
  p.magnetBoost = 0.4*t('sporelord');
  game.dropBonus = 0.10*t('luckyspore');
  // elder blood: start at higher level (silent level-ups)
  for(let i=0;i<t('elderblood');i++) levelUp(true);
}

// item 48: an announcement carries its kind, and its copy names the counterplay. "You took
// damage" tells the player nothing they didn't feel; "drink Fortify" tells them what to do.
// kind: '' neutral | 'good' reward | 'bad' threat | 'cool' rare find.
function announce(txt, kind=''){
  const el = document.getElementById('announce');
  el.textContent = txt;
  el.className = ''; void el.offsetWidth; el.className = 'show' + (kind ? ' ' + kind : '');
}
game.announce = announce;
game.shake = (a)=>{ game.shakeT = Math.max(game.shakeT, 0.3); game.shakeAmp = Math.max(game.shakeAmp, a); };
game.hitStop = (t)=>{ game.hitStopT = Math.max(game.hitStopT, t); };
game.damageFlash = ()=>{
  const el = document.getElementById('dmgvin');
  el.style.opacity = 0.9; setTimeout(()=> el.style.opacity = 0, 140);
};

/* ---------- floating numbers ----------
   INVARIANT (the bug this exists to prevent): a hit does not get its OWN node. A three-swing
   combo on one mushroom used to append three overlapping nodes to <body> in 300 ms, an AoE
   finisher appended one per enemy in the radius, and nothing bounded the total — so a fight put a
   dozen unreadable numbers on screen and a dozen unbounded DOM appends into the frame that could
   least afford them. Two rules instead:
     - one live node per TARGET (per kind, for the untargeted text): a running total that grows in
       place, so a combo reads as one rising number instead of a smear;
     - FLOAT_MAX is the fallback ceiling. A node that would exceed it is dropped, not queued —
       the 13th number in a 0.85 s window carries no information the first twelve didn't.
   The node's own lifetime is never extended, so it always leaves after one animation. */
const FLOAT_LIFE = 850;         // ms; must match the .dmg CSS animation length
const FLOAT_MAX = 12;
const floatNodes = new Map();   // key (target object, or a text string) -> {el, total, crit, born}
let floatLive = 0;
const PLAYER_KEY = {};          // stable identity for the player's own damage numbers
const _fv = new THREE.Vector3();
function floatNode(key, cls, text, x, y){
  const now = performance.now();
  const rec = floatNodes.get(key);
  if(rec && now - rec.born < FLOAT_LIFE){    // coalesce into the node already floating
    rec.el.textContent = text;
    rec.el.className = cls;
    rec.el.style.left = x+'px'; rec.el.style.top = y+'px';
    return rec;
  }
  if(floatLive >= FLOAT_MAX) return null;    // hard cap: drop, never queue
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  el.style.left = x+'px'; el.style.top = y+'px';
  document.body.appendChild(el);
  floatLive++;
  const fresh = { el, total:0, crit:false, born:now };
  floatNodes.set(key, fresh);
  setTimeout(()=>{ el.remove(); floatLive--;
    if(floatNodes.get(key) === fresh) floatNodes.delete(key); }, FLOAT_LIFE);
  return fresh;
}
// `target` is the identity the total accumulates against — the enemy that got hit. Callers that
// have no target still coalesce, just per-kind.
function damageNumber(worldPos, dmg, crit, isPlayer=false, target=null){
  const v = _fv.copy(worldPos).project(camera);
  if(v.z > 1) return;
  const key = target || (isPlayer ? PLAYER_KEY : 'dmg');
  const x = (v.x*0.5+0.5)*innerWidth + (Math.random()-0.5)*40;
  const y = (-v.y*0.5+0.5)*innerHeight;
  const rec = floatNodes.get(key);
  const running = (rec && performance.now() - rec.born < FLOAT_LIFE) ? rec : null;
  const total = (running ? running.total : 0) + dmg;
  const isCrit = crit || (running ? running.crit : false);
  const out = floatNode(key, 'dmg' + (isCrit?' crit':'') + (isPlayer?' player':''),
    isCrit ? total+'!' : ''+total, x, y);
  if(out){ out.total = total; out.crit = isCrit; }
}
game.damageNumber = damageNumber;

/* ---------- harvestable mushrooms + contracts ---------- */
// same budget and the same one-node rule as damageNumber, keyed on the text: harvesting a cluster
// fires '+1 Chanterelle' four times in a second, and that is one line moving, not four.
function pickupText(worldPos, text, color){
  const v = _fv.copy(worldPos).project(camera);
  if(v.z > 1) return;
  const rec = floatNode('t:'+text, 'dmg harvest', text,
    (v.x*0.5+0.5)*innerWidth, (-v.y*0.5+0.5)*innerHeight);
  if(rec) rec.el.style.color = color;
}
/* ---------- hover tags (item 47) ----------
   Naming the thing is not enough — the tag names the VERB. "🧰 Sealed chest" tells you nothing;
   "🧰 Sealed chest — [E] pry with a lockpick (3 held)" tells you what to do about it. Props join a
   registry with a label provider, so a later wave's pods/chests/vents get tags for free:

     const off = game.hoverTags.register(prop.group, ()=> '🪙 12 coins — walk over it',
                                         { range: 20, lift: 1.4 });

   label(root) returning null/'' means "nothing to say right now" (spent, dead, no charges).
   Entries whose root has left the scene are pruned here, so a prop that despawns with
   scene.remove() never has to remember to unregister. */
const hoverTags = [];
game.hoverTags = {
  register(root, label, opts={}){
    const e = { root, label, range: opts.range ?? 22, lift: opts.lift ?? 1.6 };
    hoverTags.push(e);
    return ()=>{ const i = hoverTags.indexOf(e); if(i >= 0) hoverTags.splice(i,1); };
  },
  clear(){ hoverTags.length = 0; },
};
// The chip is built here rather than in index.html because it is created by whoever owns the
// raycast; it borrows the harvest-prompt language so the two read as one system.
const tagEl = document.createElement('div');
tagEl.id = 'hovertag';
tagEl.style.cssText = 'position:fixed;z-index:31;display:none;pointer-events:none;font-size:14px;' +
  "font-weight:700;font-family:'Fredoka',sans-serif;color:#fff6e3;background:rgba(20,12,26,.72);" +
  'border:2px solid rgba(255,246,227,.4);border-radius:999px;padding:4px 12px;white-space:nowrap;' +
  'transform:translate(-50%,-100%);text-shadow:0 2px 0 #1c1410';
document.body.appendChild(tagEl);
const tagRay = new THREE.Raycaster();
const tagNdc = new THREE.Vector2();
const tagRoots = [];              // candidate list, rebuilt in place — no per-frame allocation
const tagAnchor = new THREE.Vector3();
let pointerX = innerWidth/2, pointerY = innerHeight/2;
addEventListener('pointermove', e=>{ pointerX = e.clientX; pointerY = e.clientY; });
let tagEntry = null, tagText = '', tagCd = 0, tagL = -1, tagT = -1;
function entryFor(obj){
  for(let o = obj; o; o = o.parent){
    for(const e of hoverTags) if(e.root === o) return e;
  }
  return null;
}
function hideHoverTag(){
  if(tagEntry || tagText){ tagEntry = null; tagText = ''; tagEl.style.display = 'none'; }
}
function updateHoverTag(dt){
  if(game.state !== 'play' || !hoverTags.length){ hideHoverTag(); return; }
  tagCd -= dt;
  if(tagCd <= 0){
    tagCd = 0.07; // raycast at ~14 Hz; the chip still tracks its anchor every frame
    for(let i=hoverTags.length-1;i>=0;i--) if(!hoverTags[i].root.parent) hoverTags.splice(i,1);
    const pp = game.player.group.position;
    tagRoots.length = 0;
    for(const e of hoverTags){
      const rp = e.root.position;
      if(Math.abs(rp.x-pp.x) > e.range || Math.abs(rp.z-pp.z) > e.range) continue;
      tagRoots.push(e.root);
    }
    // pointer-locked look has no cursor, so the screen centre IS the pointer
    const locked = !!document.pointerLockElement;
    const sx = locked ? innerWidth*0.5 : pointerX, sy = locked ? innerHeight*0.5 : pointerY;
    tagNdc.set(sx/innerWidth*2-1, -(sy/innerHeight)*2+1);
    tagRay.setFromCamera(tagNdc, camera);
    let entry = null, txt = '';
    if(tagRoots.length){
      const hits = tagRay.intersectObjects(tagRoots, true);
      for(const h of hits){
        const e = entryFor(h.object);
        if(!e) continue;
        const t = e.label(e.root) || '';
        // An entry with nothing to say must not EAT the hit. A dead critter and a spent pod both
        // stay parented (fauna respawns them in place), and three's raycaster does not skip
        // invisible meshes — so stopping at the first registered hit hid the live critter standing
        // right behind a dead one.
        if(!t) continue;
        entry = e; txt = t; break;
      }
    }
    if(!txt) hideHoverTag();
    else if(entry !== tagEntry || txt !== tagText){ // diff-based: the DOM only sees real changes
      tagEntry = entry; tagText = txt;
      tagEl.textContent = txt;
      tagEl.style.display = 'block';
    }
  }
  if(!tagEntry) return;
  tagAnchor.copy(tagEntry.root.position); tagAnchor.y += tagEntry.lift;
  tagAnchor.project(camera);
  if(tagAnchor.z > 1){ hideHoverTag(); return; }
  // A big prop can have its origin off-screen while its body fills the middle of the view, so the
  // chip is clamped into the viewport instead of hidden — an off-screen tag is just a silent bug.
  const l = Math.round(THREE.MathUtils.clamp((tagAnchor.x*0.5+0.5)*innerWidth, 90, innerWidth-90));
  const t = Math.round(THREE.MathUtils.clamp((-tagAnchor.y*0.5+0.5)*innerHeight, 40, innerHeight-40));
  if(l !== tagL || t !== tagT){ tagL = l; tagT = t; tagEl.style.left = l+'px'; tagEl.style.top = t+'px'; }
}

/* item 08 — a contract row has to read for SIX kinds now, not one, so the two things that used to
   come from the species (the swatch colour and the icon) come from the kind when there is no
   species. The NAME is the objective sentence rather than a noun: "Harvest 7 Azure Cap" tells you
   what to do, "Azure Cap" only tells you what the quest is about — and for a vent or a chest
   quest a bare noun tells you nothing at all. progress.contractLabel() owns the phrasing so this
   and the Tome cannot drift. */
const QUEST_TINT = { harvest:'#9be26e', pod:'#ff9dc4', chest:'#ffd79a', vent:'#c8a0ff',
                     stomp:'#ffcf5a', gem:'#8fe8ff' };
function contractFace(c){
  const kind = c.kind || 'harvest';
  const sp = kind === 'harvest' ? SPECIES_BY_ID[c.species] : null;
  return {
    icon: sp ? sp.icon : questKind(kind).icon,
    tint: sp ? hexCss(sp.color) : (QUEST_TINT[kind] || '#9be26e'),
    label: progress.contractLabel(c, sp && sp.name),
  };
}
function updateContracts(){
  const el = $('contracts'); if(!el) return;
  el.innerHTML = progress.contracts.map(c=>{
    const f = contractFace(c);
    const pct = Math.min(100, c.have/c.need*100);
    return `<div class="contract">
      <div class="cicon" style="background:${f.tint}">${f.icon}</div>
      <div class="cinfo">
        <div class="cname">${f.label}</div>
        <div class="cbar"><div class="cfill" style="width:${pct}%"></div></div>
        <div class="cprog">${c.have}/${c.need} &nbsp;•&nbsp; +${c.reward} 🌿</div>
      </div>
    </div>`;
  }).join('');
}
/* ONE payout announce for every quest kind, so a finished vent contract sounds exactly like a
   finished harvest contract — which is the point of having one board. Callers pass the result of
   any progress.advanceQuests()/harvestFor() call plus where on screen it happened. */
function payQuests(res, x, y, z){
  if(!res || !res.completed.length) return 0;
  updateContracts();
  const paid = res.completed.reduce((a,c)=>a+c.reward, 0);
  audio.contract();          // its own cue — a contract payout is not an alchemy purchase
  if(x !== undefined) rewardPops.pop(x, y, z, 6);
  announce('✅ Contract paid +' + paid + ' 🌿 — spend it in the Tome', 'good');
  return paid;
}
game.updateContracts = updateContracts;

/* ================= interactive props + fauna (items 11-14, 18, 12) =================
   The world had scenery you route around and enemies you fight. These are the things you go TO:
   spore pods you can only reach by leaving the ground, sealed chests that publish their own odds
   before you spend, vents that move you across the map, guaranteed treasure at the authored site,
   and critters you harvest by landing on them.

   Both modules deliberately REPORT instead of acting: props.js and fauna.js compute a payout and
   hand it back, and every coin, pop, cue and line of copy is decided here. That is what keeps a
   pod, a kill and a contract all reading as the same "you got paid" beat instead of three. */
const INTERACT_KEY = 'KeyC', INTERACT_LABEL = 'C';   // free: E/F/R/Q/G are potions, H is harvest
let props = null, fauna = null;
const critterPop = new THREE.Vector3();   // reused: pickupText clones before projecting
let critterHinted = false, nearMissCd = 0;
/* item 54 — where to land. A critter is novel, harmless and does not attack, so nothing about it
   suggests "jump on me"; the hovering Puff Drifter is worse, because its shadow is the only thing
   telling you where its column even is. One pooled ring per nearby critter, re-declared every
   frame (begin/mark/end), so there is no lifetime to leak and nothing to expire. */
let critterMarks = null;
function makeLandRing(){
  const g = new THREE.RingGeometry(0.62, 0.92, 18);
  g.rotateX(-Math.PI/2);
  const m = new THREE.MeshBasicMaterial({ color:0xfff3b0, transparent:true, opacity:0.45,
    blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });
  const mesh = new THREE.Mesh(g, m);
  mesh.userData.noShadow = true;
  mesh.renderOrder = 3;
  return mesh;
}
let interactTarget = null;   // the prop [C] acts on right now; recomputed in updateHarvestPrompt

/* Vent travel needs a beat of black between the two places, or a teleport reads as a glitch.
   Same story as the chip: created here, 220 ms in, 300 ms out. */
const warpEl = document.createElement('div');
warpEl.id = 'warpfade';
warpEl.style.cssText = 'position:fixed;inset:0;z-index:40;background:#0b0710;opacity:0;' +
  'pointer-events:none;transition:opacity .22s ease-in';
document.body.appendChild(warpEl);

/* Rebuilt whenever the run is, and clearHeadHits() runs FIRST: a pod from the previous world is
   still a registered plane in entities.js until something clears it, so a reroll would otherwise
   leave invisible pods payable in mid-air. Placement runs after buildWorld() on purpose — every
   predicate reads the FINISHED collider list, which is what stops a pod hovering inside a spire. */
function buildRunContent(){
  if(props){ props.dispose(); props = null; }
  if(fauna){ fauna.dispose(); fauna = null; }
  clearHeadHits();
  interactTarget = null;
  /* Legibility over variety: a ROW of pods at one height is a run you can see and plan, where a
     scattered singleton is just a thing you happen to bump. PROP_PARAMS is a live tuning object
     (props.js's own convention, same as world.PARAMS), so this is a dial, not a fork. */
  PROP_PARAMS.podClusters = 8;                 // rows per world
  PROP_PARAMS.podPerMin = 3; PROP_PARAMS.podPerVar = 2;   // 3-4 pods per row
  PROP_PARAMS.podBotVar = 0.28;                // one readable hover height, not a staircase
  props = buildInteractiveProps(scene, mulberry32(deriveSeed(game.seed, 0x9705)), world,
    { progress, onEvent: onPropEvent });
  fauna = buildFauna(scene, mulberry32(deriveSeed(game.seed, 0xfa11a)), world,
    { progress, particles });
  game.props = props; game.fauna = fauna;
  critterHinted = false; nearMissCd = 0;
  if(!critterMarks) critterMarks = new FrameMarks(scene, makeLandRing);
  // item 47: the tag names the VERB. Both modules already word their own labels that way, and the
  // chest's is progress.chestPrompt() — i.e. the hover chip publishes the real probability too.
  for(const p of props.pods) game.hoverTags.register(p.mesh, m=>props.labelFor(m), { range:22, lift:1.3 });
  for(const c of props.chests) game.hoverTags.register(c.group, ()=> '[' + INTERACT_LABEL + '] ' + props.promptFor(c), { range:20, lift:c.h*1.9 });
  for(const v of props.vents) game.hoverTags.register(v.mesh, ()=> '🌀 Vent — stand on it, [' + INTERACT_LABEL + '] to ride it', { range:20, lift:2.2 });
  for(const t of props.treasures) game.hoverTags.register(t.mesh, m=>props.labelFor(m), { range:24, lift:1.4 });
  for(const root of fauna.hoverTargets()) game.hoverTags.register(root, o=>fauna.labelFor(o), { range:20, lift:1.4 });
  // props opt BELOW the size floor: a pod is a 1 m flower hanging in the air, and its shadow
  // on the ground is how the player reads that it is hanging there at all.
  shadowize(props.root, { minR: 0.5 });
  shadowize(fauna.group, { noCast: true });         // rule 2: critters carry their own blobs
}
// dev-panel prerequisite: every live tuning object in one place, same convention as world.PARAMS
game.tuning = { world: WORLD_PARAMS, props: PROP_PARAMS, fauna: FAUNA };
// for verification: the standable height at a column, props included (groundOnly is the same
// query the camera boom and the projectiles use).
game.groundAt = (x, z)=> groundOnly(x, z);
game.propInfo = ()=> !props ? null : { pods: props.pods.length, chests: props.chests.length,
  vents: props.vents.length, treasures: props.treasures.length, treasureSource: props.treasureSource,
  spent: props.pods.filter(p=>p.spent).length, critters: fauna ? fauna.critters.length : 0,
  chain: fauna ? fauna.chain : 0, lockpicks: progress.lockpicks,
  strandedCritters: fauna ? fauna.strandedCount : 0,
  ventFams: props.vents.map(v=>v.fam.id), ventCool: props.vents.map(v=>+v.cool.toFixed(1)),
  ring: game.player && game.player.elemRing ? game.player.elemRing.id : null,
  ringCharge: game.player ? +(game.player.ringCharge||0).toFixed(1) : 0,
  stomps: game.stompCount|0, ringsFound: game.ringsFound|0,
  quests: progress.contracts.map(c=>(c.kind||'harvest')+':'+c.have+'/'+c.need) };

/* ONE payout chokepoint per prop kind. props.js fires the event; the credit, the pops, the cue
   and the copy all happen here, so a new prop gets consistent feel for free. */
function onPropEvent(ev){
  if(ev.type === 'pod') payoutPod(ev);
  else if(ev.type === 'chest') payoutChest(ev);
  else if(ev.type === 'travel') doTravel(ev);
  else if(ev.type === 'ventCool') ventRefused(ev);
  else if(ev.type === 'treasure') payoutTreasure(ev);
}
/* item 10. A refused input has to SAY it was refused and say why, or the vent reads as broken.
   The cue is deliberately the flat click and not the error hiss: nothing went wrong, you were
   just early. */
function ventRefused(ev){
  audio.click();
  announce('🌀 Vent still venting — ' + Math.ceil(ev.left) + 's', 'bad');
}
function payoutPod(ev){
  // coins and the pop are already banked/fired by props.js (one chokepoint, its side). This half
  // owns how it reads: a pod that pays has to sound and say that it paid.
  // COPY IS SHORT ON PURPOSE. The banner is one line at speed; anything longer is read as noise
  // and overflows on a narrow window.
  audio.powerup();
  game.shake(0.16);
  const lockpick = !!(ev.lockpick && ev.lockpick.got);
  let txt = (ev.mult > 1 ? '🌸 Rich pod +' : '🌸 Pod +') + ev.coins + ' 🪙';
  if(ev.chargesLeft > 0) txt += ' · ×' + ev.chargesLeft + ' left';
  if(lockpick){ txt += ' · 🗝️ +1 lockpick'; audio.unlock(); }
  announce(txt, lockpick || ev.mult > 1 ? 'cool' : 'good');
  // item 08: the quest board counts the verb, not the payout, so a pod that pays nothing new
  // (a spent charge) still does not count and a rich pod does not count twice.
  payQuests(progress.advanceQuests('pod'), ev.x, ev.y + 1.4, ev.z);
  updateHUD();
}
function payoutTreasure(ev){
  audio.unlock();
  rewardPops.pop(ev.x, ev.y + 1.2, ev.z, 8);
  game.shake(0.3);
  announce('💎 Crystal +' + ev.coins + ' 🪙' + (ev.left > 0 ? ' · ' + ev.left + ' left' : ''), 'cool');
  payQuests(progress.advanceQuests('gem'), ev.x, ev.y + 1.6, ev.z);
  updateHUD();
}
function payoutChest(ev){
  const r = ev.result;
  if(!r || !r.ok){
    audio.click();
    announce('🗝️ No lockpick — burst a pod or land on a critter', 'bad');
    return;
  }
  if(!r.opened){
    audio.hiss(0.1, 0.13, 190, 760);
    announce(`${r.icon} Held — ${r.pct}% per 🗝️ · ${r.lockpicks} left`, 'bad');
    updateHUD();
    return;
  }
  audio.unlock();
  rewardPops.pop(ev.x, ev.y + ev.chest.h*1.4, ev.z, r.coins > 90 ? 10 : 6);
  game.shake(0.35);
  announce(`${r.icon} ${r.name} open! +${r.coins} 🪙` + (r.myco ? ` +${r.myco} 🌿` : '') +
    ` · ${r.tries} 🗝️ spent`, 'cool');
  if(ev.gear) rollChestGear(ev);
  payQuests(progress.advanceQuests('chest'), ev.x, ev.y + ev.chest.h*1.6, ev.z);
  updateHUD();
}
/* econ's item 15: `gear:true` is a request for exactly ONE roll from main.js's own drop table.
   It stays here rather than in progress.js so a chest pays from the same table as a kill — and it
   drops as a physical pickup, which is how every other reward in this game arrives. */
function rollChestGear(ev){
  const pos = new THREE.Vector3(ev.x + 1.7, ev.y, ev.z);
  const rarity = 2 + ((Math.random()*3)|0);   // rare+ : a chest is a small boss, not a mob
  const roll = Math.random();
  if(roll < 0.36) dropWeapon(pos, rarity, true);
  else if(roll < 0.66) dropArmor(pos, rarity, true);
  else if(roll < 0.80) dropPotion(pos, rarity, true);
  else dropPowerup(pos, rarity);
  // item 01. On TOP of the roll above, not as one of its branches: a chest costs a lockpick you
  // earned, so it should never be the reason you walked away from one still bleeding. 45% is high
  // enough that chests read as the reliable place to restock health, which is what makes spending
  // a lockpick before a boss a real decision.
  if(Math.random() < 0.45) dropHealthPotion(new THREE.Vector3(pos.x - 1.4, pos.y, pos.z + 0.9), rarity, true);
}
/* item 13. Fade, move, then AIM: arriving faced at whatever you happened to be looking at wastes
   the trip. props.js reports the destination's nearest interest anchor, so the yaw lands on
   something worth walking toward. */
let warping = false;
function doTravel(ev){
  if(warping) return;
  warping = true;
  audio.warp();
  warpEl.style.transition = 'opacity .22s ease-in';
  warpEl.style.opacity = '1';
  setTimeout(()=>{
    const p = game.player;
    if(p){
      p.group.position.set(ev.x, ev.y, ev.z);
      p.vy = 0; p.jumps = 0; p.grounded = true; p.vel.set(0, 0, 0);
      if(fauna) fauna.resetChain();
      if(ev.aimAt) camYaw = Math.atan2(ev.aimAt.x - ev.x, ev.aimAt.z - ev.z);
      // snap the boom: lerping it across half the map behind the fade arrives mid-flight
      camPivot.set(ev.x, ev.y + 2.0, ev.z);
      const dx = -Math.sin(camYaw)*Math.cos(camPitch), dy = Math.sin(camPitch), dz = -Math.cos(camYaw)*Math.cos(camPitch);
      camPos.set(camPivot.x + dx*camDist, camPivot.y + dy*camDist, camPivot.z + dz*camDist);
      camTarget.copy(camPivot);
      announce('🌀 Surfaced — new ground ahead', 'cool');
      // counted here rather than at the entrance: the quest says "ride a vent", and a ride that
      // never arrived is not one. Also the only place that knows the trip succeeded.
      payQuests(progress.advanceQuests('vent'), ev.x, ev.y + 2.0, ev.z);
      updateHUD();
    }
    warpEl.style.transition = 'opacity .3s ease-out';
    warpEl.style.opacity = '0';
    setTimeout(()=>{ warping = false; }, 300);
  }, 220);
}
/* The interact key. E/F/R/Q/G are potions, H is harvest, B/TAB/M/1-7/SPACE/SHIFT are taken —
   so [C] is the world-interaction key, and the contextual prompt names it every time it applies. */
function tryInteract(){
  if(game.state !== 'play' || !props) return;
  const t = interactTarget;
  if(!t) return;
  if(t.type === 'chest') props.pry(t);          // pry() emits; payoutChest() pays
  else if(t.type === 'vent') props.travel(t);
}
/* item 12. A stomp pays coins and its species' own resource, and the CHAIN is the skill: fauna.js
   banks coins + the lockpick roll through progress.stompCritter() and reports the rest for crediting
   here, so the escalating copy and the escalating cue come out of the same number. */
function payoutStomp(s){
  const r = s.reward, c = s.critter;
  const y = c.y + 1.2;
  rewardPops.pop(c.x, y, c.z, Math.min(8, 2 + r.chain*2));
  // essence goes into the Umber bank: mutations drain it fastest, so the commonest, closest,
  // easiest critter is the one that refills it.
  if(r.essence){ game.runEssences[0] += r.essence; progress.collect(0, r.essence); audio.essence(0); }
  if(r.myco){ progress.myco += r.myco; progress.saveMyco(); }
  if(r.harvest){
    // credited exactly the way picking that species credits a contract — same door, same payout.
    // advanceQuests takes the count directly, so a chain that pays 3 spores is one call, not three.
    payQuests(progress.advanceQuests('harvest', r.harvest.n, r.harvest.id), c.x, y, c.z);
  }
  // item 08: and the stomp itself is a quest verb, independently of what the critter dropped
  payQuests(progress.advanceQuests('stomp'), c.x, y, c.z);
  // SHORT. The chain multiplier is the part that has to read at a glance, because seeing ×2 turn
  // into ×3 is the only thing that teaches a player the chain exists at all.
  const gain = ['+' + r.coins + ' 🪙'];
  if(r.essence) gain.push('+' + r.essence + ' ✦');
  if(r.myco) gain.push('+' + r.myco + ' 🌿');
  if(r.harvest) gain.push('+' + r.harvest.n + ' 🍄');
  let txt = r.label + ' ' + gain.join(' ');
  if(r.chain === 0) txt += ' · chain it!';
  if(r.lockpick) txt += ' · 🗝️ +1 lockpick';
  announce(txt, r.chain >= 2 || r.lockpick ? 'cool' : 'good');
  // the floating number at the critter: the payout comes out of the thing you landed on
  pickupText(critterPop.set(c.x, c.y + 1.6, c.z), gain.join(' '), r.chain > 0 ? '#ffe98a' : '#b8f0a0');
  /* item 05 — WHERE ELEMENTAL RINGS COME FROM. Stomping is the only source, which is the point:
     the rings are what makes the jump economy pay into COMBAT, so a player who never leaves the
     ground never gets one and a player who chains gets them faster.
     The pity clause is not generosity, it is a teaching guarantee. A 14% drop can go 0-for-12,
     and a mechanic with a hotkey, a HUD chip and a whole file behind it cannot be allowed to stay
     invisible for a whole hunt because the dice said so — that is the exact failure this list
     opened with ("i dont see any equippable rings"). First ring: by the 5th stomp, always. */
  game.stompCount = (game.stompCount|0) + 1;
  const ringChance = Math.min(0.36, 0.14 + r.chain*0.07 + effDropBonus()*0.25);
  const ringPity = game.ringsFound === 0 && game.stompCount >= 5;
  if(ringPity || Math.random() < ringChance){
    game.ringsFound = (game.ringsFound|0) + 1;
    // alternate which element the world hands you first, so nobody learns the mechanic on one
    // ring and never meets the other
    dropRing(c.group.position, RINGS[game.ringsFound % RINGS.length].id);
  }
  game.comboHit({ killed: true });          // landing on one is a hit you aimed
  if(r.chain > 0) audio.gearUp(Math.min(6, r.chain + 1)); else audio.powerup();
  game.shake(0.12 + Math.min(0.28, r.chain*0.08));
  game.hitStop(0.03);
  updateHUD();
}

/* ================= the hit combo counter =================
   ONE CHOKEPOINT, and it has to be one, because "a hit" is reported from five different places
   (three melee paths, the finisher burst, a stomp) and a counter that half of them forget to call
   is worse than no counter: it reads as the game dropping your inputs.

   WHAT COUNTS AS A HIT is the whole design decision here, so it is written down rather than left
   to whichever call site happened to get wired:
     - ONE PER ENEMY STRUCK, not one per swing. A cleave that catches three mushrooms is worth
       three, which is what makes wading into a group feel different from duelling — and it is the
       only rule under which the number ever reaches the high tiers.
     - A STOMP COUNTS. Landing on a critter is a hit you aimed, and it is the one hit you can land
       while airborne, so it is how a combo survives a gap between enemies.
     - CONTINUOUS DAMAGE DOES NOT COUNT. The ring cone and the burn tick every frame or every
       0.4 s, so counting them would turn "hold Z" into a number that scrolls, and the tier names
       would mean nothing. Instead the cone KEEPS THE COMBO ALIVE without incrementing it
       (comboKeepAlive) — you are still fighting, so you should not be punished for it, but the
       ring is not a way to farm the counter either.

   PURELY A DISPLAY. It grants no damage bonus and gates nothing: this is a readout of something
   the player is already doing, and hanging a multiplier off it would silently rebalance every
   weapon in the game. */
const COMBO_WINDOW = 2.8;        // seconds since the last hit before the chain lapses
const COMBO_SHOW_AT = 2;         // a "1x combo" is not a combo — the widget appears on the second hit
/* Tiers are FAR apart on purpose. If the labels came every three hits they would flicker past and
   stop being rewards; at 5/10/18/30/50 each one is a thing that happens rarely enough to notice,
   and 50 is deliberately only reachable in a real crowd. `hue` is the one colour the whole widget
   takes, so the tier is legible from the number alone without reading the word. */
const COMBO_TIERS = [
  { at:0,  label:'HITS',   hue:'#fff6e3' },
  { at:5,  label:'NICE',   hue:'#9be26e' },
  { at:10, label:'SHARP',  hue:'#6bd8ff' },
  { at:18, label:'BRUTAL', hue:'#ffd94a' },
  { at:30, label:'SAVAGE', hue:'#ff8a3a' },
  { at:50, label:'UNREAL', hue:'#ff5ad0' },
];
function comboTierOf(n){
  let i = 0;
  for(let k=0;k<COMBO_TIERS.length;k++) if(n >= COMBO_TIERS[k].at) i = k;
  return i;
}
const combo = { n:0, t:0, best:0, tier:0 };
game.comboState = combo;

// Respect the OS switch. Checked once and cached: this is read on every hit, and matchMedia in a
// hot path is a needless layout-adjacent call.
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)').matches;
let comboDrain = null;           // the live WAAPI drain animation, so a new hit can cancel it
let comboShown = false, comboNumShown = '', comboLabelShown = '', comboTierShown = -1;

/* THE chokepoint. `opts.crit` and `opts.killed` only change how hard it pops — the count is the
   count. Returns the new total so a caller can size its own feedback off the same number. */
game.comboHit = (opts)=>{
  if(game.state !== 'play') return combo.n;
  combo.n++;
  combo.t = COMBO_WINDOW;
  if(combo.n > combo.best) combo.best = combo.n;
  const tier = comboTierOf(combo.n);
  const tierUp = tier > combo.tier;
  combo.tier = tier;
  // a tier-up is the only moment this system makes a sound, and it rises with the tier so the
  // ladder is audible without a label being read
  if(tierUp && combo.n >= COMBO_SHOW_AT){ audio.gearUp(Math.min(6, tier + 1)); game.shake(0.12); }
  drawCombo(tierUp, !!(opts && (opts.crit || opts.killed)));
  return combo.n;
};
/* The ring cone's door: refresh the window, never the count. Called while a held beam is touching
   something, so a fight you are winning with the ring does not silently drop the chain you built
   with the blade. Does nothing if there is no chain to keep alive — it must not be able to START
   one, or holding Z next to nothing would put a "1×" on screen forever. */
game.comboKeepAlive = ()=>{
  if(combo.n <= 0) return;
  combo.t = COMBO_WINDOW;
  if(comboDrain) comboDrain.cancel();
  comboDrain = startComboDrain();
};
function comboReset(){
  combo.n = 0; combo.t = 0; combo.tier = 0;
  if(comboDrain){ comboDrain.cancel(); comboDrain = null; }
  drawCombo(false, false);
}
game.comboReset = comboReset;

// the drain: ONE animation for the whole window, so the bar costs two calls per hit instead of a
// width write per frame. Same reason the rest of the HUD is diff-based — this is that rule applied
// to something continuously changing, by handing the continuity to the compositor.
function startComboDrain(){
  const fill = document.getElementById('combofill');
  if(!fill || !fill.animate) return null;
  return fill.animate([{ transform:'scaleX(1)' }, { transform:'scaleX(0)' }],
    { duration: COMBO_WINDOW*1000, easing:'linear', fill:'forwards' });
}
/* All the DOM this system touches. Diff-guarded field by field: on a normal hit only the number
   changes, so a 40-hit chain is 40 text writes and 40 cheap compositor animations — no layout
   thrash, no innerHTML. */
function drawCombo(tierUp, hard){
  const el = document.getElementById('combo');
  if(!el) return;
  const on = combo.n >= COMBO_SHOW_AT;
  if(on !== comboShown){
    comboShown = on;
    el.classList.toggle('on', on);
    // `.done` plays the drop-and-fade. Only on a chain worth mourning: flashing it after every
    // two-hit exchange would make the flourish meaningless.
    el.classList.toggle('done', !on && combo.best >= 5);
  }
  if(!on) return;
  const t = COMBO_TIERS[combo.tier];
  const num = String(combo.n);
  if(num !== comboNumShown){ comboNumShown = num; setText(document.getElementById('combonum'), num); }
  if(t.label !== comboLabelShown){ comboLabelShown = t.label; setText(document.getElementById('combolabel'), t.label); }
  if(combo.tier !== comboTierShown){
    comboTierShown = combo.tier;
    el.style.setProperty('--ch', t.hue);
  }
  if(comboDrain) comboDrain.cancel();
  comboDrain = startComboDrain();
  if(REDUCED_MOTION) return;
  /* The punch. WAAPI rather than a CSS class toggle: an animation object can be replaced
     mid-flight, so a fast chain re-pops cleanly instead of needing the remove-class/force-reflow/
     add-class dance, and nothing is left on the element between hits.
     The tilt alternates by parity so consecutive hits kick opposite ways — a pop that always
     leans the same direction reads as a loop, and two directions read as impact. */
  const wrap = document.getElementById('combowrap');
  const lean = (combo.n % 2 ? 1 : -1) * (hard ? 5 : 3);
  const peak = tierUp ? 1.55 : hard ? 1.34 : 1.22;
  if(wrap && wrap.animate) wrap.animate([
      { transform:`scale(1) rotate(0deg)` },
      { transform:`scale(${peak}) rotate(${lean}deg)`, offset: 0.28 },
      { transform:`scale(1) rotate(0deg)` },
    ], { duration: tierUp ? 420 : 210, easing:'cubic-bezier(.2,1.5,.35,1)' });
  if(tierUp && el.animate) el.animate([
      { filter:'brightness(2.6)' }, { filter:'brightness(1)' },
    ], { duration: 460, easing:'ease-out' });
}
// the lapse, driven from the frame loop. One class toggle at the crossing and nothing in between.
function updateCombo(dt){
  if(combo.n <= 0) return;
  combo.t -= dt;
  if(combo.t <= 0) comboReset();
}

/* ================= elemental rings (rings.js) =================
   ONE CHOKEPOINT for the whole mechanic: the drain, the cone, the particles and the status
   application all happen in this function, so "what does holding Z do" has exactly one answer.

   THE CONE IS A DOT PRODUCT, NOT A RAYCAST. A raycast per enemy per frame would be the obvious
   build and it would be wrong twice: it costs a BVH walk against every enemy every frame, and it
   makes the effect depend on where a creature's collider happens to be rather than on whether it
   is in front of you — which is the thing the player is actually aiming. Facing dot direction,
   compared against cos(angle), is two multiplies and reads exactly the way the visual does.

   Charge is spent in SECONDS OF HOLDING and nothing else: no per-cast cost, no cooldown. That is
   what makes the resource legible — the bar empties at the rate the effect is on screen. */
const RING_AIM = new THREE.Vector3();
function updateRing(dt){
  const p = game.player;
  if(!p) return;
  const ring = p.elemRing;
  const held = ring && p.ringCharge > 0 && keys[RING_KEY] && game.state === 'play';
  if(!held){
    if(p.ringFiring){ p.ringFiring = false; updateRingHud(); }
    return;
  }
  if(!p.ringFiring){ p.ringFiring = true; audio.hiss(0.12, 0.2, ring.id === 'fire' ? 320 : 900, 1400); }
  p.ringCharge = Math.max(0, p.ringCharge - dt);

  // facing: the character's own yaw, so what you see the hunter point at is what burns
  const yaw = p.group.rotation.y;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const pp = p.group.position;
  const cosHalf = Math.cos(ring.angle);

  // the spray. Emitted along the axis with spread, so the cone is visible BEFORE anything is in it
  // — an area effect you cannot see the edges of is an area effect the player cannot aim.
  const q = ring.particles;
  for(let k=0;k<q.n;k++){
    const t = 0.25 + Math.random()*0.75;                  // along the cone, biased away from the feet
    const off = (Math.random()-0.5)*2*ring.angle*t*0.9;   // widening with distance, like the cone
    const ax = Math.sin(yaw+off), az = Math.cos(yaw+off);
    game.particles.puff(pp.x + ax*ring.reach*t, pp.y + 1.1 + (Math.random()-0.5)*0.5, pp.z + az*ring.reach*t,
      { color: ring.color, n:1, size:q.size, life:q.life, rise:q.rise, spread:q.spread,
        grav:q.grav, alpha:q.alpha, vx: ax*3.2, vz: az*3.2 });
  }

  // and the payload
  let touched = 0;
  for(const m of game.enemies){
    if(m.dead) continue;
    RING_AIM.copy(m.group.position).sub(pp); RING_AIM.y = 0;
    const d = RING_AIM.length();
    if(d < 0.001 || d > ring.reach + m.R.scale) continue;
    if((RING_AIM.x*fx + RING_AIM.z*fz)/d < cosHalf) continue;
    // direct damage is dt-scaled so it is frame-rate independent; the STATUS refreshes rather than
    // stacks for the same reason (see Mushroom.applyElement).
    if(ring.dps){
      RING_AIM.copy(pp);                                  // shove direction is away from the player
      m.hit(ring.dps*dt, RING_AIM, game, 0);
      if(m.dead) continue;
    }
    m.applyElement(ring.kind, ring);
    touched++;
  }
  if(touched){ game.shake(0.02); game.comboKeepAlive(); }
  if(p.ringCharge <= 0){
    // spent. Clearing the slot rather than leaving an empty ring on screen: an inert HUD chip with
    // a key label under it is a control that lies about being available.
    const name = ring.name;
    p.elemRing = null; p.ringFiring = false;
    audio.click();
    announce(ring.icon + ' ' + name + ' burned out', 'bad');
  }
  updateRingHud();
}
/* The pickup. ONE slot on purpose (see rings.js), so this is always a replace, and the copy says
   so — silently overwriting a ring the player was saving is the kind of thing that reads as a bug. */
function equipRing(id){
  const ring = RINGS_BY_ID[id];
  if(!ring) return;
  const p = game.player;
  const had = p.elemRing;
  p.elemRing = ring;
  p.ringCharge = ring.charge;
  p.ringFiring = false;
  audio.unlock();
  announce(had && had.id !== id
    ? `${ring.icon} ${ring.name} — replaced your ${had.name} · hold [${RING_KEY_LABEL}]`
    : `${ring.icon} ${ring.name} — hold [${RING_KEY_LABEL}] to ${ring.id === 'fire' ? 'burn' : 'freeze'} them`, 'cool');
  updateRingHud();
  updateBackpack();
}
function dropRing(pos, id){
  const ring = RINGS_BY_ID[id] || RINGS[(Math.random()*RINGS.length)|0];
  const def = { id:'ring_'+ring.id, icon:ring.icon, name:ring.name, color:ring.color,
    shape:'ring', isRing:true, ringId:ring.id };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x, pos.z)+1.15), def));
}
/* Diff-based like every other HUD write: the chip only touches the DOM when the ring, the key or
   the tenth-of-a-second on the bar actually changes. Called from the ring update (which only runs
   while held) and from equip/reset — never once per frame. */
let ringHudKey = '';
function updateRingHud(){
  const el = document.getElementById('ringslot');
  if(!el) return;
  const p = game.player;
  const ring = p && p.elemRing;
  const pct = ring ? Math.max(0, Math.min(1, p.ringCharge/ring.charge)) : 0;
  const key = ring ? ring.id + '|' + Math.round(pct*40) + '|' + (p.ringFiring ? 1 : 0) : 'none';
  if(key === ringHudKey) return;
  ringHudKey = key;
  if(!ring){ el.classList.add('empty'); el.classList.remove('firing'); return; }
  el.classList.remove('empty');
  el.classList.toggle('firing', !!p.ringFiring);
  setText(document.getElementById('ringicon'), ring.icon);
  setText(document.getElementById('ringname'), ring.name.replace(' Ring',''));
  setText(document.getElementById('ringsecs'), Math.ceil(p.ringCharge) + 's');
  setWidth(document.getElementById('ringfill'), pct*100);
  const fill = document.getElementById('ringfill');
  const css = '#' + new THREE.Color(ring.color).getHexString();
  if(fill && fill.dataset.hue !== css){ fill.style.background = css; fill.dataset.hue = css; }
}

/* THE TEACHING LAYER. The mechanic worked and still read as decoration, because a harmless animal
   gives a player no reason to guess that landing on it is the interaction. Three cues, cheapest
   first: the hover tag names the verb (registered in buildRunContent), a ground ring shows WHERE
   to land, and a single latched line says it once. */
function updateCritterCues(dt){
  if(!fauna || !critterMarks) return;
  const pp = game.player.group.position;
  critterMarks.begin();
  let nearest = null, nd = 1e9;
  for(const c of fauna.critters){
    if(c.dead || c.dying) continue;
    const dx = c.x - pp.x, dz = c.z - pp.z, d2 = dx*dx + dz*dz;
    if(d2 > 400) continue;                       // 20 m: close enough to be a target
    if(d2 < nd){ nd = d2; nearest = c; }
    // the ring sits on the GROUND under the critter, not on the critter: a hovering drifter's
    // landing spot is the only thing the player actually needs to know.
    critterMarks.mark(c.x, c.groundY + 0.06, c.z, 1);
  }
  critterMarks.end();
  if(nearest && !critterHinted && nd < 196){
    critterHinted = true;
    announce(nearest.sp.icon + ' Harmless — jump and land on it', 'good');
  }
}

let harvestPromptId = null;
function updateHarvestPrompt(){
  const p = game.player;
  let best = null, bestD = 2.6; // interact range
  for(const h of world.harvestables){
    if(!h.alive) continue;
    const dx = h.g.position.x-p.group.position.x, dz = h.g.position.z-p.group.position.z;
    const d = Math.hypot(dx, dz);
    if(d < bestD){ bestD = d; best = h; }
  }
  game.nearestHarvest = best;
  /* One prompt line, and the rarer interaction wins it: a sealed chest or a vent underfoot outranks
     a mushroom you can pick anywhere. The chest's line comes from progress.chestPrompt(), so the
     real per-lockpick probability is on screen BEFORE the lockpick is spent — that is item 14's point. */
  const pp = p.group.position;
  const chest = props ? props.nearestChest(pp.x, pp.z, pp.y) : null;
  const vent = (!chest && props) ? props.ventUnderfoot(pp.x, pp.z, pp.y, p.grounded) : null;
  interactTarget = chest || vent || null;
  if(props) props.setHovered(interactTarget);   // the thing [C] would act on is the thing that glows
  let txt = null, id = null;
  if(chest){
    txt = '[' + INTERACT_LABEL + '] ' + props.promptFor(chest);
    id = 'c|' + chest.x.toFixed(1) + '|' + chest.state.tries + '|' + progress.lockpicks;
  } else if(vent){
    txt = '[' + INTERACT_LABEL + '] Ride the vent — it surfaces somewhere else on the map';
    id = 'v|' + vent.i;
  } else if(best){
    txt = '[H] Harvest ' + SPECIES_BY_ID[best.species].name;
    id = 'h|' + best.species + '|' + best.g.position.x + '|' + best.g.position.z;
  }
  if(id !== harvestPromptId){
    harvestPromptId = id;
    const el = $('harvestPrompt');
    if(txt){ el.textContent = txt; el.classList.remove('hidden'); }
    else el.classList.add('hidden');
  }
}
let harvestCd = 0; // small debounce so holding H doesn't rapid-fire through a whole cluster
function tryHarvest(){
  if(harvestCd > 0) return;
  const entry = game.nearestHarvest;
  if(!entry || !world.harvestMushroom(entry)) return;
  harvestCd = 0.35;
  const sp = SPECIES_BY_ID[entry.species];
  const pos = entry.g.position.clone(); pos.y += entry.baseScale*0.8 + 0.4;
  particles.burst(pos, 10, {r:1,g:1,b:1, spread:1.6, size:6, life:0.5});
  audio.pickup();
  pickupText(pos, '+1 '+sp.name, hexCss(sp.color));
  const res = progress.harvestFor(entry.species);
  updateContracts();
  updateHUD();
  payQuests(res, pos.x, pos.y, pos.z);
}

/* ---------- spawning ---------- */
function zoneMultAt(pos){
  const d = Math.hypot(pos.x, pos.z);
  // world depth (consecutive boss wins since your last death) scales EVERYTHING, not just
  // far-from-spawn zones — so a deep run is harder even right next to spawn
  return (1 + Math.min(3, d/65)) * depthMult(progress.depth);
}
function spawnEnemy(rarityIdx, pos, forcedMult=null){
  const m = new Mushroom(scene, rarityIdx, pos, forcedMult ?? zoneMultAt(pos));
  game.enemies.push(m);
  // rule 2: the blob is this creature's shadow. Bosses are the exception — see the policy.
  tagEnemy(m); shadowize(m.group, { noCast: !m.isBoss });
  return m;
}
// item 47: the tag says what the thing is FOR, not just what it is
function tagEnemy(m){
  game.hoverTags.register(m.group, ()=> m.dead ? null : m.isBoss
    ? `⚠ ${m.R.name} · ${Math.ceil(m.hp)} HP — punish the wind-up, then swing`
    : `${m.R.name} · ${Math.ceil(m.hp)} HP — cut it down for ✦ ${ESS_NAMES[m.rarity]}`,
    { range: 26, lift: 1.4 + m.R.scale });
}
// every drop lands here, so the payout pop, the hover tag and the list membership can't drift
function addDrop(pw){
  game.powerups.push(pw);
  // a drop is small, transient, and already carries its own glow pillar — exactly the class of
  // thing rule 1 exists to keep out of the map, and it appears and vanishes in bursts.
  shadowize(pw.group, { noCast: true });
  const d = pw.def;
  const verb = d.isCoin ? `${d.amount} coin${d.amount === 1 ? '' : 's'} — walk over it to bank ${d.amount === 1 ? 'it' : 'them'}`
    : d.isEssence ? `${d.name} ×${d.amount} — walk over it, spend it on mutations in the Tome`
    : d.isWeapon ? `${d.name} — walk over it to slot it on 1-7`
    : d.isRing ? `${d.name} — walk over it, then HOLD ${RING_KEY_LABEL} to use its charge`
    : d.isPotion ? `${d.name} — walk over it, then press ${POTIONS_BY_ID[d.potionId].key} to drink`
    : d.isArmor ? `${d.name} — walk over it to fill your ${d.slot} slot`
    : `${d.name} — walk over it for a timed boost`;
  game.hoverTags.register(pw.group, ()=> pw.dead ? null : `${d.icon} ${verb}`, { range: 22, lift: 1.1 });
  return pw;
}
game.spawnEnemy = spawnEnemy;
function weightedRarity(dist){
  // deeper zones = better rarity; per-seed jitter shuffles the table slightly.
  // world depth also nudges tougher rarities in sooner, on top of raw distance
  const zoneBoost = Math.min(1.5, dist/100) + Math.min(1.2, (progress.depth-1)*0.1);
  const w = RARITIES.map((r,i)=> r.weight * game.rarityJitter[i] * (i>=2 ? (1+zoneBoost*1.6) : 1) * (i>=4 ? (0.4+zoneBoost) : 1) * (i===5 ? 0.35 : 1));
  let sum = 0; for(const x of w) sum += x;
  let roll = Math.random()*sum;
  for(let i=0;i<w.length;i++){ roll -= w[i]; if(roll<=0) return i; }
  return 0;
}
function spawnWave(n){
  n = Math.max(1, Math.round(n * game.density));
  const pp = game.player.group.position;
  for(let i=0;i<n;i++){
    const a = Math.random()*Math.PI*2;
    const r = 18 + Math.random()*30;
    const pos = new THREE.Vector3(pp.x + Math.cos(a)*r, 0, pp.z + Math.sin(a)*r);
    if(Math.hypot(pos.x,pos.z) > 190) continue;
    spawnEnemy(weightedRarity(Math.hypot(pos.x,pos.z)), pos);
    particles.burst(pos.clone().setY(groundHeight(pos.x,pos.z)+1), 8, {r:0.8,g:0.6,b:0.9, spread:2, size:7, life:0.7});
  }
}
// mutation luckyspore bonus + any equipped charm's live dropBonus (charms can be swapped mid-run)
function effDropBonus(){ return game.dropBonus + (game.player ? game.player.getArmorBonus('dropBonus', game) : 0); }
function dropPowerup(pos, rarity){
  // guaranteed for rare+, high chance otherwise (was 0.25 flat — most kills dropped nothing)
  const chance = rarity >= 2 ? 1 : Math.min(1, 0.55 + rarity*0.15 + effDropBonus());
  if(Math.random() > chance) return;
  let sum=0; for(const p of POWERUPS) sum+=p.w;
  let roll = Math.random()*sum, def = POWERUPS[0];
  for(const p of POWERUPS){ roll-=p.w; if(roll<=0){ def=p; break; } }
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1), def));
}
function dropWeapon(pos, rarity, force=false, forceId=null){
  // rarer weapons are rarer drops; every weapon of this rarity can appear (forging is purely an optional stat upgrade)
  const chance = rarity>=3 ? 0.5 : rarity===2 ? 0.22 : rarity===1 ? 0.08 : 0.03;
  if(!force && Math.random() > chance + effDropBonus()*0.3) return;
  let w;
  if(forceId) w = WEAPONS_BY_ID[forceId];
  else { const pool = WEAPONS.filter(x=>x.rarity===rarity); w = pool[(Math.random()*pool.length)|0]; }
  if(!w) return;
  const def = { id:'weapon_'+w.id, icon:w.icon, name:w.name, color:RARITY_COLORS[w.rarity], isWeapon:true, weaponId:w.id };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.4), def));
}
function dropPotion(pos, rarity, force=false, forceId=null){
  const chance = 0.07 + rarity*0.02;
  if(!force && Math.random() > chance + effDropBonus()*0.2) return;
  const def = forceId ? POTIONS_BY_ID[forceId] : POTIONS[(Math.random()*POTIONS.length)|0];
  if(!def) return;
  const pdef = { id:'potion_'+def.id, icon:def.icon, name:def.name, color:def.color, isPotion:true, potionId:def.id };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.1), pdef));
}
/* item 01 — HEALING IS ITS OWN DROP, on its own roll, and that separation is the whole point.
   The generic potion table rolls one of five boosters, so the chance of the one you need when you
   are at 20 HP was 1/5 of an already-thin 7-15% — healing was theoretically available and
   practically absent. A dedicated roll makes "kill something, get a chance to heal" a rule the
   player can feel, and pinning it to RARITY means the tougher fight that hurt you is also the
   fight most likely to pay for it: 3% off a Common up to 12% off a Mythic.

   Written as a base plus a per-rarity step rather than a table so the two ends of the published
   band are visible in the source — if either number moves, the sentence above has to move with it. */
const HEAL_DROP_MIN = 0.03, HEAL_DROP_STEP = 0.018;   // rarity 0..5 -> 3.0% .. 12.0%
function dropHealthPotion(pos, rarity, force=false){
  const chance = HEAL_DROP_MIN + rarity*HEAL_DROP_STEP;
  // drop luck helps, at a quarter weight: a charm build should tilt healing, not trivialise it
  if(!force && Math.random() > chance + effDropBonus()*0.25) return;
  dropPotion(pos, rarity, true, 'vitality');
}
function dropArmor(pos, rarity, force=false){
  const chance = rarity>=3 ? 0.45 : rarity===2 ? 0.18 : rarity===1 ? 0.06 : 0.025;
  if(!force && Math.random() > chance + effDropBonus()*0.3) return;
  const pool = ARMOR.filter(a=> a.rarity===rarity);
  if(!pool.length) return;
  const a = pool[(Math.random()*pool.length)|0];
  const def = { id:'armor_'+a.id, icon:a.icon, name:a.name, color:RARITY_COLORS[a.rarity], isArmor:true, armorId:a.id, slot:a.slot };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.2), def));
}
function dropEssence(pos, rarity, isBoss){
  const amount = isBoss ? 5 : 1;
  const def = { id:'essence_'+rarity, icon:'✦', name:RARITIES[rarity].name+' Essence', color:RARITY_COLORS[rarity],
    shape:'gem', isEssence:true, rarity, amount };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+0.9), def));
  rewardPops.pop(pos.x, groundHeight(pos.x,pos.z)+1.1, pos.z, 1 + (isBoss?4:0));
}
function dropCoin(pos, rarity, isBoss){
  if(!isBoss && Math.random() > 0.85) return; // most kills still drop one, but not every single time
  const amount = (isBoss ? 20 : 1 + rarity*2) * ((rarity>=2 && Math.random()<0.15) ? 3 : 1);
  const def = { id:'coin', icon:'🪙', name:'Coins', color:0xffd94a, shape:'coin', isCoin:true, amount };
  addDrop(new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+0.7), def));
  // item 19: the payout throws something out of the thing you hit, at the thing you hit
  rewardPops.pop(pos.x, groundHeight(pos.x,pos.z)+1.1, pos.z, Math.min(6, 1+(amount/4|0)));
}
game.onKill = (m)=>{
  game.kills[m.rarity]++; game.totalKills++;
  if(m.rarity >= 2) game.rareKills++;
  dropEssence(m.group.position, m.rarity, m.isBoss);
  dropCoin(m.group.position, m.rarity, m.isBoss);
  dropPowerup(m.group.position, m.rarity);
  dropWeapon(m.group.position, m.rarity, m.isBoss, m.bossWeaponId);
  dropArmor(m.group.position, m.rarity, m.isBoss);
  dropPotion(m.group.position, m.rarity, m.isBoss);
  dropHealthPotion(m.group.position, m.rarity, m.isBoss);
  if(m.isBoss){ victory(); return; }
  updateHUD();
  if(!game.bossSpawned && game.rareKills >= 8){
    game.bossSpawned = true;
    audio.telegraph(1.4); // the 1.2s gap before it lands is the wind-up — make it audible
    announce('Something huge is waking — find open ground', 'bad');
    setTimeout(()=>{
      if(game.state !== 'play') return;
      const a = Math.random()*Math.PI*2;
      const pp = game.player.group.position;
      const pos = new THREE.Vector3(pp.x+Math.cos(a)*25, 0, pp.z+Math.sin(a)*25);
      const { archetype, trait, mult } = game.bossPlan;
      const isGlutton = archetype === 'glutton';
      game.boss = isGlutton ? new GluttonBoss(scene, pos, trait, mult) : new Boss(scene, pos, trait, mult);
      game.enemies.push(game.boss);
      tagEnemy(game.boss); shadowize(game.boss.group);   // a boss is landmark-sized: it casts
      const bossLabel = (game.boss.R.name + (trait ? ' · ' + trait.name : '')).toUpperCase();
      announce('⚠ ' + bossLabel + ' — dash through its rings, hit it on the recovery', 'bad');
      audio.bossSpawn(); game.shake(1);
      document.getElementById('bossname').textContent = bossLabel;
      document.getElementById('bosswrap').style.display = 'block';
      document.getElementById('objective').textContent = 'Slay ' + game.boss.R.name + '!';
    }, 1200);
  }
};
game.applyPowerup = (def)=>{
  const p = game.player;
  const pp = p.group.position;
  particles.burst(pp.clone().setY(1.2), 10,
    {r:1,g:0.9,b:0.4, spread:3, size:6, life:0.6});
  if(def.isWeapon){
    const w = WEAPONS_BY_ID[def.weaponId];
    const hadBefore = !!progress.gearOf('weapon', def.weaponId);
    if(!p.weapons.includes(def.weaponId)) p.addWeapon(def.weaponId); // always usable this hunt once found
    if(hadBefore){
      const r = progress.addDupe('weapon', def.weaponId, w.rarity);
      audio.gearUp(r.starredTo || 1); // a star-up is not a UI click
      announce(r.starredTo ? `⭐ ${def.name} ★${r.starredTo} — stronger in every hunt from now on`
        : r.maxed ? `✦ ${def.name} is maxed — this dupe refined into coins`
        : `${def.name} shard ${r.dupes}/${r.need} — find ${r.need-r.dupes} more for ★`, r.starredTo ? 'cool' : 'good');
    } else {
      progress.ownGear('weapon', def.weaponId);
      audio.unlock();
      announce(def.icon + ' ' + def.name + ' unlocked — press ' + (p.weapons.indexOf(def.weaponId)+1) + ' to wield it', 'cool');
    }
    updateBackpack(); updateHUD();
    return;
  }
  if(def.isRing){
    equipRing(def.ringId);
    updateHUD();
    return;
  }
  if(def.isPotion){
    const pdef = POTIONS_BY_ID[def.potionId];
    p.addPotion(def.potionId);
    audio.powerup();
    announce(def.icon + ' ' + def.name + ' — press ' + pdef.key + ' when you need it', 'good');
    updateBackpack();
    return;
  }
  if(def.isArmor){
    const a = ARMOR_BY_ID[def.armorId];
    const hadBefore = !!progress.gearOf('armor', def.armorId);
    if(!p.armorOwned[def.slot].includes(def.armorId)) p.addArmor(def.slot, def.armorId);
    if(hadBefore){
      const r = progress.addDupe('armor', def.armorId, a.rarity);
      audio.gearUp(r.starredTo || 1);
      announce(r.starredTo ? `⭐ ${def.name} ★${r.starredTo} — stronger in every hunt from now on`
        : r.maxed ? `✦ ${def.name} is maxed — this dupe refined into coins`
        : `${def.name} shard ${r.dupes}/${r.need} — find ${r.need-r.dupes} more for ★`, r.starredTo ? 'cool' : 'good');
    } else {
      progress.ownGear('armor', def.armorId);
      audio.unlock();
      announce(def.icon + ' ' + def.name + ' unlocked — equip it from the Backpack (B)', 'cool');
    }
    updateBackpack(); updateHUD();
    return;
  }
  if(def.isEssence){
    game.runEssences[def.rarity] += def.amount;
    progress.collect(def.rarity, def.amount);
    audio.essence(def.rarity);
    rewardPops.pop(pp.x, pp.y+1.2, pp.z, Math.min(4, def.amount));
    updateHUD();
    return;
  }
  if(def.isCoin){
    progress.coins += def.amount;
    progress.saveCoins();
    audio.pickup();
    rewardPops.pop(pp.x, pp.y+1.2, pp.z, Math.min(5, 1+(def.amount/4|0)));
    updateHUD();
    return;
  }
  const BOOST_DUR = 18, BOOST_CAP = 45; // orb boosts are temporary — stack duration, not power
  switch(def.id){
    case 'dmg': p.boostTimers.dmg = Math.min(BOOST_CAP, p.boostTimers.dmg + BOOST_DUR); break;
    case 'spd': p.boostTimers.spd = Math.min(BOOST_CAP, p.boostTimers.spd + BOOST_DUR); break;
    case 'dash': p.dashCd = 0; p.dashMaxCd = Math.max(0.8, p.dashMaxCd-0.25); break;
    case 'shield': p.boostTimers.shield = Math.min(BOOST_CAP, p.boostTimers.shield + BOOST_DUR); break;
    case 'jump': p.boostTimers.jump = Math.min(BOOST_CAP, p.boostTimers.jump + BOOST_DUR); break;
    case 'magnet': p.boostTimers.magnet = Math.min(BOOST_CAP, p.boostTimers.magnet + BOOST_DUR); break;
    case 'hp': p.hp = Math.min(p.maxHp, p.hp+25); break;
  }
  audio.powerup();
  announce(def.icon + ' ' + def.name + ' — ' + BOOST_HINT[def.id], 'good');
  updateHUD(); updateBuffs();
};
// item 48: a pickup banner should tell you what to DO with the thing you just picked up
const BOOST_HINT = {
  dmg:'swing into the pack while it lasts', spd:'outrun the lunges now',
  dash:'dash is ready — use it through a ring', shield:'take one hit for free',
  jump:'double-jump the ledges you skipped', magnet:'sweep the drops you left behind',
  hp:'topped up — push deeper',
};
game.updateBuffs = updateBuffs;
game.updateBackpack = ()=>updateBackpack();
/* item 45: a HUD slot IS the control. Clicking it and pressing its key are the same action,
   routed through one function each so the two can never diverge. */
function selectWeapon(id){
  const p = game.player;
  if(game.state !== 'play' || !p || !id || !p.weapons.includes(id) || id === p.equipped) return false;
  p.equipWeapon(id); updateBackpack(); audio.click();
  return true;
}
function drinkPotion(id){
  const p = game.player;
  if(game.state !== 'play' || !p || !p.usePotion(id, game)) return false;
  updateBackpack();
  return true;
}
// A slot has to be reachable without a mouse. stopPropagation matters: Space is also jump, and
// the window-level handler would otherwise fire on top of the activation.
function makeActivatable(el, fn){
  el.tabIndex = 0;
  el.onclick = fn;
  el.onkeydown = e=>{
    if(e.code !== 'Enter' && e.code !== 'Space') return;
    e.preventDefault(); e.stopPropagation(); fn();
  };
}
function updateBackpack(){
  const p = game.player; if(!p) return;
  // weapon slots (1-7)
  const wEl = document.getElementById('bpWeapons');
  wEl.innerHTML = '';
  p.weapons.forEach((id, i)=>{
    const w = WEAPONS_BY_ID[id];
    const stars = (progress.gearOf('weapon', id) || {}).stars || 0;
    const eq = id === p.equipped;
    const d = document.createElement('div');
    d.className = 'hotslot' + (eq ? ' active sel' : '');
    d.style.setProperty('--rc', RARITY_COLORS[w.rarity]);
    d.dataset.weapon = String(i+1);      // the CSS hover/active/focus states hang off these,
    d.dataset.weaponId = id;             // and they double as the playwright/keyboard handle
    d.title = w.name + ' — press ' + (i+1) + ' or click to wield';
    d.setAttribute('aria-label', d.title);
    d.innerHTML = `<span class="hnum">${i+1}</span>${w.icon}${stars>0?`<span class="htier">★${stars}</span>`:''}`;
    makeActivatable(d, ()=> selectWeapon(id));
    wEl.appendChild(d);
  });
  // potion slots (fixed Q/E/R/F/G — always shown so the player learns the layout, greyed out at 0)
  const pEl = document.getElementById('bpPotions');
  pEl.innerHTML = '';
  for(const def of POTIONS){
    const count = p.potions[def.id] || 0;
    const timer = p.potionTimers[def.id] || 0;
    const d = document.createElement('div');
    /* item 11 + item 01. A healing drop is only useful if the player NOTICES it at the moment it
       matters, and the moment it matters is not the moment they picked it up. So a held heal
       whose owner is under a third HP gets `urgent`, which pulses the slot. Deliberately gated on
       BOTH conditions: a pulse with no potion is nagging, and a pulse at full health is noise —
       either one trains the player to ignore the slot, which is worse than no cue at all. */
    const urgent = def.kind === 'heal' && count > 0 && p.hp/p.maxHp < 0.34;
    // a count of 0 is information, so say it with .zero instead of leaving the slot ambiguous
    d.className = 'potslot' + (count>0 ? ' has' : ' zero') + (timer>0 ? ' active sel' : '')
      + (urgent ? ' urgent' : '');
    d.style.setProperty('--pc', '#'+def.color.toString(16).padStart(6,'0'));
    d.dataset.potion = def.id;
    d.dataset.potionKey = def.key;
    d.title = def.name + ' — ' + def.desc + (count>0 ? ' · press ' + def.key + ' or click' : ' · none held');
    d.setAttribute('aria-label', d.title);
    d.innerHTML = `<span class="pkey">${def.key}</span>${def.icon}` +
      (count>0 ? `<span class="pcnt">${count}</span>` : '') +
      (timer>0 ? `<span class="ptimer">${Math.ceil(timer)}s</span>` : '');
    makeActivatable(d, ()=> drinkPotion(def.id));
    pEl.appendChild(d);
  }
  updateGearHud();
}
function updateGearHud(){
  const p = game.player; if(!p) return;
  const el = document.getElementById('gearhud');
  el.innerHTML = '';
  for(const slot of ARMOR_SLOTS){
    const id = p.armor[slot];
    const d = document.createElement('div');
    d.className = 'gearslot' + (id ? ' on sel' : ' zero');
    d.dataset.gear = slot;
    if(id){
      const a = ARMOR_BY_ID[id];
      const stars = (progress.gearOf('armor', id) || {}).stars || 0;
      d.style.setProperty('--rc', RARITY_COLORS[a.rarity]);
      d.title = a.name + ' — click to swap your ' + slot + ' in the Backpack';
      d.innerHTML = a.icon + (stars>0?`<span class="gt">★${stars}</span>`:'');
    } else {
      d.innerHTML = SLOT_ICON[slot];
      d.title = 'No ' + slot + ' equipped — click to open the Backpack';
    }
    d.setAttribute('aria-label', d.title);
    // the slot names the thing you change; clicking it goes where you change it
    makeActivatable(d, ()=>{ if(game.state === 'play' || game.state === 'inventory') openInventory(); });
    el.appendChild(d);
  }
}
// diff-based: only touches the DOM when a buff turns on/off or its displayed
// second actually changes, instead of tearing down and rebuilding every frame
const buffNodes = {}; // id -> { el, numEl, lastShown }
function updateBuffs(){
  const p = game.player; if(!p) return;
  const el = document.getElementById('buffs');
  for(const def of POWERUPS){
    if(def.id === 'dash' || def.id === 'hp') continue; // instant effects, nothing to show
    const t = p.boostTimers[def.id];
    const shown = t > 0 ? Math.ceil(t) : 0;
    let node = buffNodes[def.id];
    if(shown > 0 && !node){
      const d = document.createElement('div');
      d.className = 'buff'; d.title = def.name;
      d.innerHTML = def.icon + `<span class="n"></span>`;
      const numEl = d.querySelector('.n');
      el.appendChild(d);
      node = buffNodes[def.id] = { el:d, numEl, lastShown:-1 };
    } else if(shown <= 0 && node){
      node.el.remove();
      delete buffNodes[def.id];
      node = null;
    }
    if(node && shown !== node.lastShown){
      node.numEl.textContent = shown + 's';
      node.el.title = def.name + ' — ' + shown + 's left';
      node.lastShown = shown;
    }
  }
}

/* ---------- HUD ---------- */
const RARITY_COLORS = ['#8a6a42','#4aa832','#db3a3a','#3a7fe0','#9a3ae0','#ff5ad0'];
// updateHUD() runs every frame, so every write below is diffed against what is already on the
// element. The expando is deliberate: it keeps the last-written value next to the node it
// belongs to, so no bookkeeping table can fall out of sync with the DOM.
function setText(el, txt){ if(el.__t !== txt){ el.__t = txt; el.textContent = txt; } }
function setWidth(el, pct){ const w = pct.toFixed(1)+'%'; if(el.__w !== w){ el.__w = w; el.style.width = w; } }
/* ---------- eased counters (item 44) ----------
   A payout that snaps reads as a number changing. A payout that counts up reads as a payout.
   The DISPLAYED value chases the true one and snaps inside an epsilon; the DOM is touched only
   when the rounded display changes, so a value that isn't moving costs nothing per frame. */
const counters = {};
function counter(id, el, fmt, opts={}){
  counters[id] = { el, fmt, shown:0, target:0, last:null, zeroEl: opts.zero === true ? el : opts.zero || null };
  return counters[id];
}
function setCounter(id, value){ const c = counters[id]; if(c) c.target = value; }
function repaintCounter(id){ const c = counters[id]; if(c) c.last = null; } // label text changed under us
function tickCounters(dt){
  const k = Math.min(1, dt*8); // ~0.35s to close a payout — long enough to see, short enough to trust
  for(const id in counters){
    const c = counters[id];
    const d = c.target - c.shown;
    if(d !== 0) c.shown = Math.abs(d) < 0.6 ? c.target : c.shown + d*k;
    const v = Math.round(c.shown);
    if(v === c.last) continue;
    c.last = v;
    c.el.textContent = c.fmt(v);
    if(c.zeroEl) c.zeroEl.classList.toggle('zero', v === 0);
  }
}
counter('coins', document.getElementById('coinhud'), v=>'🪙 '+v, { zero:true });
counter('myco',  document.getElementById('mycohud'), v=>'🌿 '+v, { zero:true });
// The lockpick wallet is index.html's #lockpickcell now: the plaque swaps its own label between
// "LOCKPICKS" and "NONE — BURST A POD" off the .zero class, so main.js only supplies the number.
counter('lockpicks', document.getElementById('lockpickval'), v=>String(v),
  { zero: document.getElementById('lockpickcell') });
counter('ess', document.getElementById('esshud'), v=>'✦ '+v, { zero:true });
// kills: six rows built once. This used to be an innerHTML rebuild every single frame.
{
  const k = document.getElementById('kills');
  k.innerHTML = RARITY_COLORS.map(c=>
    `<div class="row"><span class="kn">0</span> <span class="dot" style="background:${c}"></span></div>`).join('');
  for(let i=0;i<RARITY_COLORS.length;i++){
    const row = k.children[i];
    // the whole row greys out at 0, dot included — a rarity you have not met yet is information
    counter('kill'+i, row.querySelector('.kn'), v=>String(v), { zero: row });
  }
}
counter('xp', document.getElementById('xplabel'), v=>`LEVEL ${game.level} — ${v} / ${xpNeed()} XP`);
let hudLevel = -1, hudLowHp = false;
function updateHUD(){
  const p = game.player; if(!p) return;
  // item 48: the useful message at low HP is the counterplay, not the fact. Latched with
  // hysteresis so it fires on the way down and re-arms only after you have actually recovered.
  const hpFrac = p.hp/p.maxHp;
  if(!hudLowHp && hpFrac < 0.28 && game.state === 'play'){
    hudLowHp = true;
    announce('Nearly out — F drinks Vitality, Shift dashes you clear', 'bad');
  } else if(hudLowHp && hpFrac > 0.5) hudLowHp = false;
  setWidth(document.getElementById('hpfill'), p.hp/p.maxHp*100);
  // xp bar + level badge — the bar tracks the EASED xp so bar and label can't disagree
  const need = xpNeed();
  if(game.level !== hudLevel){ hudLevel = game.level; repaintCounter('xp'); } // "/ need" changed
  setCounter('xp', game.xp);
  setWidth(document.getElementById('xpfill'), Math.min(100, counters.xp.shown/need*100));
  setText(document.getElementById('lvlbadge'), String(game.level));
  // dash pips
  const pips = document.getElementById('pips');
  const nPips = 3;
  if(pips.children.length !== nPips){
    pips.innerHTML=''; for(let i=0;i<nPips;i++){ const d=document.createElement('div'); d.className='pip'; pips.appendChild(d); }
  }
  const frac = 1 - p.dashCd/p.dashMaxCd;
  for(let i=0;i<nPips;i++){
    const cls = 'pip' + (frac*nPips > i ? ' full' : '');
    if(pips.children[i].className !== cls) pips.children[i].className = cls;
  }
  for(let i=0;i<game.kills.length;i++) setCounter('kill'+i, game.kills[i]);
  setCounter('coins', progress.coins);
  setCounter('myco', progress.myco);
  setCounter('lockpicks', progress.lockpicks);
  setCounter('ess', progress.bank.reduce((a,b)=>a+b, 0));
  updateWorldLine();
  /* item 11: the heal slot's `urgent` state depends on HP, which changes constantly, but
     updateBackpack() rebuilds DOM — so it is driven off a LATCH, not off the HP value. One rebuild
     when the threshold is crossed in either direction, never one per frame. This is the same
     diff-based rule the rest of the HUD follows; the only difference is that the thing being
     diffed is a boolean derived from two values rather than a string. */
  const wantUrgent = (p.potions.vitality|0) > 0 && p.hp/p.maxHp < 0.34;
  if(wantUrgent !== healUrgent){ healUrgent = wantUrgent; updateBackpack(); }
  // zone
  const d = Math.hypot(p.group.position.x, p.group.position.z);
  const z = d<40?'MEADOW':d<90?'DEEPWOOD':d<140?'GLOAM':'HEART OF THE BLOOM';
  setText(document.getElementById('zone'), '— '+z+(progress.depth>1?' · DEPTH '+progress.depth:'')+' —');
  if(!game.bossSpawned)
    setText(document.getElementById('objective'), `Slay ${8-game.rareKills} more rare+ mushroom${8-game.rareKills===1?'':'s'} to lure the Bloom's ruler out`);
  if(game.boss)
    setWidth(document.getElementById('bossfill'), Math.max(0, game.boss.hp/game.boss.maxHp*100));
}

/* index.html's #worldline asks the cheapest possible "what now": how much of this world is still
   worth the walk. Diff-based like every other HUD write — the string only reaches the DOM when one
   of the counts actually changes. */
let healUrgent = false;   // latch for the urgent heal slot; see updateHUD
function updateWorldLine(){
  const el = document.getElementById('worldline');
  if(!el) return;
  if(!props){ setText(el, 'Scouting the valley…'); return; }
  let pods = 0, chests = 0, gems = 0, crit = 0;
  for(const p of props.pods) if(!p.spent) pods++;
  for(const c of props.chests) if(!c.open) chests++;
  for(const t of props.treasures) if(!t.collected) gems++;
  if(fauna) for(const c of fauna.critters) if(!c.dead && !c.dying) crit++;
  const parts = [];
  // 🌸, not 🫧: item 03 grew the pods a corolla, and the tracker glyph has to match the thing the
  // player is looking for or the count names something they cannot find.
  if(pods) parts.push('🌸 ' + pods + ' pods');
  if(chests) parts.push('🧰 ' + chests + ' chests');
  if(crit) parts.push('🐛 ' + crit + ' critters');
  if(gems) parts.push('💎 ' + gems + ' gems');
  setText(el, parts.length ? parts.join(' · ') : 'Valley picked clean');
}

/* ---------- SPORE TOME (meta inventory) ---------- */
const ESS_NAMES = ['Umber Spore','Verdant Spore','Ember Spore','Azure Spore','Amethyst Spore','Prism Spore'];
const ESS_COLORS = RARITY_COLORS;
let tomeReturn = 'title';
let tomeTab = 'alchemy';
function essCostHtml(cost){
  return Object.entries(cost).map(([i,n])=>{
    const lack = progress.bank[i] < n;
    return `<span class="ci${lack?' lack':''}"><span class="cdot" style="background:${ESS_COLORS[i]}"></span>${n}</span>`;
  }).join('');
}
function renderTome(){
  const p = game.player;
  // LEFT PAGE — hunter record
  const left = $('tomeleft');
  const killsRows = RARITIES.map((r,i)=>
    `<div class="essrow"><div class="essdot" style="background:${ESS_COLORS[i]}"></div>${r.name}
     <span class="cnt">${game.kills[i]} slain</span></div>`).join('');
  const essRows = RARITIES.map((r,i)=>
    `<div class="essrow"><div class="essdot" style="background:${ESS_COLORS[i]}"></div>${ESS_NAMES[i]}
     <span class="life">(lifetime ${progress.lifetime[i]})</span><span class="cnt">✦ ${progress.bank[i]}</span></div>`).join('');
  const contractRows = progress.contracts.map(c=>{
    const f = contractFace(c);
    return `<div class="essrow"><div class="essdot" style="background:${f.tint}"></div>${f.icon} ${f.label}
     <span class="cnt">${c.have}/${c.need} → +${c.reward} 🌿</span></div>`;
  }).join('');
  left.innerHTML = `
    <h2>Spore Tome</h2><div class="subtitle">THE HUNTER'S RECORD</div>
    <div class="tstat"><span>World seed</span><b>#${game.seed}</b></div>
    <div class="tstat"><span>Realm</span><b>${world.theme.name}</b></div>
    <div class="tstat"><span>World Depth</span><b>🌀 ${progress.depth}${progress.depth>1?' (mobs +'+Math.round((progress.depth-1)*15)+'%)':''}</b></div>
    <div class="tstat"><span>Level</span><b>${game.level}</b></div>
    <div class="txp"><div class="barlabel">XP ${game.xp} / ${xpNeed()}</div>
      <div class="bar"><div class="fill" style="width:${Math.min(100,game.xp/xpNeed()*100)}%;background:linear-gradient(180deg,#fff3a0,#ffb52e)"></div></div></div>
    <div class="tstat"><span>Damage</span><b>${Math.round((p?p.baseDmg:14)*(p?p.dmgMult:1))}</b></div>
    <div class="tstat"><span>Move speed</span><b>${((p?p.speed:8)*(p?p.speedMult:1)).toFixed(1)}</b></div>
    <div class="tstat"><span>Max HP</span><b>${p?p.maxHp:100}</b></div>
    <div class="tstat"><span>Total kills</span><b>${game.totalKills}</b></div>
    <div class="tstat"><span>Mycelium</span><b>🌿 ${progress.myco}</b></div>
    <h3>Harvest Contracts</h3>${contractRows}
    <div class="essrow" style="opacity:.7;font-size:12px">Press <b>H</b> near a small glowing mushroom to harvest it toward these.</div>
    <h3>Spore Essences</h3>${essRows}
    <h3>Bestiary</h3>${killsRows}`;
  // RIGHT PAGE — spore alchemy / equipment collection (tabbed)
  const right = $('tomeright');
  const tabTitles = { alchemy:'Spore Alchemy', equipment:'Equipment Collection' };
  const tabSubs = { alchemy:'PERMANENT MUTATIONS', equipment:'STARS FROM DUPLICATES · LEVELS FROM COINS' };
  right.innerHTML = `<h2>${tabTitles[tomeTab]}</h2>
    <div class="tometabs">
      <button class="ttab${tomeTab==='alchemy'?' on':''}" id="ttab-alch">MUTATIONS</button>
      <button class="ttab${tomeTab==='equipment'?' on':''}" id="ttab-equip">EQUIPMENT</button>
    </div>
    <div class="subtitle">${tabSubs[tomeTab]}</div>`;
  $('ttab-alch').onclick = ()=>{ tomeTab='alchemy'; renderTome(); };
  $('ttab-equip').onclick = ()=>{ tomeTab='equipment'; renderTome(); };

  if(tomeTab==='alchemy'){
    for(const m of MUTATIONS){
      const tier = progress.tierOf(m.id);
      const maxed = tier >= 3;
      const cost = progress.nextCost(m.id);
      const afford = progress.canAfford(m.id);
      const div = document.createElement('div');
      div.className = 'mut' + (maxed ? ' maxed' : afford ? '' : ' locked');
      div.innerHTML = `
        <div class="icon" style="color:${m.color}">${m.icon}</div>
        <div class="info">
          <div class="mname">${m.name} <span style="color:#8a6a3f;font-size:12px">${tier? '— Tier '+tier : ''}</span></div>
          <div class="mdesc">${m.desc}${maxed?' (MAX)':` ×${tier+1}`}</div>
          <div class="pips">${[1,2,3].map(i=>`<div class="pip2${i<=tier?' on':''}"></div>`).join('')}</div>
          ${maxed ? '' : `<div class="cost">Cost: ${essCostHtml(cost)}</div>`}
        </div>`;
      const btn = document.createElement('button');
      btn.className = 'mutbtn';
      btn.textContent = maxed ? 'MAXED' : tier ? 'MUTATE' : 'UNLOCK';
      if(!maxed && afford){
        btn.onclick = ()=>{
          if(progress.buy(m.id)){
            audio.init(); audio.mutate();
            applyMutations();
            renderTome(); updateHUD();
          }
        };
      } else btn.disabled = !maxed;
      div.appendChild(btn);
      right.appendChild(div);
    }
  } else {
    const weaponIds = Object.keys(progress.weaponGear);
    const armorIds = Object.keys(progress.armorGear);
    if(!weaponIds.length && !armorIds.length){
      right.insertAdjacentHTML('beforeend', '<div class="invhint2" style="margin:10px 0">No gear found yet — weapons and armor you find on any hunt join your permanent collection here, and every duplicate you find after that stars it up.</div>');
    }
    if(weaponIds.length){
      right.insertAdjacentHTML('beforeend', '<h3>⚔️ Weapons</h3>');
      for(const id of weaponIds){
        const w = WEAPONS_BY_ID[id]; if(!w) continue;
        right.appendChild(renderGearCard('weapon', id, w));
      }
    }
    if(armorIds.length){
      right.insertAdjacentHTML('beforeend', '<h3>🪖 Armor</h3>');
      for(const id of armorIds){
        const a = ARMOR_BY_ID[id]; if(!a) continue;
        right.appendChild(renderGearCard('armor', id, a));
      }
    }
  }
}
// shared collection-card renderer for the Tome's Equipment tab — same math, same look,
// whether it's a weapon or a piece of armor. stars come from finding duplicates (see
// applyPowerup/addDupe); levels are bought with coins, capped by the current star tier.
function renderGearCard(kind, id, def){
  const info = progress.gearInfo(kind, id, def.rarity);
  const div = document.createElement('div');
  div.className = 'mut' + (info.maxedStars && info.maxedLevel ? ' maxed' : '');
  const slotTag = kind==='armor' ? ` <span style="color:#8a6a3f;font-size:12px">(${def.slot})</span>` : '';
  const dupeLine = info.maxedStars ? 'MAX STARS' : `${info.dupes}/${info.dupesNeed} dupes to next ★`;
  div.innerHTML = `
    <div class="icon" style="color:${RARITY_COLORS[def.rarity]}">${def.icon}</div>
    <div class="info">
      <div class="mname">${def.name}${slotTag}</div>
      <div class="mdesc">${def.desc}</div>
      <div class="pips" title="${info.stars}/6 stars">${Array.from({length:6},(_,i)=>`<div class="pip2${i<info.stars?' on':''}"></div>`).join('')}</div>
      <div class="gearline">Lv.${info.level}${info.maxedLevel?' (MAX)':'/'+info.levelCap} &nbsp;•&nbsp; ×${info.mult.toFixed(2)} power &nbsp;•&nbsp; ${dupeLine}</div>
    </div>`;
  const btn = document.createElement('button');
  btn.className = 'mutbtn';
  if(info.maxedLevel){
    btn.textContent = 'MAX LEVEL'; btn.disabled = true;
  } else {
    btn.textContent = `+LEVEL 🪙${info.levelCost}`;
    if(progress.coins >= info.levelCost){
      btn.onclick = ()=>{
        if(progress.levelUpGear(kind, id)){ audio.gearUp(info.stars); renderTome(); updateHUD(); updateBackpack(); }
      };
    } else btn.disabled = true;
  }
  div.appendChild(btn);
  return div;
}
function openTome(){
  if(game.state === 'tome') return;
  tomeReturn = game.state;
  if(game.state === 'play'){ game.state = 'tome'; document.exitPointerLock?.(); releaseHeld(); }
  else game.state = 'tome';
  renderTome();
  ['title','intro','pause','gameover','victory'].forEach(x=>$(x).classList.add('hidden'));
  $('tome').classList.remove('hidden');
  audio.init(); audio.click();
}
function closeTome(){
  $('tome').classList.add('hidden');
  game.state = tomeReturn;
  if(tomeReturn === 'play') grabPointer();
  const overlayFor = { title:'title', intro:'intro', pause:'pause', over:'gameover', win:'victory' };
  if(overlayFor[tomeReturn]) show(overlayFor[tomeReturn]);
}
game.openTome = openTome; game.closeTome = closeTome;

/* ---------- INVENTORY (run-scoped weapon loadout) ---------- */
let invReturn = 'play';
function renderInventory(){
  const p = game.player; if(!p) return;
  const el = $('invgrid');
  el.innerHTML = '';
  for(const id of p.weapons){
    const w = WEAPONS_BY_ID[id];
    const info = progress.gearInfo('weapon', id, w.rarity);
    const eq = id === p.equipped;
    const div = document.createElement('div');
    div.className = 'invitem' + (eq ? ' active' : '');
    div.style.setProperty('--rc', RARITY_COLORS[w.rarity]);
    const dmgTotal = Math.round((p.baseDmg + w.dmg) * p.dmgMult * info.mult);
    div.innerHTML = `
      <div class="iicon">${w.icon}</div>
      <div class="iinfo">
        <div class="iname">${w.name}${eq?' <span class="ieq">EQUIPPED</span>':''}</div>
        <div class="idesc">${w.desc}</div>
        <div class="istats">
          <span>⚔ ${dmgTotal} dmg</span>
          <span>⏱ ${w.atkSpeed<1?'+':w.atkSpeed>1?'−':''}${Math.abs(Math.round((1-w.atkSpeed)*100))}% speed</span>
          <span>✦ +${Math.round(w.crit*100)}% crit</span>
        </div>
        <div class="pips" title="${info.stars}/6 stars">${Array.from({length:6},(_,i)=>`<div class="pip2${i<info.stars?' on':''}"></div>`).join('')}</div>
        <div class="glvl">Lv.${info.level}${info.maxedLevel?' MAX':'/'+info.levelCap}</div>
      </div>`;
    const btnRow = document.createElement('div'); btnRow.className = 'ibtnrow';
    if(!eq){
      const eqBtn = document.createElement('button');
      eqBtn.className = 'invbtn'; eqBtn.textContent = 'EQUIP';
      eqBtn.onclick = ()=>{ p.equipWeapon(id); updateBackpack(); renderInventory(); audio.click(); };
      btnRow.appendChild(eqBtn);
    }
    if(!info.maxedLevel){
      const lvlBtn = document.createElement('button');
      lvlBtn.className = 'invbtn'; lvlBtn.textContent = `+LVL 🪙${info.levelCost}`;
      lvlBtn.disabled = progress.coins < info.levelCost;
      lvlBtn.onclick = ()=>{ if(progress.levelUpGear('weapon', id)){ audio.gearUp(info.stars); updateBackpack(); renderInventory(); } };
      btnRow.appendChild(lvlBtn);
    }
    div.appendChild(btnRow);
    el.appendChild(div);
  }
  // potions section
  const pel = $('invpotions');
  pel.innerHTML = '';
  for(const def of POTIONS){
    const count = p.potions[def.id] || 0;
    const timer = p.potionTimers[def.id] || 0;
    const div = document.createElement('div');
    div.className = 'invitem invpotion' + (count<=0 ? ' empty' : '');
    div.style.setProperty('--rc', '#'+def.color.toString(16).padStart(6,'0'));
    div.innerHTML = `
      <div class="iicon">${def.icon}</div>
      <div class="iinfo">
        <div class="iname">${def.name} <span style="opacity:.7;font-weight:600">×${count}</span>${timer>0?` <span class="ieq">ACTIVE ${Math.ceil(timer)}s</span>`:''}</div>
        <div class="idesc">${def.desc}</div>
        <div class="istats"><span>Key: ${def.key}</span></div>
      </div>`;
    if(count > 0){
      const btn = document.createElement('button');
      btn.className = 'invbtn'; btn.textContent = 'DRINK';
      btn.onclick = ()=>{ if(p.usePotion(def.id, game)){ updateBackpack(); renderInventory(); } };
      div.appendChild(btn);
    }
    pel.appendChild(div);
  }
  // gear section (helmet / ring / charm)
  const gel = $('invgear');
  gel.innerHTML = '';
  for(const slot of ARMOR_SLOTS){
    for(const id of p.armorOwned[slot]){
      const a = ARMOR_BY_ID[id];
      const info = progress.gearInfo('armor', id, a.rarity);
      const eq = p.armor[slot] === id;
      const div = document.createElement('div');
      div.className = 'invitem' + (eq ? ' active' : '');
      div.style.setProperty('--rc', RARITY_COLORS[a.rarity]);
      const statLine = Object.entries(a)
        .filter(([k])=>['hp','dmgReduction','crit','atkSpeed','dmg','magnet','dropBonus','lifesteal'].includes(k))
        .map(([k,v])=>{
          const val = k==='hp' ? Math.round(v*info.mult) : Math.round(v*info.mult*100)+'%';
          return `<span>${k} +${val}</span>`;
        }).join('');
      div.innerHTML = `
        <div class="iicon">${a.icon}</div>
        <div class="iinfo">
          <div class="iname">${a.name}${eq?' <span class="ieq">EQUIPPED</span>':''} <span style="opacity:.6;font-size:11px">(${slot})</span></div>
          <div class="idesc">${a.desc}</div>
          <div class="istats">${statLine}</div>
          <div class="pips" title="${info.stars}/6 stars">${Array.from({length:6},(_,i)=>`<div class="pip2${i<info.stars?' on':''}"></div>`).join('')}</div>
          <div class="glvl">Lv.${info.level}${info.maxedLevel?' MAX':'/'+info.levelCap}</div>
        </div>`;
      const btnRow = document.createElement('div'); btnRow.className = 'ibtnrow';
      if(!eq){
        const eqBtn = document.createElement('button');
        eqBtn.className = 'invbtn'; eqBtn.textContent = 'EQUIP';
        eqBtn.onclick = ()=>{ p.equipArmor(slot, id, game); updateHUD(); updateGearHud(); renderInventory(); audio.click(); };
        btnRow.appendChild(eqBtn);
      }
      if(!info.maxedLevel){
        const lvlBtn = document.createElement('button');
        lvlBtn.className = 'invbtn'; lvlBtn.textContent = `+LVL 🪙${info.levelCost}`;
        lvlBtn.disabled = progress.coins < info.levelCost;
        lvlBtn.onclick = ()=>{ if(progress.levelUpGear('armor', id)){ audio.gearUp(info.stars); updateHUD(); updateGearHud(); renderInventory(); } };
        btnRow.appendChild(lvlBtn);
      }
      div.appendChild(btnRow);
      gel.appendChild(div);
    }
  }
  if(ARMOR_SLOTS.every(slot=>p.armorOwned[slot].length===0)){
    gel.innerHTML = '<div class="invhint2" style="margin:8px 0">No gear found yet this hunt — helmets, rings and charms drop from kills.</div>';
  }
}
function openInventory(){
  if(game.state === 'inventory') return;
  invReturn = game.state;
  if(game.state === 'play'){ game.state = 'inventory'; document.exitPointerLock?.(); releaseHeld(); }
  else game.state = 'inventory';
  renderInventory();
  ['title','intro','pause','gameover','victory'].forEach(x=>$(x).classList.add('hidden'));
  $('inventory').classList.remove('hidden');
  audio.init(); audio.click();
}
function closeInventory(){
  $('inventory').classList.add('hidden');
  game.state = invReturn;
  if(invReturn === 'play') grabPointer();
}
game.openInventory = openInventory; game.closeInventory = closeInventory;

/* ---------- input ---------- */
/* item 58: held state is only ever as correct as its release paths. Anything held must be
   released by keyup AND by every way focus can leave: window blur, tab hide, pointerup,
   pointercancel and pointerleave. A channelled ability that only listens to keyup keeps
   channelling after an alt-tab, because keyup is delivered to the window that has focus. */
const keys = {};
const holds = {};   // name -> release fn, for anything held longer than one frame
function beginHold(name, onRelease){ if(holds[name]) return false; holds[name] = onRelease || null; return true; }
function endHold(name){ const r = holds[name]; if(r === undefined) return false; delete holds[name]; if(r) r(); return true; }
function releaseHeld(){
  for(const k in keys) keys[k] = false;           // the whole map, not just movement keys
  for(const n in holds) endHold(n);
  if(game.player && game.player.moveInput) game.player.moveInput.set(0,0,0);
}
game.beginHold = beginHold; game.endHold = endHold; game.releaseHeld = releaseHeld;
game.heldKeys = ()=> Object.keys(keys).filter(k=>keys[k]).concat(Object.keys(holds).map(h=>'hold:'+h)); // for verification
addEventListener('blur', releaseHeld);
document.addEventListener('visibilitychange', ()=>{ if(document.hidden) releaseHeld(); });
// pointer releases are separate events on purpose: a drag that ends outside the canvas fires
// pointercancel or pointerleave and never pointerup, which is exactly how a channel gets stuck.
for(const ev of ['pointerup','pointercancel','pointerleave']) addEventListener(ev, ()=>{ for(const n in holds) endHold(n); });
addEventListener('keydown', e=>{
  keys[e.code] = true;
  if(e.code === 'KeyM'){ audio.init(); const m = audio.toggleMute();
    document.getElementById('mutebtn').textContent = 'MUTE: '+(m?'ON':'OFF'); }
  if(e.code === 'Escape' && game.state === 'play') pauseGame();
  else if(e.code === 'Escape' && game.state === 'pause') resumeGame();
  else if(e.code === 'Escape' && game.state === 'tome') closeTome();
  else if(e.code === 'Escape' && game.state === 'inventory') closeInventory();
  if((e.code === 'Tab' || e.code === 'KeyI') && (game.state === 'play' || game.state === 'pause' || game.state === 'tome')){
    e.preventDefault();
    if(game.state === 'tome') closeTome(); else openTome();
  }
  if(e.code === 'KeyB' && (game.state === 'play' || game.state === 'pause' || game.state === 'inventory')){
    e.preventDefault();
    if(game.state === 'inventory') closeInventory(); else openInventory();
  }
  if(/^Digit[1-7]$/.test(e.code) && game.state === 'play'){
    const idx = parseInt(e.code.slice(5), 10) - 1;
    selectWeapon(game.player && game.player.weapons[idx]); // same path the HUD slot click takes
  }
  const potionKey = { KeyQ:'power', KeyE:'haste', KeyR:'swift', KeyF:'vitality', KeyG:'fortify' }[e.code];
  if(potionKey) drinkPotion(potionKey);
  // e.repeat guard: auto-repeat is not a second press. Without it, holding Space burns both
  // jumps in one keystroke and holding Shift re-triggers the dash the instant it comes off cd.
  if(e.code === 'Space'){ e.preventDefault(); if(!e.repeat) tryJump(); }
  if(e.code === 'KeyH' && game.state === 'play') tryHarvest();
  // e.repeat guard: holding the key must not spend a lockpick per frame
  if(e.code === INTERACT_KEY && !e.repeat && game.state === 'play') tryInteract();
});
addEventListener('keyup', e=>{ keys[e.code] = false; endHold(e.code); });
addEventListener('mousedown', e=>{
  if(game.state==='play' && e.button===0 && document.pointerLockElement) game.player.attack(game);
});
/* item 03 — a jump is a REQUEST, not an event. bufferJump() remembers the press for JUMP_BUF and
   fires it on the landing frame, and accepts one up to COYOTE after walking off a ledge as a
   ground jump. That forgiveness is what makes a four-tier rock formation climbable at speed
   instead of a series of pixel-perfect launches. The cue hangs off p.onJump (set in resetRun),
   never off the return value, because a buffered jump leaves the ground on a later frame. */
function tryJump(){
  const p = game.player;
  if(game.state!=='play' || !p) return;
  p.bufferJump();
}
addEventListener('keydown', e=>{ if(e.code==='ShiftLeft' && !e.repeat && game.state==='play') game.player.startDash(game); });

/* pointer lock — a browser refusing it (headless, iframe, user gesture rules) is a refusal,
   not an error, so every call site goes through here and swallows the rejection. */
function grabPointer(){
  if(DEMO || document.pointerLockElement) return;
  try {
    const r = renderer.domElement.requestPointerLock();
    if(r && r.catch) r.catch(()=>{}); // newer Chrome returns a promise
  } catch(e){}
}
renderer.domElement.addEventListener('click', ()=>{ if(game.state==='play') grabPointer(); });
let camYaw = 0, camPitch = 0.20;
addEventListener('mousemove', e=>{
  if(document.pointerLockElement && game.state==='play'){
    camYaw -= e.movementX*0.0026;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY*0.0022, -0.2, 1.1);
  }
});
/* item 05: scroll-wheel boom length. CAM_DIST_MIN is a framing constraint, not taste — closer
   than this and the player's own body hides the melee arc; further than CAM_DIST_MAX and a
   mushroom's telegraph is too small to read before it lands. */
const CAM_DIST_MIN = 4.2, CAM_DIST_MAX = 14, CAM_DIST_DEFAULT = 7.5;
let camDist = CAM_DIST_DEFAULT;
addEventListener('wheel', e=>{
  if(game.state !== 'play') return;
  e.preventDefault();
  // deltaMode 1 is lines, 2 is pages — normalize so a trackpad and a wheel feel the same
  const step = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1) * 0.0055;
  camDist = THREE.MathUtils.clamp(camDist + step, CAM_DIST_MIN, CAM_DIST_MAX);
}, { passive:false });

/* ---------- menu wiring ---------- */
const $ = id=>document.getElementById(id);
function show(id){ ['title','intro','pause','gameover','victory'].forEach(x=>$(x).classList.add('hidden')); if(id) $(id).classList.remove('hidden'); }
$('startbtn').onclick = ()=>{ audio.init(); audio.resume(); audio.click(); show('intro'); game.state='intro'; };
$('gobtn').onclick = ()=>{ audio.click(); startRun(); };
$('resumebtn').onclick = ()=>{ audio.click(); resumeGame(); };
$('restartbtn').onclick = ()=>{ audio.click(); resetRun(); startRun(); };
$('retrybtn').onclick = ()=>{ audio.click(); resetRun(); startRun(); };
$('againbtn').onclick = ()=>{ audio.click(); resetRun(); startRun(); };
$('mutebtn').onclick = ()=>{ audio.init(); const m = audio.toggleMute(); $('mutebtn').textContent='MUTE: '+(m?'ON':'OFF'); };
$('tomebtn').onclick = ()=>{ audio.init(); openTome(); };
$('tomebtn2').onclick = ()=>{ audio.click(); openTome(); };
$('tomeclose').onclick = ()=>{ audio.click(); closeTome(); };
$('invclose').onclick = ()=>{ audio.click(); closeInventory(); };
// restart / retry / new hunt = reroll to a brand-new seeded world
$('restartbtn').onclick = ()=>{ audio.click(); rerollWorld(); };
$('retrybtn').onclick = ()=>{ audio.click(); rerollWorld(); };
$('againbtn').onclick = ()=>{ audio.click(); rerollWorld(); };

function startRun(){
  show(null);
  game.state = 'play';
  game.startTime = performance.now();
  $('hud').classList.add('on');
  audio.startBGM();
  announce('Hunt the Bloom — rare caps lure its ruler out', 'good');
  /* item 30 — the floor under the whole chest loop. It only fires on a wallet with 0 lockpicks AND
     too little Mycelium to buy one, so it cannot be farmed by restarting; it just means "no way
     into any chest" is not a state a returning player can start a hunt in. */
  const floor = progress.ensureLockpickFloor();
  if(floor.granted) setTimeout(()=>{ if(game.state === 'play')
    announce('🗝️ Spare lockpick — one chest is always in reach', 'good'); }, 2800);
  /* ?god belongs HERE, not in demoAutoStart(). It was only applied on the ?demo path, so the
     documented "player takes no effective damage" param did nothing at all on a hand-driven run —
     which is exactly the run you use it for (framing a shot, holding a state still long enough to
     look at it). A debug param that silently does nothing is worse than one that does not exist,
     because you spend the session blaming the thing you were trying to observe. */
  if(PARAMS.has('god')){ game.player.hp = 99999; game.player.maxHp = 99999; }
  grabPointer();
  spawnWave(7);
  updateHUD(); updateBuffs(); updateBackpack(); updateContracts(); updateRingHud();
}
function pauseGame(){
  game.state = 'pause'; show('pause');
  $('pauseseed').textContent = `World seed #${game.seed} · ${world.theme.name}`;
  document.exitPointerLock?.();
  releaseHeld(); // a key held across the pause would still be held on resume
}
function resumeGame(){
  game.state = 'play'; show(null);
  grabPointer();
}
function resetRun(){
  for(const e of game.enemies) if(!e.dead) scene.remove(e.group);
  for(const pw of game.powerups) if(!pw.dead) scene.remove(pw.group);
  for(const r of rings) scene.remove(r.mesh);
  rings.length = 0;
  for(const pu of puddles) scene.remove(pu.mesh);
  puddles.length = 0;
  for(const pr of projPool){ pr.active = false; pr.mesh.visible = false; } // no stale projectiles after restart
  game.enemies = []; game.powerups = []; game.boss = null;
  game.kills = [0,0,0,0,0,0]; game.totalKills = 0; game.rareKills = 0; game.bossSpawned = false;
  game.level = 1; game.xp = 0; game.runEssences = [0,0,0,0,0,0]; game.dropBonus = 0;
  // rings.js pity counters. Per-run and deliberately NOT in progress.js: an elemental ring is
  // spent within the hunt it was found in, so carrying its drop history across runs would make
  // the first stomp of a fresh world feel arbitrary.
  game.stompCount = 0; game.ringsFound = 0;
  combo.n = 0; combo.t = 0; combo.best = 0; combo.tier = 0;
  comboShown = false; comboNumShown = ''; comboLabelShown = ''; comboTierShown = -1;
  { const el = document.getElementById('combo'); if(el) el.classList.remove('on','done'); }
  ringHudKey = '';   // the diff-based chip must not think it is still showing last run's ring
  // seeded spawn table: rarity weights jittered + zone density scaled per world
  const sRng = mulberry32(deriveSeed(game.seed, 77));
  game.rarityJitter = RARITIES.map(()=> 0.7 + sRng()*0.7);
  game.density = Math.min(2.2, 0.9 + sRng()*0.25 + (progress.depth-1)*0.04); // deeper runs also throw more at you
  // seeded boss plan: which archetype, which trait, and its stat roll — decided once per
  // world so a given seed always awakens the same boss, not a coin-flip at spawn time.
  // world depth scales the roll up too, so a repeat boss keeps pace with everything else.
  const bRng = mulberry32(deriveSeed(game.seed, 211));
  const bossArchetype = bRng() < 0.5 ? 'glutton' : 'elder';
  const bossDepthMult = depthMult(progress.depth);
  game.bossPlan = {
    archetype: bossArchetype,
    trait: rollBossTrait(bossArchetype, bRng),
    mult: { hp: (0.92+bRng()*0.22)*bossDepthMult, dmg: (0.94+bRng()*0.16)*bossDepthMult, speed: 0.95+bRng()*0.12 },
  };
  if(game.player) scene.remove(game.player.group);
  game.player = new Player(scene);
  game.player.moveInput = new THREE.Vector3();
  // item 09: spawn where the world says it is flat, clear of every collider and outside every
  // exclusion — dropping the player at the origin regardless of what generated there is how you
  // start a hunt inside a rock formation.
  const sp = world.spawnPoint;
  if(sp) game.player.group.position.set(sp.x, sp.h, sp.z);
  // item 03: the launch cue belongs to whoever actually leaves the ground, because a buffered
  // press fires a frame or two after the key went down.
  game.player.onJump = (p)=>{
    audio.jump();
    particles.burst(p.group.position.clone(), 6, {r:1,g:1,b:1, spread:1.5, size:5, life:0.4});
  };
  shadowize(game.player.group, { noCast: true });   // rule 2: the player's blob is the shadow
  /* The boom's floor is the player's OWN silhouette — cap, ink hull and all — measured instead of
     guessed, because a guessed 0.3 m is how the lens ended up inside the hat. */
  { const b = new THREE.Box3().setFromObject(game.player.group);
    const sz = b.getSize(new THREE.Vector3());
    const rad = 0.5*Math.max(sz.x, sz.y, sz.z);
    camMinDist = Math.max(2.2, rad + CAM_CLEAR + 0.35);
    camBoom = camDist;
    game.camMin = camMinDist; }
  applyMutations();
  buildRunContent();
  $('bosswrap').style.display = 'none';
  document.getElementById('objective').textContent = 'Hunt the Bloom';

  // continuing into a new world after a boss win (not restarting after death) — replay the
  // build victory() stashed: level, loadout, potions, kills. one-time use, cleared on read.
  let cont = null;
  try{ cont = JSON.parse(sessionStorage.getItem('mycelium_continue') || 'null'); }catch(e){}
  if(cont){
    sessionStorage.removeItem('mycelium_continue');
    const p = game.player;
    while(game.level < cont.level) levelUp(true); // same growth path as normal leveling, no double-counting with mutations
    game.xp = cont.xp;
    game.kills = cont.kills; game.totalKills = cont.totalKills; game.runEssences = cont.runEssences;
    for(const id of cont.weapons) p.addWeapon(id);
    p.equipWeapon(cont.equipped);
    for(const slot of ARMOR_SLOTS){
      for(const id of cont.armorOwned[slot]) p.addArmor(slot, id);
      if(cont.armor[slot]) p.equipArmor(slot, cont.armor[slot], game);
    }
    p.potions = cont.potions;
    p.hp = p.maxHp; // full heal — a small reward for clearing the last world
  }

  updateHUD(); updateBuffs(); updateBackpack(); updateContracts(); updateRingHud();
}
function runStats(){
  const t = ((performance.now()-game.startTime)/1000)|0;
  const spores = game.runEssences.reduce((a,b)=>a+b,0);
  return `Time: ${Math.floor(t/60)}:${String(t%60).padStart(2,'0')}<br>Total kills: ${game.totalKills} · Level ${game.level}<br>` +
    RARITIES.map((r,i)=>`<span style="color:${RARITY_COLORS[i]}">${r.name}: ${game.kills[i]}</span>`).join(' · ') +
    `<br><span style="color:#ffd94a">✦ Spores earned: ${spores} (lifetime ${progress.totalLifetime()})</span>`;
}
function gameOver(){
  game.state = 'over';
  audio.roar(0.8);
  const reachedDepth = progress.depth;
  progress.resetDepth(); // death resets world scaling back to baseline
  sessionStorage.removeItem('mycelium_continue'); // and wipes any pending "continue the build" state
  $('gostats').innerHTML = runStats() +
    `<br><span style="color:#ff9adf">🌀 Reached World Depth ${reachedDepth} — back to Depth 1</span>`;
  $('goseed').textContent = `World seed #${game.seed} · ${world.theme.name}`;
  setTimeout(()=>{ show('gameover'); document.exitPointerLock?.(); }, 900);
}
function victory(){
  game.state = 'win';
  audio.victory();
  game.shake(1);
  particles.burst(game.boss.group.position.clone().setY(4), 30, {r:1,g:0.85,b:0.3, spread:8, size:12, life:1.6, grav:4});  // 60 -> 30, see levelUp()
  progress.advanceDepth(); // the NEXT world starts one notch harder
  // stash the current build so "NEW HUNT (NEW WORLD)" continues this run instead of starting
  // over — only dying resets level/loadout (gameOver clears this same key)
  const p = game.player;
  sessionStorage.setItem('mycelium_continue', JSON.stringify({
    level: game.level, xp: game.xp,
    kills: game.kills, totalKills: game.totalKills, runEssences: game.runEssences,
    weapons: p.weapons, equipped: p.equipped,
    armorOwned: p.armorOwned, armor: p.armor,
    potions: p.potions,
  }));
  $('victext').textContent = game.boss.R.name + ' falls. Sunlight returns to the valley.';
  $('vstats').innerHTML = runStats() +
    `<br><span style="color:#ff9adf">🌀 World Depth ${progress.depth} next — mobs get stronger the longer your streak runs</span>`;
  $('vseed').textContent = `World seed #${game.seed} · ${world.theme.name}`;
  setTimeout(()=>{ show('victory'); document.exitPointerLock?.(); }, 1400);
}
game.gameOver = gameOver;

/* ---------- demo mode (verification) ---------- */
let demoT = 0, demoCalls = 0;
const DEMO_UP = PARAMS.has('camup');
const DEMO_FAST = parseFloat(PARAMS.get('fast') || '4');
const DEMO_NORENDER = PARAMS.has('norender');
function demoInput(dt){
  demoT += dt; demoCalls++;
  if(DEMO_UP) camPitch = -0.55; // camera low, gazing up at the sky
  const p = game.player;
  // walk in a slow circle, attack periodically, dash sometimes
  const a = demoT*0.5;
  const dir = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
  // steer toward nearest enemy
  let nearest = null, nd = 1e9;
  for(const e of game.enemies){ if(e.dead) continue;
    const d = e.group.position.distanceTo(p.group.position); if(d<nd){ nd=d; nearest=e; } }
  if(nearest && nd > 2.5){
    dir.copy(nearest.group.position).sub(p.group.position).setY(0).normalize();
  }
  p.moveInput.copy(dir);
  if(nearest && nd < 4.5 && Math.random()<dt*6) p.attack(game);
  if(Math.random()<dt*0.15) p.startDash(game);
  if(Math.random()<dt*0.2) tryJump();
  camYaw += dt*0.15;
}

/* ---------- camera ---------- */
const camTarget = new THREE.Vector3();
const camPos = new THREE.Vector3(0, 6, -8);
const camPivot = new THREE.Vector3();
const camDesired = new THREE.Vector3();
const CAM_CLEAR = 0.75; // how far the lens stays off any surface it would otherwise enter
/* ---- why this is not just a clamp any more ----
   Two bugs, and they compounded into the same symptom: on a steep ridge one sample along the boom
   went subsurface for a single frame, the boom was yanked from 7.5 to its floor IN THAT FRAME, and
   the floor was 0.3 m — which is inside the player's own cap. The result was one or two frames of
   backfaces filling the screen. So:
     - the pull-in is RATE LIMITED (per second, not per frame), so no single bad sample can collapse
       the boom;
     - the floor is the player's MEASURED silhouette radius, not a guess, and when even that floor
       is blocked the pitch is raised instead of the distance shortened further — an over-the-
       shoulder look down is a view, a lens inside a hat is not;
     - only colliders wide enough to matter block the LENS. Since item 01, groundOnly() accounts for
       every prop, which quietly made hovering spore pods and knee-high chests camera obstacles.
       They still block MOVEMENT; this filter is camera-only;
     - the boom is sampled twice as finely and as a ball rather than a point, so a ridge between two
       samples is met progressively instead of discovered all at once;
     - releasing needs more clearance than pulling in did (hysteresis), so a lens sitting exactly on
       a boundary cannot oscillate. */
const CAM_RELEASE = 0.35;   // extra clearance required before the boom is allowed back out
const CAM_BLOCK_R = 1.2;    // a collider narrower than this is something you clip, not something
                            // worth yanking the camera for (tree trunks, pods, small chests)
const CAM_PULL_RATE = 26;   // m/s the boom may shorten. Fast, deliberately asymmetric, never instant
const CAM_PUSH_RATE = 7;    // m/s it may lengthen again
const CAM_PROBE_R = 0.35;   // the lens is a ball: sample its cross-section, not its centre
const CAM_LIFT_STEP = 0.22, CAM_LIFT_MAX = 4;   // pitch added, in steps, when the floor is blocked
let camMinDist = 2.45;      // measured from the player's own bounds in resetRun()
let camBoom = CAM_DIST_DEFAULT;   // the live boom length, rate limited toward the marched target

// camera-only surface query: terrain, plus the colliders big enough to be walls. NOT groundOnly(),
// which counts every prop — see the note above.
function camSurface(x, z){
  let h = groundHeight(x, z);
  for(let i=0;i<COLLIDERS.length;i++){
    const c = COLLIDERS[i];
    if(c.off || c.r < CAM_BLOCK_R) continue;
    const dx = x-c.x, dz = z-c.z, rr = c.r + CAM_PROBE_R;
    if(dx*dx + dz*dz > rr*rr) continue;
    if(c.top > h) h = c.top;
  }
  return h;
}
// worst clearance over the lens's own cross-section
function boomClear(x, y, z){
  let worst = y - camSurface(x, z);
  const r = CAM_PROBE_R;
  let d = y - camSurface(x+r, z); if(d < worst) worst = d;
  d = y - camSurface(x-r, z);     if(d < worst) worst = d;
  d = y - camSurface(x, z+r);     if(d < worst) worst = d;
  d = y - camSurface(x, z-r);     if(d < worst) worst = d;
  return worst;
}
/* item 05: the old clamp only lifted the FINAL point above the terrain, which is wrong wherever the
   ground between the player and the camera is higher than both ends — the ravine, a cave mouth, the
   tower base. Those are exactly the places the game was built for drama. Marching the boom and
   pulling in at the first blocked sample fixes the case the clamp cannot see. */
function boomDistance(pivot, dirX, dirY, dirZ, want){
  const SAMPLES = 12;
  for(let i=1;i<=SAMPLES;i++){
    const t = want * (i/SAMPLES);
    if(boomClear(pivot.x + dirX*t, pivot.y + dirY*t, pivot.z + dirZ*t) < CAM_CLEAR)
      // pull to just before the blocked sample, but never inside the player's own silhouette
      return Math.max(camMinDist, want*((i-1)/SAMPLES) - 0.1);
  }
  return want;
}
function updateCamera(dt){
  const p = game.player;
  camPivot.copy(p.group.position); camPivot.y += 2.0;
  // If the boom cannot make its own floor at this pitch, look DOWN over the shoulder instead of
  // pushing the lens into the player. Bounded loop: a few fixed steps, no search.
  let pitch = camPitch, dirX = 0, dirY = 0, dirZ = 0, target = camDist;
  for(let lift=0; lift<=CAM_LIFT_MAX; lift++){
    pitch = Math.min(1.3, camPitch + lift*CAM_LIFT_STEP);
    const cp = Math.cos(pitch);
    dirX = -Math.sin(camYaw)*cp; dirY = Math.sin(pitch); dirZ = -Math.cos(camYaw)*cp;
    target = boomDistance(camPivot, dirX, dirY, dirZ, camDist);
    if(target > camMinDist + 0.05) break;
  }
  // rate limited both ways, per SECOND, with hysteresis on the way out
  if(target < camBoom) camBoom = Math.max(target, camBoom - CAM_PULL_RATE*dt);
  else if(target > camBoom + CAM_RELEASE) camBoom = Math.min(target, camBoom + CAM_PUSH_RATE*dt);
  camBoom = THREE.MathUtils.clamp(camBoom, camMinDist, camDist);
  camDistNow = camBoom;
  camDesired.set(camPivot.x + dirX*camBoom, camPivot.y + dirY*camBoom, camPivot.z + dirZ*camBoom);
  const desired = camDesired;
  // last-resort floor: the marched boom can still land the lens on a lip between two samples
  const minY = camSurface(desired.x, desired.z) + CAM_CLEAR;
  if(desired.y < minY) desired.y = minY;
  // the boom itself is now smooth, so the lens can chase it quickly without ever snapping
  camPos.lerp(desired, Math.min(1, dt*14));
  camTarget.lerp(camPivot, Math.min(1, dt*10));
  camera.position.copy(camPos);
  if(game.shakeT > 0){
    game.shakeT -= dt;
    const sh = game.shakeAmp * (game.shakeT/0.3);
    camera.position.x += (Math.random()-0.5)*sh;
    camera.position.y += (Math.random()-0.5)*sh;
    camera.position.z += (Math.random()-0.5)*sh;
    if(game.shakeT<=0) game.shakeAmp = 0;
  }
  camera.lookAt(camTarget);
}

let camDistNow = CAM_DIST_DEFAULT; // exposed for verification: the boom length actually used
game.camInfo = ()=>({ want: camDist, used: +camDistNow.toFixed(2), min: +camMinDist.toFixed(2),
  y: +camera.position.y.toFixed(2), ground: +groundOnly(camera.position.x, camera.position.z).toFixed(2),
  camGround: +camSurface(camera.position.x, camera.position.z).toFixed(2),
  clear: +(camera.position.y - camSurface(camera.position.x, camera.position.z)).toFixed(2) });
// for verification only: set the camera stance directly. Nothing in the game calls it — it exists
// so a headless session can frame a shot without the mouse it does not have.
game.camSet = (yaw, pitch, dist)=>{
  if(yaw !== undefined) camYaw = yaw;
  if(pitch !== undefined) camPitch = pitch;
  if(dist !== undefined) camDist = THREE.MathUtils.clamp(dist, CAM_DIST_MIN, CAM_DIST_MAX);
  return { yaw: camYaw, pitch: camPitch, dist: camDist };
};
// for verification: the marched boom vs the old final-Y clamp, from an arbitrary stance.
// buried = samples along the boom that sit below the surface, i.e. lens inside the world.
game.camProbe = (x, y, z, yaw, pitch, want=camDist)=>{
  const pivot = new THREE.Vector3(x, y+2.0, z);
  const dx = -Math.sin(yaw)*Math.cos(pitch), dy = Math.sin(pitch), dz = -Math.cos(yaw)*Math.cos(pitch);
  const used = boomDistance(pivot, dx, dy, dz, want);
  const buried = (ex, ey, ez)=>{ let n = 0;
    for(let i=1;i<=12;i++){ const t = i/12;
      if(pivot.y+(ey-pivot.y)*t < groundOnly(pivot.x+(ex-pivot.x)*t, pivot.z+(ez-pivot.z)*t)) n++; }
    return n; };
  const ox = pivot.x+dx*want, oy = pivot.y+dy*want, oz = pivot.z+dz*want;
  const oldY = Math.max(oy, groundOnly(ox, oz) + CAM_CLEAR); // exactly what the old code did
  const nx = pivot.x+dx*used, nz = pivot.z+dz*used;
  const ny = Math.max(pivot.y+dy*used, groundOnly(nx, nz) + CAM_CLEAR); // same final clamp as updateCamera
  return { want, used, oldBuried: buried(ox, oldY, oz), newBuried: buried(nx, ny, nz),
    oldY:+oldY.toFixed(2), newY:+ny.toFixed(2),
    oldClearance:+(oldY - groundOnly(ox, oz)).toFixed(2), newClearance:+(ny - groundOnly(nx, nz)).toFixed(2) };
};

/* ---------- title-screen ambient camera ---------- */
let titleAngle = 0;
function titleCamera(dt){
  titleAngle += dt*0.05;
  // composed hero shot: meadow foreground → groves → mother-mushroom tower on the horizon
  const cx = 10 + Math.sin(titleAngle)*8;
  camera.position.set(cx, 24 + Math.sin(titleAngle*0.6)*2.5, 64 + Math.cos(titleAngle*0.8)*5);
  const mp = world.motherShroom ? world.motherShroom.position : {x:-95,z:-70};
  camera.lookAt(mp.x*0.75, 30, mp.z*0.75); // over the grove, toward the mother-mushroom tower
}

/* ---------- sun shadows (item 06, main.js half) ---------- */
/* The light rig lives in world.js. This half owns the renderer state, the quality tier and the
   per-frame retarget; it degrades to a no-op if world.sun is not exposed and no directional
   light can be found, so the two waves can land in either order. */
let sun = null;
const sunDir = new THREE.Vector3();
const SUN_BOOM = 170; // how far up-sun the light sits from the player, inside near/far
function initShadows(){
  if(!SHADOW_SIZE) return;
  sun = world.sun || scene.children.find(o=>o.isDirectionalLight) || null;
  if(!sun) return;
  sun.castShadow = true;
  const sh = sun.shadow;
  sh.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);   // quality tier is this file's call
  const c = sh.camera;
  if(c.right <= 5){ // still at three.js defaults, i.e. world.js has not configured it yet
    /* Only reached if world.js never configured the rig. Keep these numbers in step with
       world.js PARAMS.shadowBox — the reason this branch exists is so the two waves can land in
       either order, not so the two files can hold different opinions about the box. */
    c.left = -95; c.right = 95; c.top = 95; c.bottom = -95;
    c.near = 1; c.far = 520;
    c.updateProjectionMatrix();
    sh.bias = -0.0007; sh.normalBias = 0.4;
  }
  scene.add(sun.target); // in the graph AND manually updated — either alone is a silent trap
  shadowize(scene);
}
game.shadowInfo = ()=>{ // for verification
  let casters = 0, receivers = 0;
  scene.traverse(o=>{ if(o.isMesh){ if(o.castShadow) casters++; if(o.receiveShadow) receivers++; } });
  return { tier: SHADOW_TIER, size: SHADOW_SIZE, enabled: renderer.shadowMap.enabled,
    type: renderer.shadowMap.type, fromWorld: !!(world && world.sun), sun: !!sun,
    mapSize: sun ? sun.shadow.mapSize.width : 0,
    box: sun ? [sun.shadow.camera.left, sun.shadow.camera.right] : null,
    bias: sun ? sun.shadow.bias : null, normalBias: sun ? sun.shadow.normalBias : null,
    casters, receivers, programs: renderer.info.programs.length };
};
/* THE SHADOW POLICY. Two rules, and they exist because "everything casts" produced a ground
   covered in overlapping sub-pixel smudges that read as dirt rather than as shadow.

   RULE 1 — A THING CASTS ONLY IF ITS SHADOW WOULD READ AS A SHAPE. The rig is a 2048 map over a
   190 m ortho box, i.e. ~10.8 texels per metre. A prop 40 cm across therefore projects into about
   four texels: not a small shadow, a smear. Measured before this rule, 349 meshes were casting and
   roughly 650 of the instances behind them were under a metre wide — pebbles, flowers, moss,
   undergrowth, decorative caps. Every one of them cost a shadow-map draw to produce noise. So
   there is a minimum caster size, and everything under it still RECEIVES: small scatter sitting in
   the shade of a tree is the effect that actually matters, and it costs nothing.

   RULE 2 — ONE SHADOW PER CHARACTER. Anything that walks already carries a blob: a soft mapped
   disc that tracks the surface underneath it (entities.js makeBlobShadow, fauna.js's own). Letting
   it ALSO cast into the map gives every creature two unrelated shadows — a crisp contact disc plus
   a long projection skewed off toward the sun — which is the single biggest source of the mess,
   because it is doubled on the things the eye follows. The blob is the better of the two for a
   creature that hops and bobs (it stays in contact, which is the whole job of a contact shadow), so
   the blob wins and the projection goes. Bosses are the deliberate exception: at scale 3.4 they are
   landmark-sized, the projection reads as a shape, and it is worth the drama.

   The material exclusions below are older and still load-bearing: additive shells and BackSide ink
   hulls would cast solid black, and a vertex-animated ShaderMaterial casts from its UN-animated
   pose because the depth pass is a different program.

   `opts.noCast` = receive only (characters). `opts.minR` overrides the size floor for a subtree
   whose whole point is to be a small solid object — props.js's pods are 1 m flowers hanging in the
   air, and a floating thing's shadow is how you know it is floating, so props opt down. */
const SHADOW_MIN_R = 1.15;    // metres of bounding-sphere radius; see rule 1
function shadowize(root, opts){
  if(!SHADOW_SIZE || !sun) return;
  const noCast = !!(opts && opts.noCast);
  const minR = opts && opts.minR !== undefined ? opts.minR : SHADOW_MIN_R;
  root.traverse(o=>{
    if(!o.isMesh) return;
    const m = o.material;
    if(!m || Array.isArray(m)) return;
    if(m.transparent || m.blending !== THREE.NormalBlending || m.depthWrite === false) return;
    if(m.isShaderMaterial || m.isRawShaderMaterial) return;
    const geo = o.geometry;
    if(geo && !geo.boundingSphere) geo.computeBoundingSphere();
    const r = geo && geo.boundingSphere ? geo.boundingSphere.radius : 0;
    if(r > 320) return; // sky dome and cloud shell: outside the rig entirely
    // BackSide ink must never cast, but it SHOULD still receive — an unlit outline hull reads as a
    // bright rim once the fill behind it goes into shadow.
    if(m.side !== THREE.BackSide) o.receiveShadow = true;
    if(o.userData.noShadow || noCast) return;
    if(m.side === THREE.BackSide) return;
    if(r < minR) return;                                   // rule 1
    o.castShadow = true;
  });
}
// Retarget every frame so the ortho box stays tight around the action. world.js's day-cycle
// updater rewrites sun.position from the ORIGIN each frame, so we read the direction it just set
// and re-place the light relative to the player: retargeting alone would skew the light by
// however far the player has walked from the origin.
function updateSunShadow(){
  if(!sun) return;
  const pp = game.player ? game.player.group.position : camTarget;
  sunDir.copy(sun.position);
  if(sunDir.lengthSq() < 1e-6) return;
  sunDir.normalize();
  sun.position.set(pp.x + sunDir.x*SUN_BOOM, sunDir.y*SUN_BOOM, pp.z + sunDir.z*SUN_BOOM);
  sun.target.position.set(pp.x, 0, pp.z);
  sun.target.updateMatrixWorld();
}

/* ---------- main loop ---------- */
const clock = new THREE.Clock();
let elapsed = 0, fpsAcc = 0, fpsN = 0;
let spawnCd = 0;

// demo sim verification (probe/norender) drives the loop with setTimeout so
// --virtual-time-budget fast-forwards the sim; screenshot runs keep rAF
const raf = (DEMO && (DEMO_NORENDER || PARAMS.has('probe') || PARAMS.has('checkmut')))
  ? (f)=>setTimeout(f,16) : (f)=>requestAnimationFrame(f);
function tick(){
  raf(tick);
  let dt = DEMO ? DEMO_FAST/60 : Math.min(clock.getDelta(), 0.05);
  if(dt <= 0) dt = 1/60;
  // hit-stop: decrement the timer with REAL dt, then slow the sim —
  // (previously the timer ticked with slowed dt, stretching a 0.05s stop into ~0.6s of freeze)
  if(game.hitStopT > 0){ game.hitStopT -= dt; dt *= 0.12; }
  elapsed += dt; game.elapsed = elapsed;

  fpsAcc += dt; fpsN++;
  if(fpsAcc > 0.5){ $('fps').textContent = Math.round(fpsN/fpsAcc)+' fps'; fpsAcc=0; fpsN=0; }

  world.update(dt, elapsed);
  particles.update(dt);
  rewardPops.update(dt);
  // counters ease outside the state branches on purpose: a payout collected on the last frame
  // before a pause should still finish counting up, not freeze mid-number.
  tickCounters(dt);

  if(game.state === 'title' || game.state === 'intro'){
    titleCamera(dt);
    updateSunShadow();
    hideHoverTag();
    renderFrame();
    return;
  }
  if(game.state === 'pause' || game.state === 'tome' || game.state === 'inventory'){
    hideHoverTag(); // the chip must not survive into a menu that is drawn over the world
    renderFrame();
    return;
  }
  const p = game.player;

  if(game.state === 'play'){
    // SIMSUB: in headless demo, run several sim steps per render
    const subSteps = DEMO ? 6 : 1;
    const sdt = dt / subSteps;
    for(let sub=0; sub<subSteps; sub++){
    // input → move dir (camera relative)
    if(DEMO){ demoInput(sdt); }
    else {
      // simple tank-style controls: W/S = forward/back along camera facing,
      // mouse steers, A/D = gentle turn (no strafing)
      const turn = (keys['KeyA']?1:0) - (keys['KeyD']?1:0);
      if(turn) camYaw += turn * 2.2 * sdt;
      const f = (keys['KeyW']?1:0) - (keys['KeyS']?1:0);
      p.moveInput.set(Math.sin(camYaw)*f, 0, Math.cos(camYaw)*f);
    }
    // spawner keeps pressure on
    spawnCd -= sdt;
    const alive = game.enemies.filter(e=>!e.dead).length;
    if(spawnCd <= 0 && alive < 12){ spawnCd = 2.5; spawnWave(2 + Math.min(4, (game.totalKills/12)|0)); }

    const wasOnGround = p.grounded;
    p.update(sdt, game);
    /* item 12 — the stomp resolve, right after the player's own vertical resolve so the pop is
       applied on the frame the feet actually crossed the critter. Landing is what ends a chain;
       the 1.6 s window is only the fallback for a chain that dies in mid-air. */
    if(fauna){
      if(p.grounded && !wasOnGround){
        fauna.resetChain();                       // landing is what ends a chain
        // A near miss currently reads as "nothing happened", which reads as broken. One small
        // floating line turns a miss into information, rate limited so it can never nag.
        if(nearMissCd <= 0){
          for(const c of fauna.critters){
            if(c.dead || c.dying) continue;
            const dx = c.x - p.group.position.x, dz = c.z - p.group.position.z;
            if(dx*dx + dz*dz > 9) continue;       // within 3 m: you were aiming at it
            nearMissCd = 2.5;
            pickupText(critterPop.set(c.x, c.y + 1.4, c.z), 'land ON it', '#ffd0a0');
            break;
          }
        }
      }
      const st = fauna.tryStomp(p.group.position, p.vy);
      if(st){
        p.vy = st.popVy; p.jumps = 0; p.grounded = false;   // refresh the air jump so stomps chain
        payoutStomp(st);
      }
    }
    for(const e of game.enemies) e.update(sdt, game);
    game.enemies = game.enemies.filter(e=>!e.dead);
    // enemy separation — stops mushrooms stacking inside each other (jitter)
    const es = game.enemies;
    for(let i=0;i<es.length;i++){
      const a = es[i], ap = a.group.position, amin = a.R.scale*1.05;
      for(let j=i+1;j<es.length;j++){
        const b = es[j], bp = b.group.position;
        const dx = bp.x-ap.x, dz = bp.z-ap.z;
        const min = amin + b.R.scale*1.05;
        const d2 = dx*dx + dz*dz;
        if(d2 < min*min && d2 > 1e-6){
          const d = Math.sqrt(d2), push = (min-d)*0.5/d;
          // through slideStep, not the transform: separation was the one movement path that
          // bypassed tryDir(), and with rock tiers in the world it could shove a creature into a
          // column it could never have walked into. A blocked push is simply refused.
          a.slideStep(-dx*push, -dz*push, a.baseY, false);
          b.slideStep(dx*push, dz*push, b.baseY, false);
        }
      }
      // never stand inside the player (lunge overshoot / knockback edge cases)
      const pdx = ap.x-p.group.position.x, pdz = ap.z-p.group.position.z;
      const pmin = amin + 0.7, pd2 = pdx*pdx + pdz*pdz;
      if(pd2 < pmin*pmin && pd2 > 1e-6 && a.state !== 'lunge'){
        const d = Math.sqrt(pd2), push = (pmin-d)/d;
        a.slideStep(pdx*push, pdz*push, a.baseY, false);
      }
    }
    for(const pw of game.powerups) pw.update(sdt, game);
    game.powerups = game.powerups.filter(pw=>!pw.dead);

    // projectiles
    for(const pr of projPool){
      if(!pr.active) continue;
      pr.life -= sdt;
      pr.mesh.position.addScaledVector(pr.vel, sdt);
      const gp = pr.mesh.position;
      // fade anything that gets between the lens and the world (same rule as fx.js's puffs)
      pr.halo.material.opacity = PROJ_HALO_OP *
        THREE.MathUtils.smoothstep(gp.distanceTo(camera.position), PROJ_HALO_NEAR, PROJ_HALO_FULL);
      if(gp.y < groundOnly(gp.x,gp.z)+0.2 || pr.life<=0){ pr.active=false; pr.mesh.visible=false;
        particles.burst(gp, 6, {r:0.8,g:0.4,b:1, spread:2, size:6, life:0.4});
        if(pr.corrosive) spawnPuddle(gp.clone(), pr.dmg*0.6, 2, 4.5);
        continue; }
      tmpV.copy(p.group.position); tmpV.y += 1;
      if(gp.distanceTo(tmpV) < 1.1){
        p.hurt(pr.dmg, gp, game); pr.active=false; pr.mesh.visible=false;
      }
    }
    // AOE rings
    for(let i=rings.length-1;i>=0;i--){
      const r = rings[i];
      if(r.delay > 0){ r.delay -= sdt; r.mesh.scale.setScalar(0.1); continue; }
      r.r += r.speed*sdt;
      r.mesh.scale.set(r.r, r.r, 1);
      r.mesh.material.opacity = Math.max(0, RING_OP * (1 - r.r/11.2));
      const pd = Math.hypot(p.group.position.x-r.mesh.position.x, p.group.position.z-r.mesh.position.z);
      if(!r.hitDone && Math.abs(pd - r.r) < 0.9 && p.grounded){
        r.hitDone = true; p.hurt(r.dmg, r.mesh.position, game);
      }
      if(r.r > 14){ scene.remove(r.mesh); rings.splice(i,1); }
    }
    // toxic puddles (Rotmaw) — tick damage while the player stands inside
    for(let i=puddles.length-1;i>=0;i--){
      const pu = puddles[i];
      pu.life -= sdt; pu.tickCd -= sdt;
      pu.mesh.material.opacity = 0.4 * Math.min(1, pu.life/1.2);
      const pd = Math.hypot(p.group.position.x-pu.mesh.position.x, p.group.position.z-pu.mesh.position.z);
      if(pd < pu.radius && pu.tickCd <= 0 && p.grounded){ pu.tickCd = 0.6; p.hurt(pu.dmg, pu.mesh.position, game); }
      if(pu.life <= 0){ scene.remove(pu.mesh); puddles.splice(i,1); }
    }

    // ambient sparkle near legendary/boss
    if(game.boss && Math.random()<sdt*8){
      const bp = game.boss.group.position;
      particles.spawn(bp.x+(Math.random()-0.5)*6, bp.y+Math.random()*6, bp.z+(Math.random()-0.5)*6,
        {r:0.8,g:0.5,b:1, spread:0.5, size:7, life:1.2, vy:1});
    }
    } // end substep loop
    // animation + the 20 s respawn clock + the treasure pickup test: once per rendered frame, not
    // per substep — none of it is physics, and running it six times would just spin the clocks.
    updateCombo(dt);
    updateRing(dt);
    if(fauna) fauna.update(dt, elapsed, p.group.position, p.vy);
    if(props) props.update(dt, elapsed, camera, p.group.position);
    if(nearMissCd > 0) nearMissCd -= dt;
    updateCritterCues(dt);
    if(harvestCd > 0) harvestCd -= dt;
    updateHarvestPrompt();
    updateHUD(); updateBuffs();
  }
  updateCamera(dt);
  updateSunShadow();
  updateHoverTag(dt);
  renderFrame();
  if(DEMO && (elapsed|0) !== lastDbg){ lastDbg = elapsed|0;
    document.title = JSON.stringify({k:game.totalKills, hp:Math.round(p.hp), e:game.enemies.length, lv:game.level, xp:game.xp, ess:game.runEssences.join(','),
      px:p.group.position.x.toFixed(1), pz:p.group.position.z.toFixed(1), st:game.state,
      mi:p.moveInput.length().toFixed(2), vx:p.vel.x.toFixed(2), di:demoCalls, dt:dt.toFixed(4)}); }
}
let lastDbg = -1;
// item 50: #boot comes off after the FIRST frame is actually on screen, so the overlay covers
// the generation stall AND the pop-in that follows it.
function renderFrame(){
  // ?norender never draws, so the overlay is dropped on the first loop pass instead — otherwise
  // the headless sim path would sit behind a covered screen forever.
  if(!DEMO_NORENDER) renderer.render(scene, camera);
  if(bootShown){ bootShown = false; document.getElementById('boot').classList.remove('on'); }
}
let bootShown = false;
/* Generation is one long blocking frame, so it cannot run during module eval — the overlay
   would never paint. Two rAFs: the first commits the class, the second runs after the browser
   has actually drawn it. */
function boot(){
  const bootEl = document.getElementById('boot');
  const log = window.__bootLog = []; // for verification: proves the overlay paints first
  const mark = (what)=> log.push({ what, t:+performance.now().toFixed(1), on: bootEl.classList.contains('on') });
  bootEl.classList.add('on');
  bootShown = true;
  mark('overlay-on');
  // ?bootdelay=MS holds the overlay up before generation starts, so the covered stall can be
  // screenshotted; the honest path is the two-rAF handoff below.
  const delay = parseFloat(PARAMS.get('bootdelay')) || 0;
  const run = ()=>requestAnimationFrame(()=>requestAnimationFrame(()=>{
    mark('painted');
    world = buildWorld(scene, QUALITY, SEED);
    window.__world = world; // for verification
    game.theme = world.theme;
    initShadows();
    resetRun();
    mark('world-built');
    tick();
    mark('first-frame');
    if(DEMO) demoAutoStart();
  }));
  if(delay) setTimeout(run, delay); else run();
}
boot();

/* demo auto-start for verification */
function demoAutoStart(){
  audio.init = ()=>{}; // no audio context in headless
  setTimeout(()=>{
    show(null); startRun();          // startRun() applies ?god for every path, demo included
    if(PARAMS.has('tome')){ // open the spore tome for UI verification (?tome=SECONDS to delay)
      const at = (parseFloat(PARAMS.get('tome')) || 2.5) * 1000;
      setTimeout(()=>{ game.player.hp = 99999; game.player.maxHp = 99999; openTome(); }, at);
    }
    if(PARAMS.has('levelup')){ // force a fast level-up for banner verification
      game.player.hp = 99999; game.player.maxHp = 99999;
      setTimeout(()=>{ game.xp = xpNeed(); game.addXP(0); }, 13500); // banner visible at capture
    }
    if(PARAMS.has('buy')){ // grant essences + auto-buy a mutation (persistence test)
      setTimeout(()=>{
        for(let i=0;i<5;i++){ progress.bank[i] += 99; progress.lifetime[i] += 99; }
        progress.saveBank(); progress.saveLife();
        window.__buyResult = progress.buy('crimson');
        applyMutations(); updateHUD();
      }, 2000);
    }
    if(PARAMS.has('probe')){ // report live run state in the title
      setInterval(()=>{ document.title = 'PROBE '+JSON.stringify({st:game.state, t:+(game.elapsed||0).toFixed(1), k:game.totalKills, lv:game.level, xp:game.xp,
        ess:game.runEssences, hp:Math.round(game.player.hp)}); }, 300);
    }
    if(PARAMS.has('checkmut')){ // report persisted meta-progression in the title
      setInterval(()=>{ document.title = 'MUTS:'+JSON.stringify(progress.mutations)+' BANK:'+progress.bank.join(',')+' BUY:'+window.__buyResult+' DMG:'+(game.player?game.player.dmgMult.toFixed(2):'?'); }, 200);
    }
    if(PARAMS.has('boss') || PARAMS.has('win')){
      setTimeout(()=>{ game.player.hp = 99999; game.player.maxHp = 99999; // survive for screenshot
        game.rareKills = 8; game.bossSpawned = true;
        const pp = game.player.group.position;
        const archetype = PARAMS.has('glutton') ? 'glutton' : PARAMS.has('elder') ? 'elder' : game.bossPlan.archetype;
        const trait = archetype === game.bossPlan.archetype ? game.bossPlan.trait
          : rollBossTrait(archetype, mulberry32(deriveSeed(game.seed, 212)));
        const BossCtor = archetype === 'glutton' ? GluttonBoss : Boss;
        game.boss = new BossCtor(scene, new THREE.Vector3(pp.x+8, 0, pp.z+8), trait, game.bossPlan.mult);
        game.enemies.push(game.boss);
        tagEnemy(game.boss); shadowize(game.boss.group);
        const bossLabel = (game.boss.R.name + (trait ? ' · ' + trait.name : '')).toUpperCase();
        document.getElementById('bossname').textContent = bossLabel;
        document.getElementById('bosswrap').style.display = 'block';
        announce('⚠ ' + bossLabel + ' — dash through its rings, hit it on the recovery', 'bad');
        if(PARAMS.has('win')) setTimeout(()=>{ if(game.boss && !game.boss.dead) game.boss.hit(99999, pp, game); }, 2500);
      }, 1500);
    }
  }, 800);
}
