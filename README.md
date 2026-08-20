# MYCELIUM — Spore Hunter

A browser-based, top-down action roguelite built with [Three.js](https://threejs.org/). No build step, no bundler — plain ES modules served statically. You are the last Spore Hunter, cutting through a corrupted, procedurally-generated forest toward whichever ancient horror rules it.

## Running it locally

ES modules require a real HTTP origin (`file://` won't work because of CORS on module imports):

```bash
cd app
python3 -m http.server 8000
```

Then open `http://127.0.0.1:8000/index.html`.

### Debug/dev query params

| Param | Effect |
|---|---|
| `?seed=N` | Force a specific world seed instead of a random one |
| `?demo` | Auto-starts a run driven by a scripted bot (used for headless verification) |
| `?probe` | Reports live run state (kills, hp, level…) via `document.title`, polled by setTimeout so it works even in a backgrounded tab |
| `?boss` | Force-spawns a boss a few seconds in |
| `?win` | Like `?boss`, but also auto-kills it shortly after (for verifying the victory flow) |
| `?glutton` / `?elder` | Force which boss archetype spawns, overriding the seeded pick |
| `?god` | Player takes no effective damage (survive-for-screenshot) |
| `?tome=` / `?levelup=` / `?buy=` | Open specific UI states or force specific events for screenshot verification |

## Controls

`W/S` move · mouse steers · `A/D` turn · click to attack · `SPACE` jump · `SHIFT` dash · `1-7` switch weapon · `Q/E/R/F/G` potions · **hold `Z`** elemental ring · `C` interact (pry a chest, ride a vent) · `H` harvest a nearby mushroom · `B` backpack · `TAB` Spore Tome · `M` mute · `ESC` pause

---

## Mechanics

### Core loop

Kill mushrooms in an open world, level up mid-run (temporary stat growth), collect weapons/armor/potions that drop from kills, and lure out the world's boss by killing enough rare+ mushrooms. Beating the boss ends the hunt in victory; dying ends it in defeat. Either way, a **new procedurally-generated world** is one click away — but see [World Depth](#world-depth) below for what carries over.

### Combat

Melee-only, combo-based: every 3rd hit in a swing chain triggers the equipped weapon's unique **finisher** (a `nova`/`shockwave`/`chainhit`/`devour`/etc. effect defined per-weapon in `weapons.js` and executed in `Player.attack()`). Weapons have distinct silhouettes, stats, and finishers rather than being palette-swapped clones — a dagger trades range and raw damage for crit and attack speed, a greatsword hits like a truck at half the pace, and so on.

### Gear collection — stars, duplicates, levels

Both weapons and armor (helmet/ring/charm) share one progression model, deliberately modeled on mobile gacha-style equipment screens (Archero et al.):

- **Finding an item** the first time (any run) permanently registers it in your collection at 0 stars / level 1.
- **Finding a duplicate** feeds that specific item's star meter. Rarer items need fewer duplicates per star (`max(1, nextStar - rarity)`); once maxed at 6 stars, further duplicates refine into coins instead of being wasted.
- **Coins level it up**, independent of stars, up to a cap that stars raise (`15 + stars×15`). So stars gate how far coins can take you, and coins are how you actually spend that headroom.
- Both axes feed one multiplier — `1 + stars×0.12 + level×0.01` — applied to the item's stats. All of this lives in `progress.js` (`gearInfo`, `addDupe`, `levelUpGear`) and persists in `localStorage` across every run.

The Spore Tome's **Equipment** tab is the full permanent collection (every item you've ever found, across all hunts); the in-run **Backpack** only shows what you've found *this* hunt, since equipping something still requires having it on you.

### Mutations

A small, separate meta-progression track (Spore Tome → Alchemy): permanent player-wide buffs (damage, speed, HP, drop luck, pickup range, a free starting level) bought with **spore essence** collected per-kill, tiered 1→3.

### The world's other verbs — pods, chests, vents, critters, crystals

Combat is not the only thing the world is for, and none of these compete with it for the attack button:

- **Flower pods** hover just inside a standing jump (the reachability constraint is documented on `PROP_PARAMS.podBotMin`) and pay coins when your head hits them from underneath. Some carry several charges; some are worth ×10. Pods are also the main source of **lockpicks**.
- **Sealed chests** publish their odds on the label before you spend anything: three tiers at 45% / 25% / 10% per lockpick, each with a `maxTries` ceiling that makes the published number a worst case. They pay coins, Mycelium and one roll from the same drop table a kill uses.
- **Vents** are two-way shortcuts in colour-coded **pairs** — violet, ember, verdant — so the colour tells you where you come out. The vent you arrive at goes on a 15-second cooldown, which is what stops a pair of vents being an infinite loop.
- **Critters** (3 species, gated by radius and slope band) don't fight back and can't be killed by the combo — they can only be **harvested by landing on them**. Chaining stomps escalates the payout, and each species pays a different currency. Stomps are also the only source of elemental rings.
- **Spore crystals**: four per world, all at one hard-to-reach site, guaranteed to exist.

### Elemental rings

A **Fire Ring** or **Ice Ring** drops from stomping critters and equips into its own single slot (separate from the `ring` armour slot, which is permanent collection gear — see the note at the top of `rings.js` for why those must never be the same thing). Holding `Z` spends its charge, measured in *seconds of holding*, and sprays a cone in front of you: fire leaves a burn that keeps ticking after you let go, ice slows what it touches to a crawl. When the charge runs out the ring is gone. It is a resource you decide when to burn, not a second damage rotation.

### Contracts

You always have 3 active **contracts**, drawn from six kinds — harvest N of one mushroom species, burst N pods, pry N chests, ride N vents, land on N critters, recover N crystals. Completing one pays **Mycelium** and rolls in a replacement. Every kind's `need` is bounded by what a single world actually contains (the gem contract's ceiling of 2 against a world's 4 crystals is the tightest of these). Mycelium's only sink is buying lockpicks, which is what closes the loop: chest contracts pay for the lockpicks that open chests.

Harvestable mushrooms are the small stationary glowing ones (4 species, colour-coded), picked with `H` when nearby. A prompt shows what's in reach, and a HUD panel tracks all 3 contracts live.

### Healing

A **Vitality Draught** rolls on its own, separately from the generic potion table, on every kill — 3% off a Common up to 12% off a Mythic — and again at 45% from every chest you open. It sits on `F` like the other potions, and its slot pulses when you're under a third HP and holding one.

### Bosses

Two archetypes with entirely different silhouettes and kits — **Elder Myconid** (tall, ring-burst AOE, brood summons) and **Rotmaw the Bloated** (squat, telegraphed charge-slam, vomit barrage, toxic puddles). Each spawn also rolls one of 4 archetype-specific **traits** (e.g. Elder's *Wrathful Bloom* ramps damage as it loses HP; Rotmaw's *Corrosive Bile* makes its projectiles leave lingering puddles) plus a small seeded stat jitter, so the same boss doesn't fight identically twice. Which boss, which trait, and the stat roll are all derived from the world seed, so a given seed always awakens the same boss — no more true-random coin flip at spawn time.

### World Depth

A persistent difficulty counter, separate from your gear/mutation progress. **Beating a boss advances it**; **dying resets it to 1**. It scales enemy HP/damage/speed everywhere (not just far from spawn), nudges tougher rarities to appear sooner, bumps spawn density, and scales the next boss's stats too — so a winning streak keeps getting harder, and a death gives you a clean slate for difficulty while your gear collection and mutations stay exactly as they were. Shown in the zone label, the Spore Tome, and the victory/game-over screens.

### Procedural world generation

Every world is a fresh `mulberry32` PRNG stream seeded from a single 32-bit seed (`rng.js`), so a given seed always regenerates identically. Beyond terrain (rolling hills, an optional ravine+bridge, 1-2 cave mouths, 3-5 rock formations), each world independently rolls:

- **Which "big" landmarks appear** — mother-mushroom tower, standing stones, spore geysers, watering hole — each ~62% likely (floor of 2, so no world is bare).
- **Up to 3 themed "pockets"**: a Crystal Hollow (denser crystal clusters), a Fungal Warren (one harvest species dominates a patch — a natural "farm here" spot), and a Withered Hollow (a corruption patch independent of distance from spawn, with its own twisted-spike props).

This means worlds differ structurally, not just by palette swap and prop position.

---

## Architecture

No framework, no bundler — `index.html` loads `js/main.js` as a module via an import map pointing `three` at the vendored `vendor/three.module.js`.

| File | Responsibility |
|---|---|
| `main.js` | Game orchestration: render loop, input, HUD/UI wiring, spawn tables, drops, the Spore Tome and Backpack screens |
| `world.js` | Procedural world generation — terrain, sky, vegetation, landmarks, pockets, corruption |
| `entities.js` | `Player`, `Mushroom` (base enemy), `Boss`/`GluttonBoss`, `Powerup` |
| `progress.js` | All persistent meta-progression: essences, mutations, gear collection (stars/dupes/levels), coins, Mycelium, harvest contracts, World Depth. The single `localStorage`-backed source of truth |
| `weapons.js` / `armor.js` | Pure data catalogs — stats, rarity, visuals. No progression logic; that's all in `progress.js` |
| `bossTraits.js` | The trait catalog rolled onto boss spawns |
| `mushrooms.js` | Harvestable species catalog shared by world generation and the contract system |
| `potions.js` | Potion catalog |
| `props.js` | The interactive props — flower pods, sealed chests, vents, spore crystals. Computes payouts and **reports** them; main.js owns the credit, the audio and the copy |
| `fauna.js` | Wandering critters: species/habitat table, the wander resolver, the stomp window and the chain |
| `rings.js` | Pure data: the elemental ring catalog (Fire / Ice) and its hotkey |
| `palette.js` | Generative world palettes — solves a coherent scheme per seed under explicit contrast floors. Zero imports, so it runs under plain `node` |
| `rockgen.js` | Stepped rock/mesa formations: merged fill + a separate merged ink hull, colliders emitted from the same loop as the vertices |
| `fx.js` | Shared visual helpers: toon-shading material factory, outline-hull generator, procedural canvas textures, particle pool, noise/fBm primitives |
| `swordVisuals.js` | Per-weapon blade geometry construction |
| `audio.js` | Fully synthesized WebAudio SFX + a small procedural BGM sequencer — no audio assets |
| `rng.js` | `mulberry32` PRNG + seed-derivation helpers (`deriveSeed`) so independent subsystems get independent, still-deterministic streams from one world seed |

### Visual style

A consistent hand-painted toon look: `toonMat()` wraps `MeshToonMaterial` with an `onBeforeCompile` injection for rim lighting and warm/cool tinting; `addOutline()` adds an inverted-hull `BackSide` child mesh for ink outlines. Procedural canvas textures (`paintTexture`, strata/ring textures) stand in for hand-authored art.

### Performance discipline

This codebase has been through a couple of perf-regression passes, so a few rules are load-bearing:

- **Batch repeated geometry into `InstancedMesh`.** Rocks, trees, grass, decorative mushrooms — all single-draw-call regardless of count. New per-world "pocket" content pushes into the *same* instance arrays rather than creating new draw calls.
- **Never attach a real `THREE.PointLight` to anything that spawns/despawns in bursts** (pickups, projectiles) — adding/removing a light forces shader recompilation on other materials in the scene and causes hitches. Real lights are reserved for singular, rare landmarks.
- **No per-frame allocations in hot paths.** `groundHeight()` runs for every enemy and the player every frame; helpers it calls (e.g. ravine-depth) are plain-number math, no `new Vector3()`.
- **Placement predicates query the finished world, not the noise.** Every spawn test reads height, slope, exclusion zones, the collider list — and `reachable()`, a reachability mask flooded once from the run's spawn point. Slope catches cliff *faces* and colliders catch "inside a rock"; only the flood catches a perfectly flat, perfectly legal shelf with no legal way onto it. Anything the player has to touch is gated on it.
- **Diff-based DOM updates**, not rebuild-every-frame — HUD widgets that change rarely (buffs, contracts) only touch the DOM when their displayed state actually changes.s.

### Persistence

Everything under the `mycelium_*` `localStorage` key prefix is owned by the `Progress` class in `progress.js` — essence bank, mutations, weapon/armor gear collection, coins, Mycelium, active harvest contracts, and World Depth. Nothing else in the codebase reads or writes those keys directly. Per-run state (current HP, position, which weapons you've found *this* hunt) lives on the `game` object in `main.js` and `Player` in `entities.js`, and is discarded on every new hunt.
