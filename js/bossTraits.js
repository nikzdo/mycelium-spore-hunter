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
  ],
};
export function rollBossTrait(archetype, rng){
  const pool = BOSS_TRAITS[archetype];
  return pool[(rng()*pool.length)|0];
}
