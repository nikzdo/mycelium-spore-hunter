// rings.js — the elemental ring catalog. PURE DATA, same contract as weapons.js / potions.js /
// armor.js: no progression logic, no scene access, no localStorage. main.js owns the hold input and
// the emitter, entities.js owns what burning and chilling DO to a creature, progress.js owns
// nothing here at all — an elemental ring is per-run state and dies with the hunt.
//
// WHY THIS IS NOT A NEW ARMOUR RING. armor.js already has a `ring` slot (Copper Band, Azure
// Sigil…) and those are permanent collection items with stars, duplicates and coin levels. An
// elemental ring is the opposite of all three: it is found, it is spent, and it is gone. Putting
// it in the gear slot would mean a consumable with a star meter, and would force a player to
// choose between a crit stat and a fire spell — two things that should never compete. So the
// elemental ring is its own single slot, and the word "elemental" is load-bearing in the code even
// where the HUD just says FIRE RING.
//
// WHY A HELD CHARGE AND NOT A COOLDOWN. Combat here is a melee combo with per-weapon finishers,
// and it owns the attack button and the kill fantasy (see the same argument in fauna.js). A ring
// on a cooldown becomes a second damage rotation competing with the combo. A ring with a draining
// charge is a RESOURCE you decide when to burn: it never out-damages the blade, it changes what a
// fight is for a few seconds, and then it is spent. That is why `charge` is in seconds of holding
// rather than in casts.

export const RINGS = [
  {
    id:'fire', name:'Fire Ring', icon:'🔥', kind:'burn', verb:'burn', hissFreq:320,
    // hot orange, deliberately clear of the Ember Signet's coal red so the HUD chip and the gear
    // chip can never be mistaken for each other
    color:0xff7a24, glow:0xffd07a,
    charge:16,                  // seconds of held spray. 10-20 is the band the design asks for.
    // Reach is shorter than it looks like it should be. A cone that outranges the blade turns the
    // ring into the primary weapon, which is the one thing it must not become.
    reach:9.0, angle:0.62,      // radians of half-angle: a 71-degree cone
    dps:9,                      // direct damage while inside the cone — the smaller half
    // The real payload. Burning keeps ticking after you let go, so the fire ring's value is
    // SPREAD: sweep a group, then go back to the combo while they cook.
    burnDur:3.4, burnDps:20, burnTick:0.4,
    particles:{ n:3, size:9, life:0.5, rise:2.2, spread:1.5, grav:-1.2, alpha:0.85 },
    desc:'Hold to spray fire. Burns keep ticking after you let go.',
  },
  {
    id:'ice', name:'Ice Ring', icon:'❄️', kind:'chill', verb:'freeze', hissFreq:900,
    color:0x7ad4ff, glow:0xdcf6ff,
    charge:13,                  // shorter than fire: a slow is worth more per second than a burn
    reach:8.0, angle:0.72,      // wider and shorter — a blizzard is a wall, not a jet
    dps:5,                      // almost no damage. The ring buys you TIME, not kills.
    // 0.68 rather than a hard freeze: a creature frozen to a standstill stops telegraphing, and
    // a telegraph you cannot read is worse for the player than an enemy that is merely slow.
    chillDur:2.6, chillSlow:0.68,
    particles:{ n:3, size:8, life:0.55, rise:0.4, spread:1.9, grav:2.4, alpha:0.8 },
    desc:'Hold to freeze. Chilled creatures crawl and swing late.',
  },
  {
    // fire trades for spread, ice trades for time — poison trades for safety: it doesn't burn
    // faster or slow harder, it makes what's still standing hit you for less while it dies.
    id:'spore', name:'Spore Ring', icon:'☠️', kind:'poison', verb:'weaken', hissFreq:520,
    color:0x8fd93a, glow:0xd4ff8a,
    charge:15,
    reach:8.5, angle:0.62,
    dps:6,                      // between fire's spread-damage and ice's near-zero: poison's real
                                 // payload is defensive, not offensive, so its own tick stays modest
    // weaken, not a bigger DoT: a poisoned mushroom still dies on its own schedule, but hits for
    // noticeably less while it does — reach into the mob before it reaches you, buying survival
    // rather than a kill you were already going to get.
    poisonDur:3.0, poisonWeaken:0.35,
    particles:{ n:3, size:8, life:0.6, rise:0.9, spread:1.6, grav:0.4, alpha:0.8 },
    desc:'Hold to weaken. Poisoned prey hit for noticeably less while it lasts.',
  },
];
export const RINGS_BY_ID = Object.fromEntries(RINGS.map(r => [r.id, r]));

// One hotkey for the slot, not one per ring: you hold at most one elemental ring, so the key means
// "use the ring", and the HUD chip says which ring that currently is. Two keys would make the
// player learn a binding for something they might never find.
export const RING_KEY = 'KeyZ', RING_KEY_LABEL = 'Z';
