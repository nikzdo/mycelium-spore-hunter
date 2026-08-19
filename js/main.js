// main.js — MYCELIUM: Spore Hunter — game orchestration
import * as THREE from 'three';
import { ParticlePool } from './fx.js';
import { buildWorld, groundHeight } from './world.js';
import { Mushroom, Boss, GluttonBoss, Player, Powerup, POWERUPS, RARITIES } from './entities.js';
import { GameAudio } from './audio.js';
import { mulberry32, deriveSeed, randomSeed } from './rng.js';
import { Progress, MUTATIONS, XP_PER_HIT, XP_PER_BOSS_HIT, xpForLevel, depthMult } from './progress.js';
import { WEAPONS, WEAPONS_BY_ID } from './weapons.js';
import { ARMOR, ARMOR_BY_ID, ARMOR_SLOTS, SLOT_ICON } from './armor.js';
import { POTIONS, POTIONS_BY_ID } from './potions.js';
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
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xe8b07a);
const camera = new THREE.PerspectiveCamera(55, innerWidth/innerHeight, 0.1, 1200);
addEventListener('resize', ()=>{
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

const world = buildWorld(scene, QUALITY, SEED);
window.__world = world; // for verification
const particles = new ParticlePool(scene, 700);
const audio = new GameAudio();
const progress = new Progress(); // meta progression (essences + mutations, localStorage)

/* ================= projectiles & rings ================= */
const projPool = [];
const projGeo = new THREE.SphereGeometry(0.28, 8, 6);
function spawnProjectile(pos, dir, dmg, color, corrosive=false){
  let p = projPool.find(p=>!p.active);
  if(!p){
    if(projPool.length > 40) return;
    const mesh = new THREE.Mesh(projGeo, new THREE.MeshBasicMaterial({ color:0xffffff }));
    const halo = new THREE.Mesh(new THREE.SphereGeometry(0.5,8,6),
      new THREE.MeshBasicMaterial({ transparent:true, opacity:0.35, blending:THREE.AdditiveBlending, depthWrite:false }));
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
function spawnRing(pos, dmg, color, delay=0){
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(1, 0.35, 8, 40),
    new THREE.MeshBasicMaterial({ color, transparent:true, opacity:0.8, blending:THREE.AdditiveBlending, depthWrite:false }));
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
  seed:SEED, theme:world.theme, progress,
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
  particles.burst(gp.clone().setY(gp.y+1.4), 40, {r:1,g:0.85,b:0.3, spread:5, size:11, life:1.1, grav:2.5, drag:0.97});
  particles.burst(gp.clone().setY(gp.y+1.4), 18, {r:1,g:1,b:1, spread:2.5, size:7, life:0.7});
  const el = document.getElementById('levelup');
  el.textContent = '✦ LEVEL UP! — LV ' + game.level + ' ✦';
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  announce('+'+12+' Max HP · +1.5 Damage · Fully Healed');
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

function announce(txt){
  const el = document.getElementById('announce');
  el.textContent = txt;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}
game.announce = announce;
game.shake = (a)=>{ game.shakeT = Math.max(game.shakeT, 0.3); game.shakeAmp = Math.max(game.shakeAmp, a); };
game.hitStop = (t)=>{ game.hitStopT = Math.max(game.hitStopT, t); };
game.damageFlash = ()=>{
  const el = document.getElementById('dmgvin');
  el.style.opacity = 0.9; setTimeout(()=> el.style.opacity = 0, 140);
};

/* ---------- damage numbers ---------- */
function damageNumber(worldPos, dmg, crit, isPlayer=false){
  const v = worldPos.clone().project(camera);
  if(v.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg' + (crit?' crit':'') + (isPlayer?' player':'');
  el.textContent = crit ? dmg+'!' : dmg;
  el.style.left = ((v.x*0.5+0.5)*innerWidth + (Math.random()-0.5)*40)+'px';
  el.style.top = ((-v.y*0.5+0.5)*innerHeight)+'px';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 850);
}
game.damageNumber = damageNumber;

/* ---------- harvestable mushrooms + contracts ---------- */
function pickupText(worldPos, text, color){
  const v = worldPos.clone().project(camera);
  if(v.z > 1) return;
  const el = document.createElement('div');
  el.className = 'dmg harvest';
  el.style.color = color;
  el.textContent = text;
  el.style.left = ((v.x*0.5+0.5)*innerWidth)+'px';
  el.style.top = ((-v.y*0.5+0.5)*innerHeight)+'px';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 850);
}
function updateContracts(){
  const el = $('contracts'); if(!el) return;
  el.innerHTML = progress.contracts.map(c=>{
    const sp = SPECIES_BY_ID[c.species];
    const pct = Math.min(100, c.have/c.need*100);
    return `<div class="contract">
      <div class="cicon" style="background:${hexCss(sp.color)}">${sp.icon}</div>
      <div class="cinfo">
        <div class="cname">${sp.name}</div>
        <div class="cbar"><div class="cfill" style="width:${pct}%"></div></div>
        <div class="cprog">${c.have}/${c.need} &nbsp;•&nbsp; +${c.reward} 🌿</div>
      </div>
    </div>`;
  }).join('');
}
game.updateContracts = updateContracts;
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
  const id = best ? best.species+'|'+best.g.position.x+'|'+best.g.position.z : null;
  if(id !== harvestPromptId){
    harvestPromptId = id;
    const el = $('harvestPrompt');
    if(best){ el.textContent = '[H] Harvest '+SPECIES_BY_ID[best.species].name; el.classList.remove('hidden'); }
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
  const { completed } = progress.harvestFor(entry.species);
  updateContracts();
  updateHUD();
  if(completed.length){
    audio.mutate();
    announce('Contract Complete! +'+completed.reduce((a,c)=>a+c.reward,0)+' 🌿 Mycelium');
  }
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
  return m;
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
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1), def);
  game.powerups.push(pw);
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
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.4), def);
  game.powerups.push(pw);
}
function dropPotion(pos, rarity, force=false){
  const chance = 0.07 + rarity*0.02;
  if(!force && Math.random() > chance + effDropBonus()*0.2) return;
  const def = POTIONS[(Math.random()*POTIONS.length)|0];
  const pdef = { id:'potion_'+def.id, icon:def.icon, name:def.name, color:def.color, isPotion:true, potionId:def.id };
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.1), pdef);
  game.powerups.push(pw);
}
function dropArmor(pos, rarity, force=false){
  const chance = rarity>=3 ? 0.45 : rarity===2 ? 0.18 : rarity===1 ? 0.06 : 0.025;
  if(!force && Math.random() > chance + effDropBonus()*0.3) return;
  const pool = ARMOR.filter(a=> a.rarity===rarity);
  if(!pool.length) return;
  const a = pool[(Math.random()*pool.length)|0];
  const def = { id:'armor_'+a.id, icon:a.icon, name:a.name, color:RARITY_COLORS[a.rarity], isArmor:true, armorId:a.id, slot:a.slot };
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+1.2), def);
  game.powerups.push(pw);
}
function dropEssence(pos, rarity, isBoss){
  const amount = isBoss ? 5 : 1;
  const def = { id:'essence_'+rarity, icon:'✦', name:RARITIES[rarity].name+' Essence', color:RARITY_COLORS[rarity],
    shape:'gem', isEssence:true, rarity, amount };
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+0.9), def);
  game.powerups.push(pw);
}
function dropCoin(pos, rarity, isBoss){
  if(!isBoss && Math.random() > 0.85) return; // most kills still drop one, but not every single time
  const amount = (isBoss ? 20 : 1 + rarity*2) * ((rarity>=2 && Math.random()<0.15) ? 3 : 1);
  const def = { id:'coin', icon:'🪙', name:'Coins', color:0xffd94a, shape:'coin', isCoin:true, amount };
  const pw = new Powerup(scene, pos.clone().setY(groundHeight(pos.x,pos.z)+0.7), def);
  game.powerups.push(pw);
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
  if(m.isBoss){ victory(); return; }
  updateHUD();
  if(!game.bossSpawned && game.rareKills >= 8){
    game.bossSpawned = true;
    setTimeout(()=>{
      if(game.state !== 'play') return;
      const a = Math.random()*Math.PI*2;
      const pp = game.player.group.position;
      const pos = new THREE.Vector3(pp.x+Math.cos(a)*25, 0, pp.z+Math.sin(a)*25);
      const { archetype, trait, mult } = game.bossPlan;
      const isGlutton = archetype === 'glutton';
      game.boss = isGlutton ? new GluttonBoss(scene, pos, trait, mult) : new Boss(scene, pos, trait, mult);
      game.enemies.push(game.boss);
      const bossLabel = (game.boss.R.name + (trait ? ' · ' + trait.name : '')).toUpperCase();
      announce('⚠ ' + bossLabel + ' AWAKENS ⚠');
      audio.bossSpawn(); game.shake(1);
      document.getElementById('bossname').textContent = bossLabel;
      document.getElementById('bosswrap').style.display = 'block';
      document.getElementById('objective').textContent = 'Slay ' + game.boss.R.name + '!';
    }, 1200);
  }
};
game.applyPowerup = (def)=>{
  const p = game.player;
  audio.pickup();
  particles.burst(p.group.position.clone().setY(1.2), 10,
    {r:1,g:0.9,b:0.4, spread:3, size:6, life:0.6});
  if(def.isWeapon){
    const w = WEAPONS_BY_ID[def.weaponId];
    const hadBefore = !!progress.gearOf('weapon', def.weaponId);
    if(!p.weapons.includes(def.weaponId)) p.addWeapon(def.weaponId); // always usable this hunt once found
    if(hadBefore){
      const r = progress.addDupe('weapon', def.weaponId, w.rarity);
      announce(r.starredTo ? `⭐ ${def.name} reached ${r.starredTo} stars!`
        : r.maxed ? `✦ Duplicate ${def.name} — refined to coins`
        : `+1 ${def.name} shard (${r.dupes}/${r.need})`);
    } else {
      progress.ownGear('weapon', def.weaponId);
      announce(def.icon + ' Found ' + def.name + '!');
    }
    updateBackpack(); updateHUD();
    return;
  }
  if(def.isPotion){
    const pdef = POTIONS_BY_ID[def.potionId];
    p.addPotion(def.potionId);
    announce(def.icon + ' Found ' + def.name + ' (' + pdef.key + ')');
    updateBackpack();
    return;
  }
  if(def.isArmor){
    const a = ARMOR_BY_ID[def.armorId];
    const hadBefore = !!progress.gearOf('armor', def.armorId);
    if(!p.armorOwned[def.slot].includes(def.armorId)) p.addArmor(def.slot, def.armorId);
    if(hadBefore){
      const r = progress.addDupe('armor', def.armorId, a.rarity);
      announce(r.starredTo ? `⭐ ${def.name} reached ${r.starredTo} stars!`
        : r.maxed ? `✦ Duplicate ${def.name} — refined to coins`
        : `+1 ${def.name} shard (${r.dupes}/${r.need})`);
    } else {
      progress.ownGear('armor', def.armorId);
      announce(def.icon + ' Found ' + def.name + '!');
    }
    updateBackpack(); updateHUD();
    return;
  }
  if(def.isEssence){
    game.runEssences[def.rarity] += def.amount;
    progress.collect(def.rarity, def.amount);
    audio.essence(def.rarity);
    updateHUD();
    return;
  }
  if(def.isCoin){
    progress.coins += def.amount;
    progress.saveCoins();
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
  announce(def.icon + ' ' + def.name);
  updateHUD(); updateBuffs();
};
game.updateBuffs = updateBuffs;
game.updateBackpack = ()=>updateBackpack();
function updateBackpack(){
  const p = game.player; if(!p) return;
  // weapon slots (1-7)
  const wEl = document.getElementById('bpWeapons');
  wEl.innerHTML = '';
  p.weapons.forEach((id, i)=>{
    const w = WEAPONS_BY_ID[id];
    const stars = (progress.gearOf('weapon', id) || {}).stars || 0;
    const d = document.createElement('div');
    d.className = 'hotslot' + (id===p.equipped ? ' active' : '');
    d.style.setProperty('--rc', RARITY_COLORS[w.rarity]);
    d.title = w.name;
    d.innerHTML = `<span class="hnum">${i+1}</span>${w.icon}${stars>0?`<span class="htier">★${stars}</span>`:''}`;
    d.onclick = ()=>{ if(game.state==='play'){ p.equipWeapon(id); updateBackpack(); audio.click(); } };
    wEl.appendChild(d);
  });
  // potion slots (fixed Q/E/R/F/G — always shown so the player learns the layout, greyed out at 0)
  const pEl = document.getElementById('bpPotions');
  pEl.innerHTML = '';
  for(const def of POTIONS){
    const count = p.potions[def.id] || 0;
    const timer = p.potionTimers[def.id] || 0;
    const d = document.createElement('div');
    d.className = 'potslot' + (count>0 ? ' has' : '') + (timer>0 ? ' active' : '');
    d.style.setProperty('--pc', '#'+def.color.toString(16).padStart(6,'0'));
    d.title = def.name + ' — ' + def.desc;
    d.innerHTML = `<span class="pkey">${def.key}</span>${def.icon}` +
      (count>0 ? `<span class="pcnt">${count}</span>` : '') +
      (timer>0 ? `<span class="ptimer">${Math.ceil(timer)}s</span>` : '');
    d.onclick = ()=>{ if(game.state==='play' && p.usePotion(def.id, game)) updateBackpack(); };
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
    d.className = 'gearslot' + (id ? ' on' : '');
    if(id){
      const a = ARMOR_BY_ID[id];
      const stars = (progress.gearOf('armor', id) || {}).stars || 0;
      d.style.setProperty('--rc', RARITY_COLORS[a.rarity]);
      d.title = a.name;
      d.innerHTML = a.icon + (stars>0?`<span class="gt">★${stars}</span>`:'');
    } else {
      d.innerHTML = SLOT_ICON[slot];
      d.title = 'No ' + slot + ' equipped';
    }
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
function updateHUD(){
  const p = game.player; if(!p) return;
  document.getElementById('hpfill').style.width = (p.hp/p.maxHp*100)+'%';
  // xp bar + level badge
  const need = xpNeed();
  document.getElementById('xpfill').style.width = Math.min(100, game.xp/need*100)+'%';
  document.getElementById('xplabel').textContent = `LEVEL ${game.level} — ${game.xp} / ${need} XP`;
  document.getElementById('lvlbadge').textContent = game.level;
  // dash pips
  const pips = document.getElementById('pips');
  const nPips = 3;
  if(pips.children.length !== nPips){
    pips.innerHTML=''; for(let i=0;i<nPips;i++){ const d=document.createElement('div'); d.className='pip'; pips.appendChild(d); }
  }
  const frac = 1 - p.dashCd/p.dashMaxCd;
  for(let i=0;i<nPips;i++) pips.children[i].className = 'pip' + (frac*nPips > i ? ' full' : '');
  // kills
  const k = document.getElementById('kills');
  k.innerHTML = game.kills.map((n,i)=>
    `<div class="row">${n} <span class="dot" style="background:${RARITY_COLORS[i]}"></span></div>`).join('');
  document.getElementById('coinhud').textContent = '🪙 ' + progress.coins;
  document.getElementById('mycohud').textContent = '🌿 ' + progress.myco;
  // zone
  const d = Math.hypot(p.group.position.x, p.group.position.z);
  const z = d<40?'MEADOW':d<90?'DEEPWOOD':d<140?'GLOAM':'HEART OF THE BLOOM';
  document.getElementById('zone').textContent = '— '+z+(progress.depth>1?' · DEPTH '+progress.depth:'')+' —';
  if(!game.bossSpawned)
    document.getElementById('objective').textContent = `Slay rare+ mushrooms to lure the Bloom's ruler (${game.rareKills}/8)`;
  if(game.boss)
    document.getElementById('bossfill').style.width = Math.max(0, game.boss.hp/game.boss.maxHp*100)+'%';
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
    const sp = SPECIES_BY_ID[c.species];
    return `<div class="essrow"><div class="essdot" style="background:${hexCss(sp.color)}"></div>${sp.name}
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
        if(progress.levelUpGear(kind, id)){ audio.click(); renderTome(); updateHUD(); updateBackpack(); }
      };
    } else btn.disabled = true;
  }
  div.appendChild(btn);
  return div;
}
function openTome(){
  if(game.state === 'tome') return;
  tomeReturn = game.state;
  if(game.state === 'play'){ game.state = 'tome'; document.exitPointerLock?.(); }
  else game.state = 'tome';
  renderTome();
  ['title','intro','pause','gameover','victory'].forEach(x=>$(x).classList.add('hidden'));
  $('tome').classList.remove('hidden');
  audio.init(); audio.click();
}
function closeTome(){
  $('tome').classList.add('hidden');
  game.state = tomeReturn;
  if(tomeReturn === 'play' && !DEMO) renderer.domElement.requestPointerLock();
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
      lvlBtn.onclick = ()=>{ if(progress.levelUpGear('weapon', id)){ audio.click(); updateBackpack(); renderInventory(); } };
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
        lvlBtn.onclick = ()=>{ if(progress.levelUpGear('armor', id)){ audio.click(); updateHUD(); updateGearHud(); renderInventory(); } };
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
  if(game.state === 'play'){ game.state = 'inventory'; document.exitPointerLock?.(); }
  else game.state = 'inventory';
  renderInventory();
  ['title','intro','pause','gameover','victory'].forEach(x=>$(x).classList.add('hidden'));
  $('inventory').classList.remove('hidden');
  audio.init(); audio.click();
}
function closeInventory(){
  $('inventory').classList.add('hidden');
  game.state = invReturn;
  if(invReturn === 'play' && !DEMO) renderer.domElement.requestPointerLock();
}
game.openInventory = openInventory; game.closeInventory = closeInventory;

/* ---------- input ---------- */
const keys = {};
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
    const p = game.player;
    if(p && p.weapons[idx] && p.weapons[idx] !== p.equipped){
      p.equipWeapon(p.weapons[idx]); updateBackpack(); audio.click();
    }
  }
  const potionKey = { KeyQ:'power', KeyE:'haste', KeyR:'swift', KeyF:'vitality', KeyG:'fortify' }[e.code];
  if(potionKey && game.state === 'play'){
    if(game.player.usePotion(potionKey, game)) updateBackpack();
  }
  if(e.code === 'Space'){ e.preventDefault(); tryJump(); }
  if(e.code === 'KeyH' && game.state === 'play') tryHarvest();
});
addEventListener('keyup', e=> keys[e.code] = false);
addEventListener('mousedown', e=>{
  if(game.state==='play' && e.button===0 && document.pointerLockElement) game.player.attack(game);
});
function tryJump(){
  const p = game.player;
  if(game.state!=='play' || !p) return;
  if(p.jumps < p.getMaxJumps()){
    p.vy = 11; p.jumps++; p.grounded = false;
    audio.jump();
    particles.burst(p.group.position.clone(), 6, {r:1,g:1,b:1, spread:1.5, size:5, life:0.4});
  }
}
addEventListener('keydown', e=>{ if(e.code==='ShiftLeft' && game.state==='play') game.player.startDash(game); });

/* pointer lock */
renderer.domElement.addEventListener('click', ()=>{
  if(game.state==='play' && !document.pointerLockElement) renderer.domElement.requestPointerLock();
});
let camYaw = 0, camPitch = 0.20;
addEventListener('mousemove', e=>{
  if(document.pointerLockElement && game.state==='play'){
    camYaw -= e.movementX*0.0026;
    camPitch = THREE.MathUtils.clamp(camPitch + e.movementY*0.0022, -0.2, 1.1);
  }
});

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
  announce('Hunt the Bloom!');
  if(!DEMO) renderer.domElement.requestPointerLock();
  spawnWave(7);
  updateHUD(); updateBuffs(); updateBackpack(); updateContracts();
}
function pauseGame(){
  game.state = 'pause'; show('pause');
  $('pauseseed').textContent = `World seed #${game.seed} · ${world.theme.name}`;
  document.exitPointerLock?.();
}
function resumeGame(){
  game.state = 'play'; show(null);
  if(!DEMO) renderer.domElement.requestPointerLock();
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
  applyMutations();
  $('bosswrap').style.display = 'none';
  document.getElementById('objective').textContent = 'Hunt the Bloom';
  updateHUD(); updateBuffs(); updateBackpack(); updateContracts();
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
  $('gostats').innerHTML = runStats() +
    `<br><span style="color:#ff9adf">🌀 Reached World Depth ${reachedDepth} — back to Depth 1</span>`;
  $('goseed').textContent = `World seed #${game.seed} · ${world.theme.name}`;
  setTimeout(()=>{ show('gameover'); document.exitPointerLock?.(); }, 900);
}
function victory(){
  game.state = 'win';
  audio.victory();
  game.shake(1);
  particles.burst(game.boss.group.position.clone().setY(4), 60, {r:1,g:0.85,b:0.3, spread:8, size:12, life:1.6, grav:4});
  progress.advanceDepth(); // the NEXT world starts one notch harder
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
function updateCamera(dt){
  const p = game.player;
  const pivot = p.group.position.clone().add(new THREE.Vector3(0, 2.0, 0));
  const dist = 7.5;
  const off = new THREE.Vector3(
    -Math.sin(camYaw)*Math.cos(camPitch), Math.sin(camPitch), -Math.cos(camYaw)*Math.cos(camPitch)
  ).multiplyScalar(dist);
  const desired = pivot.clone().add(off);
  // keep above terrain
  const minY = groundHeight(desired.x, desired.z) + 0.7;
  if(desired.y < minY) desired.y = minY;
  camPos.lerp(desired, Math.min(1, dt*6));
  camTarget.lerp(pivot, Math.min(1, dt*10));
  camera.position.copy(camPos);
  if(game.shakeT > 0){
    game.shakeT -= dt;
    const s = game.shakeAmp * (game.shakeT/0.3);
    camera.position.x += (Math.random()-0.5)*s;
    camera.position.y += (Math.random()-0.5)*s;
    camera.position.z += (Math.random()-0.5)*s;
    if(game.shakeT<=0) game.shakeAmp = 0;
  }
  camera.lookAt(camTarget);
}

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

/* ---------- main loop ---------- */
resetRun();
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

  if(game.state === 'title' || game.state === 'intro'){
    titleCamera(dt);
    renderer.render(scene, camera);
    return;
  }
  if(game.state === 'pause' || game.state === 'tome' || game.state === 'inventory'){
    renderer.render(scene, camera);
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

    p.update(sdt, game);
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
          ap.x -= dx*push; ap.z -= dz*push;
          bp.x += dx*push; bp.z += dz*push;
        }
      }
      // never stand inside the player (lunge overshoot / knockback edge cases)
      const pdx = ap.x-p.group.position.x, pdz = ap.z-p.group.position.z;
      const pmin = amin + 0.7, pd2 = pdx*pdx + pdz*pdz;
      if(pd2 < pmin*pmin && pd2 > 1e-6 && a.state !== 'lunge'){
        const d = Math.sqrt(pd2), push = (pmin-d)/d;
        ap.x += pdx*push; ap.z += pdz*push;
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
      if(gp.y < groundHeight(gp.x,gp.z)+0.2 || pr.life<=0){ pr.active=false; pr.mesh.visible=false;
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
      r.mesh.material.opacity = Math.max(0, 0.8 - r.r/14);
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
    if(harvestCd > 0) harvestCd -= dt;
    updateHarvestPrompt();
    updateHUD(); updateBuffs();
  }
  updateCamera(dt);
  if(!DEMO_NORENDER) renderer.render(scene, camera);
  if(DEMO && (elapsed|0) !== lastDbg){ lastDbg = elapsed|0;
    document.title = JSON.stringify({k:game.totalKills, hp:Math.round(p.hp), e:game.enemies.length, lv:game.level, xp:game.xp, ess:game.runEssences.join(','),
      px:p.group.position.x.toFixed(1), pz:p.group.position.z.toFixed(1), st:game.state,
      mi:p.moveInput.length().toFixed(2), vx:p.vel.x.toFixed(2), di:demoCalls, dt:dt.toFixed(4)}); }
}
let lastDbg = -1;
tick();

/* demo auto-start for verification */
if(DEMO){
  audio.init = ()=>{}; // no audio context in headless
  setTimeout(()=>{
    show(null); startRun();
    if(PARAMS.has('god')){ game.player.hp = 99999; game.player.maxHp = 99999; }
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
        const bossLabel = (game.boss.R.name + (trait ? ' · ' + trait.name : '')).toUpperCase();
        document.getElementById('bossname').textContent = bossLabel;
        document.getElementById('bosswrap').style.display = 'block';
        announce('⚠ ' + bossLabel + ' AWAKENS ⚠');
        if(PARAMS.has('win')) setTimeout(()=>{ if(game.boss && !game.boss.dead) game.boss.hit(99999, pp, game); }, 2500);
      }, 1500);
    }
  }, 800);
}
