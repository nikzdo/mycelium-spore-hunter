// affixes.js — light-weight per-spawn modifiers for rare+ mushrooms, the same shape as
// bossTraits.js (id, name, tint, desc) but rolled per-enemy instead of per-boss. Pure data:
// what each affix actually DOES lives in entities.js (Mushroom.hit) and main.js (spawnEnemy),
// same split bossTraits.js already uses.
export const AFFIXES = [
  { id:'thorned', name:'Thorned', tint:0xff5a7a,
    reflectPct:0.16, // fraction of the melee damage it takes that reflects back to the player
    desc:'Reflects a share of melee damage back at whoever lands the hit.' },
  { id:'swift', name:'Swift', tint:0xffe066,
    speedMult:1.4,
    desc:'Noticeably faster than others of its rarity.' },
  { id:'bulwark', name:'Bulwark', tint:0x8fa8ff,
    kbResist:0.35, hpMult:1.25,
    desc:'Braced and heavier — shrugs off knockback.' },
  // elemental triangle, one counter-ring each: fire beats venomous, ice beats scorched, poison
  // beats frosted. resistWeakOf() in entities.js is the one place that reads these two fields —
  // main.js's hover tag is what makes the counter learnable rather than a hidden number.
  { id:'scorched', name:'Scorched', tint:0xff8a3a,
    resist:'burn', weak:'chill',
    desc:'Fire barely singes it. Cold bites twice as hard.' },
  { id:'frosted', name:'Frosted', tint:0x8fe0ff,
    resist:'chill', weak:'poison',
    desc:'Numb to the cold. Poison spreads through it fast.' },
  { id:'venomous', name:'Venomous', tint:0x9fe066,
    resist:'poison', weak:'burn',
    desc:"Toxin doesn't take. Catches like dry rot instead." },
];
export const AFFIX_BY_ID = Object.fromEntries(AFFIXES.map(a => [a.id, a]));

// only rare+ mushrooms are eligible, and even then it's the exception — an affix should read as
// "oh, this one" rather than becoming the default state of every rare+ spawn
export const AFFIX_CHANCE = 0.18;
export function rollAffix(rng = Math.random){
  if(rng() >= AFFIX_CHANCE) return null;
  return AFFIXES[(rng() * AFFIXES.length) | 0];
}

// Nocturnal is deliberately NOT in AFFIXES/AFFIX_BY_ID: rollAffix()'s pool is rarity-gated and
// time-blind, and the entire point of this one is that it is NEVER available except when
// main.js's own night-cycle clock says so — folding it into the uniform pool would make it just
// another 1-in-18 reskin instead of something you only ever see after dark. main.js rolls this
// one directly, on its own gate, for any rarity (not just rare+ — see the note at its call site).
export const NOCTURNAL_AFFIX = { id:'nocturnal', name:'Nocturnal', tint:0x9a5fff,
  hpMult:1.2, speedMult:1.15,
  desc:'Only stirs after dark. Faster and hardier than its daylight kin.' };
