// progress.js — XP / leveling, spore essences, mutations, gear collection (meta progression)
// Persistence keys (localStorage):
//   mycelium_bank        — array[6] of spendable spore essences per rarity (brown/green/red/blue/purple/rainbow)
//   mycelium_lifetime    — array[6] lifetime totals collected (never decreases)
//   mycelium_mutations   — { mutationId: tierOwned }
//   mycelium_weapon_gear — { weaponId: {dupes,stars,level} } — persistent collection, independent of any one run
//   mycelium_armor_gear  — { armorId: {dupes,stars,level} }  — same shape, same rules
//   mycelium_coins       — number, universal currency: fills essence shortfalls + pays for gear levels
//   mycelium_myco        — number, quest currency earned only from completing harvest contracts
//   mycelium_contracts   — array of up to 3 active {id, species, need, have, reward}
//   mycelium_depth       — number, how many bosses in a row you've beaten without dying.
//                          mobs scale up with it (see depthMult); a death resets it to 1.
import { WEAPONS_BY_ID } from './weapons.js';
import { ARMOR_BY_ID } from './armor.js';
import { MUSHROOM_SPECIES } from './mushrooms.js';

const ESS_TIERS = 6;

export const XP_PER_HIT = [2, 4, 8, 16, 30]; // by rarity
export const XP_PER_BOSS_HIT = 5;

// XP needed to go from `level` to `level+1` (grows ~quadratically)
export function xpForLevel(level){ return 25*level + 20*level*level; }

/* ---------------- mutations ---------------- */
// cost tiers: array of { essenceRarityIdx: count } maps
export const MUTATIONS = [
  { id:'crimson',   name:'Crimson Cap', icon:'🍄', color:'#ff5a5a',
    desc:'+10% blade damage',
    costs:[{0:5}, {0:12,1:4}, {0:25,1:10,2:4}] },
  { id:'swiftgill', name:'Swiftgill', icon:'💨', color:'#6bd8ff',
    desc:'+8% move speed',
    costs:[{1:5}, {1:12,2:3}, {1:25,2:8,3:3}] },
  { id:'ironstem',  name:'Iron Stem', icon:'🛡️', color:'#b9b3c9',
    desc:'+15% max HP',
    costs:[{0:8}, {0:16,2:4}, {1:15,2:10,3:4}] },
  { id:'sporelord', name:'Sporelord', icon:'🧲', color:'#ff9adf',
    desc:'Pickups fly to you from +40% further',
    costs:[{1:6,2:2}, {2:8,3:3}, {2:18,3:8,4:2}] },
  { id:'elderblood',name:'Elder Blood', icon:'👑', color:'#b46bff',
    desc:'Begin each hunt at level +1',
    costs:[{2:6,3:2}, {3:8,4:2}, {3:15,4:6,5:1}] },
  { id:'luckyspore',name:'Lucky Spore', icon:'🍀', color:'#9be26e',
    desc:'+10% powerup drop chance',
    costs:[{1:4,2:4}, {2:10,3:4}, {3:12,4:4}] },
];

const LS = { bank:'mycelium_bank', life:'mycelium_lifetime', muts:'mycelium_mutations',
  weaponGear:'mycelium_weapon_gear', armorGear:'mycelium_armor_gear',
  coins:'mycelium_coins', myco:'mycelium_myco', contracts:'mycelium_contracts', depth:'mycelium_depth' };

// ---------------- world depth: how many bosses in a row you've beaten. mobs everywhere
// (not just far from spawn) scale up with it, so worlds keep getting harder as long as you
// keep winning; dying resets it back to 1. ----
export function depthMult(depth){ return 1 + (depth-1)*0.15; }
function loadDepth(){
  try{ return Math.max(1, parseInt(localStorage.getItem(LS.depth))||1); }catch(e){ return 1; }
}

// ---------------- gear collection: rarity is fixed per item (what it looks like / where it
// drops); depth comes from stars (unlocked by finding duplicates) and level (bought with coins,
// capped by your current star tier). every piece — weapon or armor — uses the exact same math. ----
export const GEAR_STAR_CAP = 6;
function dupesToStar(nextStar, rarity){ return Math.max(1, nextStar - rarity); }
function gearLevelCap(stars){ return 15 + stars*15; }
function gearLevelCost(level){ return 8 + level*3; }
export function gearMult(stars, level){ return 1 + stars*0.12 + level*0.01; }

function loadGear(key, byId){
  const out = {};
  try{
    const o = JSON.parse(localStorage.getItem(key) || 'null');
    if(o && typeof o === 'object'){
      for(const id in o){
        if(!byId[id]) continue;
        const r = o[id];
        out[id] = { dupes: Math.max(0, r.dupes|0), stars: Math.min(GEAR_STAR_CAP, Math.max(0, r.stars|0)), level: Math.max(1, r.level|0) };
      }
    }
  }catch(e){}
  return out;
}

// ---------------- harvest contracts ----------------
function rollContract(){
  const sp = MUSHROOM_SPECIES[(Math.random()*MUSHROOM_SPECIES.length)|0];
  const need = 5 + ((Math.random()*8)|0); // 5-12
  const reward = Math.round(need * (2 + Math.random()*0.8));
  return { id:'c'+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36), species:sp.id, need, have:0, reward };
}
function loadMyco(){
  try{ return Math.max(0, parseInt(localStorage.getItem(LS.myco))|0); }catch(e){ return 0; }
}
function loadContracts(){
  try{
    const a = JSON.parse(localStorage.getItem(LS.contracts) || 'null');
    if(Array.isArray(a)) return a.filter(c=> c && MUSHROOM_SPECIES.some(s=>s.id===c.species)
      && Number.isFinite(c.need) && Number.isFinite(c.have) && Number.isFinite(c.reward)).slice(0,3);
  }catch(e){}
  return [];
}

function loadArr(key){
  try{
    const a = JSON.parse(localStorage.getItem(key) || 'null');
    if(Array.isArray(a) && a.length === ESS_TIERS) return a.map(n=>Math.max(0, n|0));
    if(Array.isArray(a) && a.length === 5) return [...a.map(n=>Math.max(0,n|0)), 0]; // migrate pre-Mythic saves
  }catch(e){}
  return new Array(ESS_TIERS).fill(0);
}
function loadCoins(){
  try{ return Math.max(0, parseInt(localStorage.getItem(LS.coins))|0); }catch(e){ return 0; }
}
function loadMuts(){
  try{
    const o = JSON.parse(localStorage.getItem(LS.muts) || 'null');
    if(o && typeof o === 'object'){
      const out = {};
      for(const m of MUTATIONS){ const t = Math.min(3, Math.max(0, o[m.id]|0)); if(t>0) out[m.id]=t; }
      return out;
    }
  }catch(e){}
  return {};
}

export class Progress {
  constructor(){
    this.bank = loadArr(LS.bank);        // spendable essences
    this.lifetime = loadArr(LS.life);    // lifetime collected
    this.mutations = loadMuts();         // { id: tier }
    this.weaponGear = loadGear(LS.weaponGear, WEAPONS_BY_ID); // { weaponId: {dupes,stars,level} }
    this.armorGear = loadGear(LS.armorGear, ARMOR_BY_ID);     // { armorId: {dupes,stars,level} }
    this.coins = loadCoins();            // universal currency — essence shortfalls + gear levels
    this.myco = loadMyco();              // quest currency — only from completed contracts
    this.contracts = loadContracts();    // active harvest contracts (max 3)
    while(this.contracts.length < 3) this.contracts.push(rollContract());
    if(!this.weaponGear.blade) this.weaponGear.blade = { dupes:0, stars:0, level:1 }; // starting weapon is always in the collection
    this.depth = loadDepth();            // consecutive boss wins since your last death
  }
  saveBank(){ try{ localStorage.setItem(LS.bank, JSON.stringify(this.bank)); }catch(e){} }
  saveLife(){ try{ localStorage.setItem(LS.life, JSON.stringify(this.lifetime)); }catch(e){} }
  saveMuts(){ try{ localStorage.setItem(LS.muts, JSON.stringify(this.mutations)); }catch(e){} }
  saveCoins(){ try{ localStorage.setItem(LS.coins, String(this.coins)); }catch(e){} }
  saveMyco(){ try{ localStorage.setItem(LS.myco, String(this.myco)); }catch(e){} }
  saveContracts(){ try{ localStorage.setItem(LS.contracts, JSON.stringify(this.contracts)); }catch(e){} }
  saveDepth(){ try{ localStorage.setItem(LS.depth, String(this.depth)); }catch(e){} }
  // call when a boss falls — the *next* world starts one notch harder
  advanceDepth(){ this.depth++; this.saveDepth(); }
  // call on player death — mob scaling falls back to baseline
  resetDepth(){ this.depth = 1; this.saveDepth(); }
  _gearMap(kind){ return kind === 'weapon' ? this.weaponGear : this.armorGear; }
  _saveGear(kind){
    const key = kind === 'weapon' ? LS.weaponGear : LS.armorGear;
    try{ localStorage.setItem(key, JSON.stringify(this._gearMap(kind))); }catch(e){}
  }

  // harvesting a mushroom of `speciesId` advances any matching active contract by 1.
  // returns { completed, added } — contracts just finished (already rewarded+removed)
  // and any freshly-rolled replacements, so the caller can show a completion banner.
  harvestFor(speciesId){
    const completed = [];
    for(const c of this.contracts){
      if(c.species === speciesId && c.have < c.need){
        c.have++;
        if(c.have >= c.need) completed.push(c);
      }
    }
    const added = [];
    if(completed.length){
      for(const c of completed){
        this.myco += c.reward;
        this.contracts = this.contracts.filter(x=>x.id !== c.id);
      }
      while(this.contracts.length < 3){ const nc = rollContract(); this.contracts.push(nc); added.push(nc); }
      this.saveMyco();
    }
    this.saveContracts();
    return { completed, added };
  }

  // collect essence for a killed rarity (boss passes 4 with a bonus count)
  collect(rarity, n=1){
    this.bank[rarity] += n; this.lifetime[rarity] += n;
    this.saveBank(); this.saveLife();
  }
  // coins can cover any shortfall in an essence cost (3 coins = 1 essence of any color)
  _coinsNeeded(cost){
    let need = 0;
    for(const k in cost){ const short = cost[k] - this.bank[k]; if(short > 0) need += short*3; }
    return need;
  }
  _pay(cost){
    for(const k in cost){
      const pay = Math.min(this.bank[k], cost[k]);
      this.bank[k] -= pay;
      const shortCoins = (cost[k]-pay)*3;
      this.coins -= shortCoins;
    }
  }
  tierOf(id){ return this.mutations[id] || 0; }
  nextCost(id){
    const t = this.tierOf(id);
    return t >= 3 ? null : MUTATIONS.find(m=>m.id===id).costs[t];
  }
  canAfford(id){
    const cost = this.nextCost(id);
    if(!cost) return false;
    return this._coinsNeeded(cost) <= this.coins;
  }
  buy(id){
    if(!this.canAfford(id)) return false;
    this._pay(this.nextCost(id));
    this.mutations[id] = this.tierOf(id) + 1;
    this.saveBank(); this.saveMuts(); this.saveCoins();
    return true;
  }
  totalLifetime(){ return this.lifetime.reduce((a,b)=>a+b, 0); }

  // ---------------- gear collection: weapons + armor share this exact API ----------------
  // ('weapon' | 'armor', item id — id spaces never collide since they come from separate catalogs)
  gearOf(kind, id){ return this._gearMap(kind)[id] || null; }
  gearMultOf(kind, id){ const g = this.gearOf(kind, id); return g ? gearMult(g.stars, g.level) : 1; }
  // registers a piece as permanently "in the collection" the first time it's ever found
  ownGear(kind, id){
    const map = this._gearMap(kind);
    if(!map[id]){ map[id] = { dupes:0, stars:0, level:1 }; this._saveGear(kind); }
  }
  // a duplicate find: feeds the star meter, auto-stars-up on threshold (possibly several
  // times off one big dupe count), and once maxed, overflow refines into coins so nothing's wasted
  addDupe(kind, id, rarity){
    const map = this._gearMap(kind);
    const g = map[id] || (map[id] = { dupes:0, stars:0, level:1 });
    let starredTo = null;
    if(g.stars >= GEAR_STAR_CAP){
      this.coins += 3 + rarity*2; this.saveCoins();
    } else {
      g.dupes++;
      while(g.stars < GEAR_STAR_CAP && g.dupes >= dupesToStar(g.stars+1, rarity)){
        g.dupes -= dupesToStar(g.stars+1, rarity);
        g.stars++;
        starredTo = g.stars;
      }
    }
    this._saveGear(kind);
    const need = g.stars < GEAR_STAR_CAP ? dupesToStar(g.stars+1, rarity) : 0;
    return { stars:g.stars, dupes:g.dupes, need, starredTo, maxed: g.stars>=GEAR_STAR_CAP };
  }
  // full display bundle for a UI card: stars, level, progress toward both caps, and the live multiplier
  gearInfo(kind, id, rarity){
    const g = this.gearOf(kind, id);
    if(!g) return null;
    const cap = gearLevelCap(g.stars);
    return {
      stars: g.stars, level: g.level, levelCap: cap,
      dupes: g.dupes, dupesNeed: g.stars < GEAR_STAR_CAP ? dupesToStar(g.stars+1, rarity) : 0,
      maxedStars: g.stars >= GEAR_STAR_CAP, maxedLevel: g.level >= cap,
      mult: gearMult(g.stars, g.level),
      levelCost: g.level < cap ? gearLevelCost(g.level) : null,
    };
  }
  levelUpGear(kind, id){
    const g = this.gearOf(kind, id); if(!g) return false;
    const cap = gearLevelCap(g.stars);
    if(g.level >= cap) return false;
    const cost = gearLevelCost(g.level);
    if(this.coins < cost) return false;
    this.coins -= cost; g.level++;
    this.saveCoins(); this._saveGear(kind);
    return true;
  }
}
