// armor.js — helmet/ring/charm gear catalog. Rarity is fixed per item (what it looks like,
// where it drops). Depth beyond that is a pure collection stat — stars (from duplicates) and
// level (bought with coins) — tracked per-item in progress.js and applied via
// progress.gearMultOf('armor', id). No unlock-gate: anything can drop once you're deep enough.
export const ARMOR = [
  // ---- helmets: max HP + damage reduction ----
  { id:'leathercap', slot:'helmet', name:'Leather Cap', icon:'🪖', rarity:0,
    hp:10, dmgReduction:0, desc:'Worn leather. Better than nothing.' },
  { id:'mosshood', slot:'helmet', name:'Moss-Woven Hood', icon:'🧢', rarity:1,
    hp:20, dmgReduction:0.05, desc:'Living moss knits itself shut over wounds.' },
  { id:'embercirclet', slot:'helmet', name:'Ember Circlet', icon:'👑', rarity:2,
    hp:35, dmgReduction:0.08, desc:'Warm to the touch, hard as fired clay.' },
  { id:'azurewarhelm', slot:'helmet', name:'Azure Warhelm', icon:'⛑️', rarity:3,
    hp:55, dmgReduction:0.12, crit:0.05, desc:'A deep-sea helm that never dents.' },
  { id:'eldercrown', slot:'helmet', name:'Crown of the Elder', icon:'👑', rarity:4,
    hp:90, dmgReduction:0.18, desc:"Grown from the Elder Myconid's own crown-spores." },
  // ---- rings: crit + attack speed + damage ----
  { id:'copperband', slot:'ring', name:'Copper Band', icon:'💍', rarity:0,
    crit:0.05, desc:'A plain band, faintly warm.' },
  { id:'verdantloop', slot:'ring', name:'Verdant Loop', icon:'💚', rarity:1,
    crit:0.08, atkSpeed:0.05, desc:'Vines coil tighter the faster you strike.' },
  { id:'embersignet', slot:'ring', name:'Ember Signet', icon:'♦️', rarity:2,
    crit:0.12, atkSpeed:0.08, desc:'A coal-red seal, always slightly smoking.' },
  { id:'azuresigil', slot:'ring', name:'Azure Sigil', icon:'🔷', rarity:3,
    crit:0.16, atkSpeed:0.12, dmg:0.10, desc:'Hums when a killing blow is near.' },
  { id:'myconidring', slot:'ring', name:'Ring of the Myconid King', icon:'💠', rarity:4,
    crit:0.25, atkSpeed:0.18, dmg:0.15, desc:'Worn by the Bloom itself, once.' },
  // ---- charms: magnet + drop luck + lifesteal ----
  { id:'sporepouch', slot:'charm', name:'Spore Pouch', icon:'👝', rarity:0,
    magnet:0.15, desc:'A drawstring pouch that hums near essence.' },
  { id:'luckycap', slot:'charm', name:'Lucky Cap', icon:'🍀', rarity:1,
    dropBonus:0.10, magnet:0.15, desc:'Four-lobed. Shouldn’t be possible.' },
  { id:'embertalisman', slot:'charm', name:'Ember Talisman', icon:'🔥', rarity:2,
    lifesteal:0.05, magnet:0.20, desc:'Pulses once for every drop of blood spilled.' },
  { id:'azureamulet', slot:'charm', name:'Azure Amulet', icon:'🔮', rarity:3,
    lifesteal:0.08, dropBonus:0.15, magnet:0.25, desc:'Cold, and always facing the deepest Bloom.' },
  { id:'heartofgrove', slot:'charm', name:'Heart of the Grove', icon:'💗', rarity:4,
    lifesteal:0.12, dropBonus:0.20, magnet:0.35, desc:'Still beats, faintly, in your hand.' },
];
export const ARMOR_BY_ID = Object.fromEntries(ARMOR.map(a => [a.id, a]));
export const ARMOR_SLOTS = ['helmet', 'ring', 'charm'];
export const SLOT_ICON = { helmet:'🪖', ring:'💍', charm:'🔮' };
