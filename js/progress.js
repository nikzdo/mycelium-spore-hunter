// progress.js — XP / leveling, spore essences, mutations, gear collection (meta progression)
// Persistence keys (localStorage):
//   mycelium_bank        — array[6] of spendable spore essences per rarity (brown/green/red/blue/purple/rainbow)
//   mycelium_lifetime    — array[6] lifetime totals collected (never decreases)
//   mycelium_mutations   — { mutationId: tierOwned }
//   mycelium_weapon_gear — { weaponId: {dupes,stars,level} } — persistent collection, independent of any one run
//   mycelium_armor_gear  — { armorId: {dupes,stars,level} }  — same shape, same rules
//   mycelium_coins       — number, universal currency: fills essence shortfalls + pays for gear levels
//   mycelium_myco        — number, quest currency earned only from completing harvest contracts
//                          (also buys lockpicks, so it is no longer a dead-end score)
//   mycelium_spines      — number, lockpicks: the only key into a sealed chest
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
  lockpicks:'mycelium_spines' };

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

/* ---------------- contracts: the quest rotation (items 08) ----------------

   WHY THE ROTATION HAD TO GROW. Three active contracts, all of them "pick N mushrooms of one
   colour", meant Mycelium had exactly one faucet and the whole quest system pointed at exactly one
   verb. Meanwhile the world had grown four other verbs — burst a pod overhead, pry a chest, ride a
   vent, lift a crystal — and none of them ever appeared in an objective. A quest board that ignores
   four fifths of what the world does is not a quest board, it is a shopping list.

   ONE SHAPE FOR EVERY KIND. A contract is {id, kind, species?, need, have, reward}; `kind` selects
   the counter and `species` is only meaningful when kind === 'harvest'. That is what lets ONE
   advance path serve all of them (see advance() below) instead of one method per verb — the same
   "one chokepoint per cross-cutting effect" rule the damage and reward paths follow.

   BACKWARD COMPATIBILITY IS LOAD-BEARING HERE, because contracts persist. A save written before
   this existed has entries with a `species` and NO `kind`, so kind defaults to 'harvest' on load
   and such a contract keeps counting exactly as it did. Getting this wrong does not throw — it
   silently voids a player's in-progress quests, which is the worst class of save bug. */
export const QUEST_KINDS = [
  // Harvest keeps the heaviest weight and it is not sentiment: there are four species, so it is
  // the only kind that can offer three DIFFERENT contracts at once without repeating itself.
  { kind:'harvest', weight:34, icon:'🍄', min:5,  var:8,  pay:2.0, payVar:0.8,
    verb:(n, name)=> `Harvest ${n} ${name}` },
  // Pods are the cheapest verb to satisfy (they are on your route anyway) so they need the most,
  // and pay the least per unit. A quest whose target you meet by accident should not out-earn one
  // you have to go looking for.
  { kind:'pod',     weight:20, icon:'🌸', min:6,  var:7,  pay:1.5, payVar:0.6,
    verb:(n)=> `Burst ${n} flower pod${n===1?'':'s'}` },
  // Chests cost a lockpick each, so the need is small and the pay is the highest per unit in the
  // table. This is also the edge that closes the loop: chest quests pay Mycelium, Mycelium buys
  // lockpicks, lockpicks open chests.
  { kind:'chest',   weight:16, icon:'🧰', min:2,  var:2,  pay:7.0, payVar:2.5,
    verb:(n)=> `Pry open ${n} chest${n===1?'':'s'}` },
  // Vents are free to use but 15 s apart and far from each other (ventMinDist 62), so a vent quest
  // is really "cross the map N times" — priced as travel, not as difficulty.
  { kind:'vent',    weight:12, icon:'🌀', min:2,  var:3,  pay:5.5, payVar:2.0,
    verb:(n)=> `Ride ${n} vent${n===1?'':'s'}` },
  // Stomps are a skill verb, and the chain makes a multi-stomp quest close fast for a good player.
  { kind:'stomp',   weight:12, icon:'🐛', min:4,  var:5,  pay:2.2, payVar:0.9,
    verb:(n)=> `Land on ${n} critter${n===1?'':'s'}` },
  // Gems are CAPPED by the world: four per hunt, all at one hard-to-reach site. The need must stay
  // under that or the contract is unfinishable in a single world — the one hard constraint in this
  // table, and the reason `min + var` here is 3, not 5.
  { kind:'gem',     weight:6,  icon:'💎', min:1,  var:2,  pay:12.0, payVar:4.0,
    verb:(n)=> `Recover ${n} spore crystal${n===1?'':'s'}` },
];
const QUEST_BY_KIND = {};
for(const q of QUEST_KINDS) QUEST_BY_KIND[q.kind] = q;
export function questKind(kind){ return QUEST_BY_KIND[kind] || QUEST_BY_KIND.harvest; }

function rollContract(){
  let sum = 0; for(const q of QUEST_KINDS) sum += q.weight;
  let roll = Math.random()*sum, spec = QUEST_KINDS[0];
  for(const q of QUEST_KINDS){ roll -= q.weight; if(roll <= 0){ spec = q; break; } }
  const need = spec.min + ((Math.random()*spec.var)|0);
  const reward = Math.round(need * (spec.pay + Math.random()*spec.payVar));
  const c = { id:'c'+Date.now().toString(36)+Math.floor(Math.random()*1e4).toString(36),
    kind: spec.kind, need, have:0, reward };
  if(spec.kind === 'harvest') c.species = MUSHROOM_SPECIES[(Math.random()*MUSHROOM_SPECIES.length)|0].id;
  return c;
}
function loadMyco(){
  try{ return Math.max(0, parseInt(localStorage.getItem(LS.myco))|0); }catch(e){ return 0; }
}
function loadContracts(){
  try{
    const a = JSON.parse(localStorage.getItem(LS.contracts) || 'null');
    if(!Array.isArray(a)) return [];
    const out = [];
    for(const c of a){
      if(!c || !Number.isFinite(c.need) || !Number.isFinite(c.have) || !Number.isFinite(c.reward)) continue;
      // MIGRATION, and the reason this loop is not a one-line filter any more: a save written
      // before item 08 has a `species` and no `kind`. Defaulting to 'harvest' is what keeps such a
      // contract counting; dropping it would silently void a player's in-progress quests.
      const kind = c.kind || 'harvest';
      if(!QUEST_BY_KIND[kind]) continue;                       // a kind we no longer ship
      if(kind === 'harvest' && !MUSHROOM_SPECIES.some(s=>s.id===c.species)) continue;
      out.push({ id:c.id, kind, species:c.species, need:c.need, have:c.have, reward:c.reward });
      if(out.length >= 3) break;
    }
    return out;
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
// a save written before lockpicks existed simply has no key: 0 is the honest default and
// ensureLockpickFloor() hands a returning player their way back in on the next hunt.
function loadLockpicks(){
  try{ return Math.max(0, parseInt(localStorage.getItem(LS.lockpicks))|0); }catch(e){ return 0; }
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

// ---------------- lockpicks + sealed chests: the conversion edge (item 15) ----------------
// Before this, four currencies ran in four straight lines: essence bought mutations, coins
// bought gear levels, duplicates bought stars, Mycelium bought nothing at all. The fix is a
// resource whose only job is *access*: a spore pod is a jump you make anyway, a sealed chest
// pays like a small boss, and a lockpick is the one thing that connects them.
//
// SPORE PODS ARE WHERE LOCKPICKS COME FROM, SO SEALED CHESTS ALWAYS STAY REACHABLE. That
// sentence is the design; 0.35 is only the dial that sets its pace. Everything else follows
// from refusing to leave a currency with no outgoing edge:
//   pods / critters -> lockpicks -> chests -> coins + gear duplicates
//   duplicates -> stars, and past 6 stars -> coins (already true, untouched)
//   coins -> gear levels, and coins -> essence shortfalls -> mutations (already true)
//   contracts -> Mycelium -> lockpicks            <- the edge that was missing entirely
// Mycelium had exactly one source and no sink, which made it a score rather than a currency.
// Contracts renew forever, so that exchange is also the floor under the whole loop: a hunt
// that spawns no pods can still be converted into a way into a chest. ----

// per-interaction lockpick odds. `pity` = after this many dry interactions in a row the next
// one is guaranteed (0 = pure chance).
export const LOCKPICK_SOURCES = {
  // Pods carry the pity because they are the source of record. Expected pods per lockpick,
  // pity included: .35 + 2(.65)(.35) + 3(.65^2)(.35) + 4(.65^3) = 2.32 — so ~5 pods pay for
  // the average crusted chest, and a cold streak can never cost more than 4 pods.
  pod:     { chance:0.35, pity:4, label:'spore pod' },
  // Critters pay coins on every stomp (see stompCritter) and a lockpick roughly every 8th, so
  // routing through them is worth doing without making pods redundant.
  critter: { chance:0.12, pity:0, label:'critter' },
};

// One finished contract pays ~10-34 Mycelium, i.e. 1-2 lockpicks. Deliberately worse per-lockpick
// than pods: the exchange exists so you can never be locked out, not so you can skip the world.
export const LOCKPICK_MYCO_COST = 12;

// item 14 — a gamble that hides its odds is a slot machine; one that publishes them is a
// decision. Every tier states its per-lockpick chance and its payout range, and `maxTries` caps
// how many lockpicks a single chest can ever eat. Expected lockpicks per open is 1/chance —
// 2.2 / 4.0 / 10.0 — and maxTries is ~2x that, so the tail is bounded rather than open-ended.
// The ceiling only ever helps: with it, measured lockpicks-per-open is 2.1 / 3.7 / 8.8, so the
// published number is the worst case for the player, never the best.
//
// ONE SYMBOL FOR "SEALED CHEST", TIER READ OFF IT — never three unrelated pictures. 🧰/🪨/👁 taught
// nothing: an egg, a rock and an eye share no shape, and the eye read as something to look at
// rather than a container to open. Same rule the gear collection already follows: one silhouette,
// rarity carried by a pip count and a colour, so a player learns the glyph once and reads the tier
// off it. `icon` stays the composed glyph+pips string because every existing caller (the hover
// chip, chestPrompt(), the payout announce lines) prints it as plain text and cannot take colour.
export const CHEST_GLYPH = '🧰';
const CHEST_PIP = '◆';
export const CHEST_TIERS = [
  { id:'crusted',   name:'Crusted Chest',   tier:1, chance:0.45, maxTries:5,
    coins:[18,34],   myco:[0,0],   gearChance:0,   color:'#d8b483' },
  { id:'ironbound', name:'Ironbound Chest', tier:2, chance:0.25, maxTries:9,
    coins:[45,80],   myco:[0,0],   gearChance:0.5, color:'#8fc3ff' },
  { id:'elder',     name:'Elder Chest',     tier:3, chance:0.10, maxTries:20,
    coins:[110,190], myco:[6,12],  gearChance:1,   color:'#c79bff' },
];
// glyph, pips and icon are DERIVED from tier in one loop, so a fourth tier can never be added with
// a mismatched picture — the thing that produced the eye in the first place.
for(const c of CHEST_TIERS){
  c.glyph = CHEST_GLYPH;
  c.pips = CHEST_PIP.repeat(c.tier);
  c.icon = c.glyph + c.pips;
}
export const CHEST_BY_ID = {};
for(const c of CHEST_TIERS) CHEST_BY_ID[c.id] = c;
// unknown ids fall back to the cheapest tier rather than throwing — a mis-tagged prop in the
// world should pay too little, not break the interaction.
function chestOf(id){ return CHEST_BY_ID[id] || CHEST_TIERS[0]; }
function randIn(range){
  if(!range || range[1] <= 0) return 0;
  return range[0] + ((Math.random()*(range[1]-range[0]+1))|0);
}

// the full star ladder for a rarity, so the Tome can price every remaining star up front
// instead of revealing one threshold at a time (item 04, same principle as the chest odds).
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
    this.myco = loadMyco();              // quest currency — contracts in, lockpicks out
    this.lockpicks = loadLockpicks();          // lockpicks — the only key into a sealed chest
    this._lockpickDry = {};                 // per-source dry streaks for the pity rule. session-only
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
  saveLockpicks(){ try{ localStorage.setItem(LS.lockpicks, String(this.lockpicks)); }catch(e){} }
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


  // ---------------- lockpicks: grant, spend, and the sources that feed them.
  // Nothing outside this file touches localStorage, so every lockpick that exists came through
  // one of these four doors: a pod, a critter, the Mycelium exchange, or the floor. ----
  grantLockpicks(n=1){
    n = n|0;
    if(n > 0){ this.lockpicks += n; this.saveLockpicks(); }
    return this.lockpicks;
  }
  spendLockpicks(n=1){
    n = Math.max(1, n|0);
    if(this.lockpicks < n) return false;
    this.lockpicks -= n; this.saveLockpicks();
    return true;
  }
  // one interaction with a lockpick source. Rolls the published chance, applies that source's
  // pity rule, grants on success. Returns everything a popup needs to explain itself.
  lockpickRoll(source='pod'){
    const s = LOCKPICK_SOURCES[source] || LOCKPICK_SOURCES.pod;
    const dry = this._lockpickDry[source] || 0;
    const forced = s.pity > 0 && dry + 1 >= s.pity;
    const got = forced || Math.random() < s.chance;
    this._lockpickDry[source] = got ? 0 : dry + 1;
    if(got) this.grantLockpicks(1);
    return { got, forced: forced && got, chance: s.chance, dry: this._lockpickDry[source],
      lockpicks: this.lockpicks, label: s.label };
  }
  // item 12 — a stomp always pays coins (scaling with the chain, so linking critters is the
  // skill expression) and sometimes pays a lockpick. It never pays nothing: a movement reward
  // that can come up empty stops being a reason to move.
  stompCritter(chain=0){
    const coins = Math.min(12, 2 + Math.max(0, chain|0)*2);
    this.coins += coins; this.saveCoins();
    const roll = this.lockpickRoll('critter');
    return { coins, lockpick: roll.got, lockpicks: this.lockpicks, coinsTotal: this.coins };
  }
  // contracts -> Mycelium -> lockpicks. The rate is fixed and worse than pods on purpose.
  lockpickExchange(){
    return { cost: LOCKPICK_MYCO_COST, myco: this.myco, lockpicks: this.lockpicks,
      max: Math.floor(this.myco / LOCKPICK_MYCO_COST), affordable: this.myco >= LOCKPICK_MYCO_COST };
  }
  buyLockpick(n=1){
    n = Math.max(1, n|0);
    const cost = n * LOCKPICK_MYCO_COST;
    if(this.myco < cost) return false;
    this.myco -= cost; this.saveMyco();
    this.grantLockpicks(n);
    return true;
  }
  // item 30 — the floor, and the reason "no way into a chest" is not a reachable state.
  // Call once at hunt start. It only fires on a wallet with no lockpicks AND not enough Mycelium
  // to buy one, so it can't be farmed by restarting; it just means a returning player who
  // spent everything last hunt still has one attempt in front of them.
  ensureLockpickFloor(){
    if(this.lockpicks > 0 || this.myco >= LOCKPICK_MYCO_COST) return { granted:false, lockpicks:this.lockpicks };
    this.grantLockpicks(1);
    return { granted:true, lockpicks:this.lockpicks };
  }

  // ---------------- sealed chests: the sink, with its odds on the label ----------------
  // `state` is the chest's own { tries } counter, owned by the world object rather than by the
  // save — a chest is per-run, and its attempt history dies with the world it stands in.
  chestInfo(tierId, state){
    const t = chestOf(tierId);
    const tries = state && Number.isFinite(state.tries) ? state.tries : 0;
    return { id:t.id, name:t.name, icon:t.icon,
      // glyph/pips/tier/color are the same iconography split apart, for any caller that CAN
      // colour it (the HUD legend) instead of printing one plain-text string
      glyph:t.glyph, pips:t.pips, tier:t.tier, color:t.color,
      chance:t.chance, pct:Math.round(t.chance*100),
      expectedLockpicks:+(1/t.chance).toFixed(1),
      maxTries:t.maxTries, tries, triesLeft:Math.max(0, t.maxTries - tries),
      coins:t.coins, myco:t.myco, gearChance:t.gearChance,
      lockpicks:this.lockpicks, canPry:this.lockpicks >= 1 };
  }
  // the prompt line, ready to render: "🧰◆ Pry the crusted chest — 45% per lockpick (🗝️ 3 held)".
  // Publishing the number is the whole point of item 14; the caller only has to draw it.
  // The 🗝️ matches the lockpick plaque in the HUD so the prompt and the wallet name the same
  // resource, and the locked line publishes the odds too — being unable to afford the gamble is
  // no reason to hide what the gamble pays.
  chestPrompt(tierId, state){
    const i = this.chestInfo(tierId, state);
    if(!i.canPry) return `${i.icon} ${i.name} — sealed · ${i.pct}% per lockpick, you hold no 🗝️ lockpick`;
    const pity = i.triesLeft === 1 ? ' · next one opens it' : '';
    return `${i.icon} Pry the ${i.name.toLowerCase()} — ${i.pct}% per lockpick (🗝️ ${i.lockpicks} held)${pity}`;
  }
  // One lockpick, one attempt, at exactly the advertised odds. A chest that has swallowed
  // `maxTries` lockpicks opens on the next attempt regardless of the roll: a gamble that
  // publishes its odds also has to terminate, or the number was a lie.
  // `gear:true` asks the caller to roll one gear drop from its own drop table — that is the
  // chest -> duplicates -> stars edge, and it stays in main.js so chests pay from the same
  // table as everything else.
  pryChest(tierId, state){
    const t = chestOf(tierId);
    if(state && !Number.isFinite(state.tries)) state.tries = 0;
    if(this.lockpicks < 1) return { ok:false, reason:'no-lockpicks', opened:false, lockpicks:this.lockpicks };
    this.spendLockpicks(1);
    const tries = state ? ++state.tries : 1;
    const forced = tries >= t.maxTries;
    const opened = forced || Math.random() < t.chance;
    const base = { ok:true, tier:t.id, name:t.name, icon:t.icon, chance:t.chance,
      pct:Math.round(t.chance*100), tries, lockpicks:this.lockpicks };
    if(!opened) return { ...base, opened:false, forced:false, triesLeft:Math.max(0, t.maxTries - tries) };
    const coins = randIn(t.coins);
    const myco = randIn(t.myco);
    if(coins){ this.coins += coins; this.saveCoins(); }
    if(myco){ this.myco += myco; this.saveMyco(); }
    return { ...base, opened:true, forced, triesLeft:0, coins, myco,
      gear: Math.random() < t.gearChance, coinsTotal:this.coins };
  }

  /* THE ONE ADVANCE PATH for every quest kind. Every verb in the game — harvest, pod, chest,
     vent, stomp, gem — reaches the contract board through here, so the payout, the replacement
     roll and the save all happen in exactly one place and a new kind is a row in QUEST_KINDS
     rather than a new method with its own subtly different completion handling.
     `n` is how many of the thing happened at once (harvesting fills every matching contract, so
     the caller passes 1 per pickup; a chain stomp can pass more).
     Returns { completed, added }: contracts just finished (already paid and removed) and their
     freshly-rolled replacements, so the caller can announce both. */
  advanceQuests(kind, n = 1, species = null){
    if(n <= 0) return { completed: [], added: [], advanced: 0 };
    const completed = [];
    // `advanced` counts contracts whose `have` actually moved. The caller needs it to know whether
    // to repaint the board: without it, PARTIAL progress was invisible — the panel only refreshed
    // when something COMPLETED, so bursting a pod against a "burst 5 pods" contract left 0/5 on
    // screen and the whole quest kind read as broken.
    let advanced = 0;
    for(const c of this.contracts){
      if((c.kind || 'harvest') !== kind) continue;
      if(kind === 'harvest' && c.species !== species) continue;
      if(c.have >= c.need) continue;
      const was = c.have;
      c.have = Math.min(c.need, c.have + n);
      if(c.have !== was) advanced++;
      if(c.have >= c.need) completed.push(c);
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
    return { completed, added, advanced };
  }
  // harvesting a mushroom of `speciesId`. Kept as its own name because a dozen call sites and the
  // critter payout path already speak it, and because "harvest" is the only kind that needs a
  // second argument at all.
  harvestFor(speciesId){ return this.advanceQuests('harvest', 1, speciesId); }
  // one line of copy for a contract, whatever its kind. Lives here because QUEST_KINDS lives here
  // and the HUD, the Tome and the completion banner must not each invent their own phrasing.
  contractLabel(c, speciesName){
    const spec = questKind(c.kind || 'harvest');
    return spec.verb(c.need, speciesName || 'spores');
  }
  contractIcon(c){ return questKind(c.kind || 'harvest').icon; }

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
