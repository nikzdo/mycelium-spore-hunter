// bossTraits.js — seeded "affix" catalog that makes the same boss archetype play and
// read differently between hunts. Data only: names/colors/descriptions live here, the
// actual behavior each id triggers is wired into Boss/GluttonBoss in entities.js.
export const BOSS_TRAITS = {
  elder: [
    { id:'regen', name:'Verdant Regrowth', tint:0x4fae5a, glow:0x8fe89a,
      desc:'Regrows lost health if left unharmed too long — don’t let up.' },
    { id:'mirror', name:'Spore Mirror', tint:0x5adfe0, glow:0xbfffff,
      desc:'Its spore-ring burst fires a third, delayed echo.' },
    { id:'swarming', name:'Hive Mother', tint:0xd88a3a, glow:0xffc86b,
      desc:'Calls its brood more often, and more of them at once.' },
    { id:'wrathful', name:'Wrathful Bloom', tint:0xdb3a3a, glow:0xff8a6b,
      desc:'Grows sharply more aggressive as its health drops.' },
    { id:'pyroclast', name:'Cinderbloom', tint:0xdb5a1a, glow:0xff8a3a,
      desc:'Periodically hurls a slow, telegraphed fireball that scorches the ground where it lands.' },
    { id:'fusion', name:'Mycelial Fusion', tint:0x5adf7a, glow:0xaaffb0,
      desc:'Its summoned brood drift together and permanently fuse into stronger threats.' },
  ],
  glutton: [
    { id:'toxic', name:'Putrid Bloat', tint:0x6a8f2a, glow:0xb8e05a,
      desc:'Leaves bigger, longer-lived toxic puddles.' },
    { id:'frenzied', name:'Ravenous Frenzy', tint:0xc03a2a, glow:0xff8a5a,
      desc:'Charges much more often as its health drops.' },
    { id:'corrosive', name:'Corrosive Bile', tint:0x3a8f6a, glow:0x6bffcf,
      desc:'Its vomited bile leaves lingering toxic puddles where it lands.' },
    { id:'thickhide', name:'Blubbery Hide', tint:0x6a5a3a, glow:0xd8b878,
      desc:'A thick hide blunts a noticeable share of incoming damage.' },
    { id:'pyroclast', name:'Magma Gorge', tint:0xc0421a, glow:0xff8a3a,
      desc:'Occasionally spits a heavy glob of molten bile that explodes into scorched ground.' },
    { id:'fusion', name:'Gluttonous Swarm', tint:0x8adf3a, glow:0xd8ffa0,
      desc:'Its brood drift together and permanently fuse into stronger threats.' },
  ],
};
export function rollBossTrait(archetype, rng){
  const pool = BOSS_TRAITS[archetype];
  return pool[(rng()*pool.length)|0];
}

// The Bloom Ascendant — never rolled by rollBossTrait(), so it can only ever appear through
// main.js's own gate (progress.eldersBeaten + progress.gluttonsBeaten, see resetRun). Boss's
// isTrait() treats this id as matching every elder trait check at once (entities.js), so the
// fight is deliberately every elder mechanic layered together rather than one bespoke kit —
// beating both archetypes enough times earns the sum of everything either one can do.
export const ASCENDANT_TRAIT = { id:'ascendant', name:'Convergence', tint:0xffe066, glow:0xffffff,
  desc:'Every trait an Elder can carry, all at once — regrowth, echoing rings, a swelling brood, and a wrath that only sharpens as it falls.' };
