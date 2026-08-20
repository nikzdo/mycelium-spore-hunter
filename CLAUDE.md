# MYCELIUM — Spore Hunter

Browser roguelite, Three.js, **no build step**. `index.html` uses an import map pointing `three`
at the vendored `vendor/three.module.js` and loads `js/main.js` as a plain ES module. Edit a file,
reload the tab. Serve over HTTP (`python3 -m http.server 8000` from the repo root) — `file://`
breaks ES module imports on CORS.

See README.md for mechanics and the file-by-file architecture table.

## Verifying a change

There is no test suite. Verification is the debug query params, and they are the reason they
exist — **keep them working**:

| param | use |
|---|---|
| `?seed=N` | force a world seed; same seed must always regenerate identically |
| `?demo` | scripted bot drives a run — headless verification |
| `?probe` | live run state via `document.title`, polled by `setTimeout` so it survives a backgrounded tab |
| `?boss` / `?win` | force a boss spawn / force the victory flow |
| `?glutton` / `?elder` | force the boss archetype, overriding the seeded pick |
| `?god` | player takes no effective damage |
| `?tome=` `?levelup=` `?buy=` | jump straight to a UI state |

Syntax check without a browser: `cp js/x.js /tmp/c.mjs && node --check /tmp/c.mjs`
(plain `node --check` treats the file as CommonJS and fails on `import`).

Minimum bar for any change: the page loads with **zero console errors**, and `?demo&seed=42`
still plays.

## Performance discipline

These are load-bearing. The codebase has been through perf-regression passes and the rules are
what keep it fast:

- **Batch repeated geometry into `InstancedMesh`.** Rocks, trees, grass, decorative mushrooms —
  one draw call regardless of count. New per-world content pushes into the *existing* instance
  arrays rather than creating new draw calls.
- **Never attach a real `THREE.PointLight` to anything that spawns or despawns in bursts**
  (pickups, projectiles). Adding/removing a light forces shader recompilation on other materials
  in the scene and hitches. Real lights are reserved for singular, rare landmarks.
- **No per-frame allocations in hot paths.** `groundHeight()` and `surfaceAt()` run for every
  entity every frame. Plain-number math only — no `new Vector3()` in anything they call.
- **Diff-based DOM updates.** HUD widgets touch the DOM only when their displayed state actually
  changes, never once per frame.

## Shadow policy

Two rules, and they are why the ground reads as shadow rather than as dirt:

1. **A thing casts only if its shadow would read as a shape.** The rig is one 2048 map over a
   190 m ortho box — about 10.8 texels per metre — so a 40 cm prop projects into four texels of
   smear. `shadowize()` enforces a minimum caster radius (`SHADOW_MIN_R`); everything under it
   still *receives*, which is the effect that actually matters. Subtrees whose whole point is to be
   a small solid object can opt down (`{ minR }`) — props.js does, because a floating pod's shadow
   is how the player reads that it is floating.
2. **One shadow per character.** Anything that walks carries a blob (a soft mapped disc that
   tracks the surface). Letting it also cast into the map gives every creature two unrelated
   shadows — a contact disc plus a long skewed projection — on exactly the things the eye follows.
   The blob wins; characters pass `{ noCast: true }`. Bosses are the deliberate exception.

`shadowBox` in `world.js` PARAMS is a **resolution** dial, not a coverage dial: main.js retargets
the sun at the player every frame, so shrinking the box sharpens every shadow you can actually see.
Don't shrink it past the fog, though — a shadow outside the box stops existing, and the edge
becomes visible popping.

## Habits

Adopted from a code review of a sibling procedural-island prototype. They are why that file stays
comprehensible, and they apply here.

**A movement constant is a level-design constraint — say so.** Sprint is a ground-only move and
air speed is capped; the reason is that a running jump must not clear a gap the level intends you
to route around. When a tuning value is load-bearing for a piece of level design, the comment
says which design it holds up, so the next person doesn't casually bump it. Our ravine, bridge and
`STEP` height all want this treatment.

**One chokepoint per cross-cutting effect.** All damage through one `hurt()`, all effects through
one particle call, all payouts through one reward pop. New content then gets consistent feel for
free, and tuning happens in one place instead of six.

**Placement predicates query the finished world, not the noise.** Every spawn test reads height,
slope, exclusion zones *and the collider list* — so a prop can't spawn inside something that
already exists. This is the single habit that most separates a generator that produces places from
one that produces scatter.

And one test none of those can replace: **`reachable(x, z)` in `world.js`** — a reachability mask
flood-filled once from the run's spawn point, with DOWN free and UP costing one jump. Slope catches
cliff faces, colliders catch "inside a rock"; neither can see a flat, legal shelf with no legal way
onto it, because locally that shelf looks exactly like meadow. Anything the player has to *touch* —
critters, pods, chests, vents — is gated on it, always as the LAST predicate, because it is the only
one that can trigger the flood. It is built lazily so that colliders exist first, and invalidated on
every world build and teardown. Gating placement is only half of it: `fauna.js` also re-checks live
critters against the mask on a slow tick, because a critter can *wander* somewhere it could not
have spawned.

**Comments state the invariant, not the code.** Not "loop over the tiers" but "the visual mesh and
the collision volume come out of the same loop, so they can never drift apart." Not "30% chance"
but "pods are where pry-spines come from, so cysts always stay reachable." Not "dispose geometry"
but "dropping the shared geometry would empty every prop built afterwards." The README does this
at architecture level; do it at line level too, because that's where it prevents the regression.

## Ownership boundaries worth preserving

- **`progress.js` owns every `mycelium_*` `localStorage` key.** Essence bank, mutations, gear
  collection, coins, Mycelium, lockpicks, contracts, World Depth. Nothing else reads or writes them.
  Per-run state lives on `game` in `main.js` and on `Player`, and is discarded on every new hunt —
  the elemental ring slot is per-run for exactly this reason.
  **Persisted shapes need a migration path, not a filter.** Contracts grew a `kind` field; the loader
  defaults a missing one to `'harvest'` rather than dropping the entry, because silently voiding a
  player's in-progress quests is the worst class of save bug. Same for the `mycelium_spines` key,
  which keeps its old name after the rename to lockpicks so no wallet resets.
- **`weapons.js` / `armor.js` / `potions.js` / `rings.js` / `mushrooms.js` / `bossTraits.js` are
  pure data.** No progression logic — that all lives in `progress.js`. `palette.js` is pure too, and
  deliberately imports nothing at all so it can be exercised under plain `node`.
- **Geometry and collision are emitted together.** A prop that registers a collider does it in the
  same loop that builds its mesh, so the two cannot drift apart.
- **Seeded determinism.** `mulberry32` streams, with `deriveSeed(seed, salt)` giving each
  subsystem an independent stream from one world seed. A seed must always rebuild the same world;
  don't introduce `Math.random()` into generation.
