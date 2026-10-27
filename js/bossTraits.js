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

// Season-surge traits — same shape as BOSS_TRAITS above, but never rolled by rollBossTrait().
// main.js's resetRun() rolls these on its own gate, keyed by the CURRENT season (game.season),
// the same way affixes.js keeps NOCTURNAL_AFFIX out of the normal affix pool and gates it on
// night instead — a trait that can only ever appear during its own season reads as "the world
// itself changed what this boss can do" rather than one more entry in the usual grab bag.
// Each one amplifies an EXISTING trait's ability (see entities.js's isTrait() branches) rather
// than inventing a new mechanic, so the fight stays something the codebase has already tested —
// just noticeably stronger in the one way that matches its season.
export const SEASON_BOSS_TRAITS = {
  elder: [
    { id:'blooming', name:'Spring Bloom', tint:0xff9ad8, glow:0xffd8f0,
      desc:'Spring surge — regrows health far faster than a normal Elder the instant it goes unharmed.' },
    { id:'scorching', name:'Summer Scorch', tint:0xffb347, glow:0xffe066,
      desc:'Summer surge — its cinderfire comes around faster and burns hotter than any normal Elder\'s.' },
    { id:'withering', name:'Autumn Wither', tint:0xc0783a, glow:0xffb36b,
      desc:'Autumn surge — grows far more desperate, and far more dangerous, as its health falls.' },
    { id:'frostbound', name:'Winter Frost', tint:0x8fd8ff, glow:0xcff5ff,
      desc:'Winter surge — its spore-ring attack comes around faster and echoes further than any normal Elder\'s.' },
  ],
  glutton: [
    { id:'sprouting', name:'Spring Sprout', tint:0x8adf6a, glow:0xd8ffb0,
      desc:'Spring surge — leaves bigger, longer-lived toxic puddles, and leaves them more often, than any normal Glutton.' },
    { id:'blistering', name:'Summer Blister', tint:0xff8a3a, glow:0xffc86b,
      desc:'Summer surge — charges far more often as its health drops.' },
    { id:'molding', name:'Autumn Mold', tint:0x8a6a3a, glow:0xc8a868,
      desc:'Autumn surge — its vomited bile sprays wider and leaves corrosive ground behind it.' },
    { id:'bloated', name:'Winter Bloat', tint:0xcfe8f5, glow:0xffffff,
      desc:'Winter surge — a much thicker hide blunts even more incoming damage.' },
  ],
};
