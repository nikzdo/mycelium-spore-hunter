// progress.js — XP / leveling, spore essences, mutations, gear collection (meta progression)
// Persistence keys (localStorage):
//   mycelium_bank        — array[6] of spendable spore essences per rarity (brown/green/red/blue/purple/rainbow)
//   mycelium_lifetime    — array[6] lifetime totals collected (never decreases)
//   mycelium_mutations   — { mutationId: tierOwned }
//   mycelium_weapon_gear — { weaponId: {dupes,stars,level} } — persistent collection, independent of any one run
//   mycelium_armor_gear  — { armorId: {dupes,stars,level} }  — same shape, same rules
//   mycelium_coins       — number, universal currency: fills essence shortfalls + pays for gear levels
//   mycelium_myco        — number, quest currency earned only from completing harvest contracts
//                          (also buys pry-spines, so it is no longer a dead-end score)
//   mycelium_spines      — number, pry-spines: the only key into a sealed cyst
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
  coins:'mycelium_coins', myco:'mycelium_myco', contracts:'mycelium_contracts', depth:'mycelium_depth',
  spines:'mycelium_spines' };

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
// a save written before pry-spines existed simply has no key: 0 is the honest default and
// ensureSpineFloor() hands a returning player their way back in on the next hunt.
function loadSpines(){
  try{ return Math.max(0, parseInt(localStorage.getItem(LS.spines))|0); }catch(e){ return 0; }
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

// ---------------- pry-spines + sealed cysts: the conversion edge (item 15) ----------------
// Before this, four currencies ran in four straight lines: essence bought mutations, coins
// bought gear levels, duplicates bought stars, Mycelium bought nothing at all. The fix is a
// resource whose only job is *access*: a spore pod is a jump you make anyway, a sealed cyst
// pays like a small boss, and a pry-spine is the one thing that connects them.
//
// SPORE PODS ARE WHERE PRY-SPINES COME FROM, SO SEALED CYSTS ALWAYS STAY REACHABLE. That
// sentence is the design; 0.35 is only the dial that sets its pace. Everything else follows
// from refusing to leave a currency with no outgoing edge:
//   pods / critters -> spines -> cysts -> coins + gear duplicates
//   duplicates -> stars, and past 6 stars -> coins (already true, untouched)
//   coins -> gear levels, and coins -> essence shortfalls -> mutations (already true)
//   contracts -> Mycelium -> spines            <- the edge that was missing entirely
// Mycelium had exactly one source and no sink, which made it a score rather than a currency.
// Contracts renew forever, so that exchange is also the floor under the whole loop: a hunt
// that spawns no pods can still be converted into a way into a cyst. ----

// per-interaction spine odds. `pity` = after this many dry interactions in a row the next
// one is guaranteed (0 = pure chance).
export const SPINE_SOURCES = {
  // Pods carry the pity because they are the source of record. Expected pods per spine,
  // pity included: .35 + 2(.65)(.35) + 3(.65^2)(.35) + 4(.65^3) = 2.32 — so ~5 pods pay for
  // the average crusted cyst, and a cold streak can never cost more than 4 pods.
  pod:     { chance:0.35, pity:4, label:'spore pod' },
  // Critters pay coins on every stomp (see stompCritter) and a spine roughly every 8th, so
  // routing through them is worth doing without making pods redundant.
  critter: { chance:0.12, pity:0, label:'critter' },
};

// One finished contract pays ~10-34 Mycelium, i.e. 1-2 spines. Deliberately worse per-spine
// than pods: the exchange exists so you can never be locked out, not so you can skip the world.
export const SPINE_MYCO_COST = 12;

// item 14 — a gamble that hides its odds is a slot machine; one that publishes them is a
// decision. Every tier states its per-spine chance and its payout range, and `maxTries` caps
// how many spines a single cyst can ever eat. Expected spines per open is 1/chance —
// 2.2 / 4.0 / 10.0 — and maxTries is ~2x that, so the tail is bounded rather than open-ended.
// The ceiling only ever helps: with it, measured spines-per-open is 2.1 / 3.7 / 8.8, so the
// published number is the worst case for the player, never the best.
//
// ONE SYMBOL FOR "SEALED CYST", TIER READ OFF IT — never three unrelated pictures. 🥚/🪨/👁 taught
// nothing: an egg, a rock and an eye share no shape, and the eye read as something to look at
// rather than a container to open. Same rule the gear collection already follows: one silhouette,
// rarity carried by a pip count and a colour, so a player learns the glyph once and reads the tier
// off it. `icon` stays the composed glyph+pips string because every existing caller (the hover
// chip, cystPrompt(), the payout announce lines) prints it as plain text and cannot take colour.
export const CYST_GLYPH = '🥚';
const CYST_PIP = '◆';
export const CYST_TIERS = [
  { id:'crusted',   name:'Crusted Cyst',   tier:1, chance:0.45, maxTries:5,
    coins:[18,34],   myco:[0,0],   gearChance:0,   color:'#d8b483' },
  { id:'ironbound', name:'Ironbound Cyst', tier:2, chance:0.25, maxTries:9,
    coins:[45,80],   myco:[0,0],   gearChance:0.5, color:'#8fc3ff' },
  { id:'elder',     name:'Elder Cyst',     tier:3, chance:0.10, maxTries:20,
    coins:[110,190], myco:[6,12],  gearChance:1,   color:'#c79bff' },
];
// glyph, pips and icon are DERIVED from tier in one loop, so a fourth tier can never be added with
// a mismatched picture — the thing that produced the eye in the first place.
for(const c of CYST_TIERS){
  c.glyph = CYST_GLYPH;
  c.pips = CYST_PIP.repeat(c.tier);
  c.icon = c.glyph + c.pips;
}
export const CYST_BY_ID = {};
for(const c of CYST_TIERS) CYST_BY_ID[c.id] = c;
// unknown ids fall back to the cheapest tier rather than throwing — a mis-tagged prop in the
// world should pay too little, not break the interaction.
function cystOf(id){ return CYST_BY_ID[id] || CYST_TIERS[0]; }
function randIn(range){
  if(!range || range[1] <= 0) return 0;
  return range[0] + ((Math.random()*(range[1]-range[0]+1))|0);
}

// the full star ladder for a rarity, so the Tome can price every remaining star up front
// instead of revealing one threshold at a time (item 04, same principle as the cyst odds).
export function starLadder(rarity){
  const per = [];
  for(let s=1; s<=GEAR_STAR_CAP; s++) per.push(dupesToStar(s, rarity));
  return { per, total: per.reduce((a,b)=>a+b, 0) };
}

export class Progress {
  constructor(){
    this.bank = loadArr(LS.bank);        // spendable essences
    this.lifetime = loadArr(LS.life);    // lifetime collected
    this.mutations = loadMuts();         // { id: tier }
    this.weaponGear = loadGear(LS.weaponGear, WEAPONS_BY_ID); // { weaponId: {dupes,stars,level} }
    this.armorGear = loadGear(LS.armorGear, ARMOR_BY_ID);     // { armorId: {dupes,stars,level} }
    this.coins = loadCoins();            // universal currency — essence shortfalls + gear levels
    this.myco = loadMyco();              // quest currency — contracts in, pry-spines out
    this.spines = loadSpines();          // pry-spines — the only key into a sealed cyst
    this._spineDry = {};                 // per-source dry streaks for the pity rule. session-only
                                         // on purpose: a fresh session starting at 0 can only help.
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
  saveSpines(){ try{ localStorage.setItem(LS.spines, String(this.spines)); }catch(e){} }
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


  // ---------------- pry-spines: grant, spend, and the sources that feed them.
  // Nothing outside this file touches localStorage, so every spine that exists came through
  // one of these four doors: a pod, a critter, the Mycelium exchange, or the floor. ----
  grantSpines(n=1){
    n = n|0;
    if(n > 0){ this.spines += n; this.saveSpines(); }
    return this.spines;
  }
  spendSpines(n=1){
    n = Math.max(1, n|0);
    if(this.spines < n) return false;
    this.spines -= n; this.saveSpines();
    return true;
  }
  // one interaction with a spine source. Rolls the published chance, applies that source's
  // pity rule, grants on success. Returns everything a popup needs to explain itself.
  spineRoll(source='pod'){
    const s = SPINE_SOURCES[source] || SPINE_SOURCES.pod;
    const dry = this._spineDry[source] || 0;
    const forced = s.pity > 0 && dry + 1 >= s.pity;
    const got = forced || Math.random() < s.chance;
    this._spineDry[source] = got ? 0 : dry + 1;
    if(got) this.grantSpines(1);
    return { got, forced: forced && got, chance: s.chance, dry: this._spineDry[source],
      spines: this.spines, label: s.label };
  }
  // item 12 — a stomp always pays coins (scaling with the chain, so linking critters is the
  // skill expression) and sometimes pays a spine. It never pays nothing: a movement reward
  // that can come up empty stops being a reason to move.
  stompCritter(chain=0){
    const coins = Math.min(12, 2 + Math.max(0, chain|0)*2);
    this.coins += coins; this.saveCoins();
    const roll = this.spineRoll('critter');
    return { coins, spine: roll.got, spines: this.spines, coinsTotal: this.coins };
  }
  // contracts -> Mycelium -> spines. The rate is fixed and worse than pods on purpose.
  spineExchange(){
    return { cost: SPINE_MYCO_COST, myco: this.myco, spines: this.spines,
      max: Math.floor(this.myco / SPINE_MYCO_COST), affordable: this.myco >= SPINE_MYCO_COST };
  }
  buySpine(n=1){
    n = Math.max(1, n|0);
    const cost = n * SPINE_MYCO_COST;
    if(this.myco < cost) return false;
    this.myco -= cost; this.saveMyco();
    this.grantSpines(n);
    return true;
  }
  // item 30 — the floor, and the reason "no way into a cyst" is not a reachable state.
  // Call once at hunt start. It only fires on a wallet with no spines AND not enough Mycelium
  // to buy one, so it can't be farmed by restarting; it just means a returning player who
  // spent everything last hunt still has one attempt in front of them.
  ensureSpineFloor(){
    if(this.spines > 0 || this.myco >= SPINE_MYCO_COST) return { granted:false, spines:this.spines };
    this.grantSpines(1);
    return { granted:true, spines:this.spines };
  }

  // ---------------- sealed cysts: the sink, with its odds on the label ----------------
  // `state` is the cyst's own { tries } counter, owned by the world object rather than by the
  // save — a cyst is per-run, and its attempt history dies with the world it stands in.
  cystInfo(tierId, state){
    const t = cystOf(tierId);
    const tries = state && Number.isFinite(state.tries) ? state.tries : 0;
    return { id:t.id, name:t.name, icon:t.icon,
      // glyph/pips/tier/color are the same iconography split apart, for any caller that CAN
      // colour it (the HUD legend) instead of printing one plain-text string
      glyph:t.glyph, pips:t.pips, tier:t.tier, color:t.color,
      chance:t.chance, pct:Math.round(t.chance*100),
      expectedSpines:+(1/t.chance).toFixed(1),
      maxTries:t.maxTries, tries, triesLeft:Math.max(0, t.maxTries - tries),
      coins:t.coins, myco:t.myco, gearChance:t.gearChance,
      spines:this.spines, canPry:this.spines >= 1 };
  }
  // the prompt line, ready to render: "🥚◆ Pry the crusted cyst — 45% per spine (🦴 3 held)".
  // Publishing the number is the whole point of item 14; the caller only has to draw it.
  // The 🦴 matches the pry-spine plaque in the HUD so the prompt and the wallet name the same
  // resource, and the locked line publishes the odds too — being unable to afford the gamble is
  // no reason to hide what the gamble pays.
  cystPrompt(tierId, state){
    const i = this.cystInfo(tierId, state);
    if(!i.canPry) return `${i.icon} ${i.name} — sealed · ${i.pct}% per spine, you hold no 🦴 pry-spine`;
    const pity = i.triesLeft === 1 ? ' · next one opens it' : '';
    return `${i.icon} Pry the ${i.name.toLowerCase()} — ${i.pct}% per spine (🦴 ${i.spines} held)${pity}`;
  }
  // One spine, one attempt, at exactly the advertised odds. A cyst that has swallowed
  // `maxTries` spines opens on the next attempt regardless of the roll: a gamble that
  // publishes its odds also has to terminate, or the number was a lie.
  // `gear:true` asks the caller to roll one gear drop from its own drop table — that is the
  // cyst -> duplicates -> stars edge, and it stays in main.js so cysts pay from the same
  // table as everything else.
  pryCyst(tierId, state){
    const t = cystOf(tierId);
    if(state && !Number.isFinite(state.tries)) state.tries = 0;
    if(this.spines < 1) return { ok:false, reason:'no-spines', opened:false, spines:this.spines };
    this.spendSpines(1);
    const tries = state ? ++state.tries : 1;
    const forced = tries >= t.maxTries;
    const opened = forced || Math.random() < t.chance;
    const base = { ok:true, tier:t.id, name:t.name, icon:t.icon, chance:t.chance,
      pct:Math.round(t.chance*100), tries, spines:this.spines };
    if(!opened) return { ...base, opened:false, forced:false, triesLeft:Math.max(0, t.maxTries - tries) };
    const coins = randIn(t.coins);
    const myco = randIn(t.myco);
    if(coins){ this.coins += coins; this.saveCoins(); }
    if(myco){ this.myco += myco; this.saveMyco(); }
    return { ...base, opened:true, forced, triesLeft:0, coins, myco,
      gear: Math.random() < t.gearChance, coinsTotal:this.coins };
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
  // one number for "essence you can spend", for the HUD wallet. The per-rarity breakdown is a
  // Tome-sized fact; what the HUD has to answer is only "do I hold any at all".
  totalBank(){ return this.bank.reduce((a,b)=>a+b, 0); }

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
  // full display bundle for a UI card: stars, level, progress toward both caps, and the live
  // multiplier. Item 04: the star rate is published, not inferred. `max(1, nextStar - rarity)`
  // is invisible to a player watching a bar creep, so the bundle carries the rate itself, how
  // many duplicates are left, and what the next star and the next level are actually worth —
  // a rate you can read is a decision, a rate you can only feel is a slot machine.
  gearInfo(kind, id, rarity){
    const g = this.gearOf(kind, id);
    if(!g) return null;
    const cap = gearLevelCap(g.stars);
    const need = g.stars < GEAR_STAR_CAP ? dupesToStar(g.stars+1, rarity) : 0;
    const ladder = starLadder(rarity);
    let toMax = -g.dupes;
    for(let st = g.stars+1; st <= GEAR_STAR_CAP; st++) toMax += ladder.per[st-1];
    return {
      stars: g.stars, level: g.level, levelCap: cap,
      dupes: g.dupes, dupesNeed: need,
      maxedStars: g.stars >= GEAR_STAR_CAP, maxedLevel: g.level >= cap,
      mult: gearMult(g.stars, g.level),
      levelCost: g.level < cap ? gearLevelCost(g.level) : null,
      // --- publishable rate, same numbers the maths above actually uses ---
      dupesPer: need,                                      // duplicates per star AT THIS RARITY
      dupesLeft: need ? Math.max(0, need - g.dupes) : 0,    // how many more for the next star
      dupeProgress01: need ? Math.min(1, g.dupes / need) : 1,
      dupesToMax: Math.max(0, toMax),                      // duplicates from here to 6 stars
      starLadder: ladder.per,                              // cost of every star, first to last
      perStar: 0.12, perLevel: 0.01,                       // what one of each is worth
      nextStarMult: g.stars < GEAR_STAR_CAP ? gearMult(g.stars+1, g.level) : null,
      nextLevelMult: g.level < cap ? gearMult(g.stars, g.level+1) : null,
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
