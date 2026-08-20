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

## Lighting: cream is load-bearing

`PROP_CREAM` (0xf2e4c8) is not decoration. Mushroom stems, spore pods and the hunter's own face
band are all that one colour, and `palette.js` solves the ground's luminance *against* it so those
props stay readable (`creamVsGround`). But readability was solved against the **albedo**, and what
reaches the eye is albedo × light — so two things in the light rig can undo it, and both are now
bounded:

- **The sun's tint.** A heavily tinted sun re-colours every neutral surface no matter what the
  contrast floors did. `limitTint()` caps the sun's dimmest channel at `SUN_MIN_CHANNEL` of its
  brightest by mixing toward white — hue-agnostic, so the warm/cool temperature split survives and
  only the strength of the tint is bounded. Clamping HSL saturation does *not* work here: at S=1.0
  the channel spread is set by lightness, and the suns that caused the problem were already at 1.0.
- **The sun's elevation.** `ELEV_SWING` in the day cycle. At a grazing sun an upward-facing surface
  gets almost nothing direct, so the dominant light on it becomes the hemisphere's **ground**
  bounce — which is the soil colour by construction. Cream lit mostly by brown reads as brown.
  Note what the swing does *not* touch: rotation about Y sweeps the light around the compass
  without changing elevation, so narrowing the Z swing keeps every bit of the moving shadows.

If props ever look brown again, check the light before you touch a material.

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

## Measuring performance here

Two traps have each cost a full round of work, so measure with these in mind.

**`renderer.info.render.calls` does not include shadow-map draws** in the vendored three.js.
Verified by freezing the map entirely (`shadow.autoUpdate = false`, never flagged): the counter
moved by exactly **0**. So the shadow pass — 100 casters into a 2048² depth target — is invisible
to the number people reach for first. Never conclude shadow work is free because draw calls did not
move; count casters instead.

**Draw-call attribution needs a genuinely frozen scene.** Hiding a subtree and diffing
`render.calls` produced *negative* attributions twice before the scene was still enough. Three
things have to stop, and each was found the hard way:
- the wave spawner, which is gated on `alive < 12` and calls the **module-local** `spawnEnemy`, so
  overwriting `game.spawnEnemy` does nothing — park 12 live enemies far off-camera instead;
- `world.updaters`, because the day cycle rotates the sun, which moves the shadow frustum and
  changes which casters are inside it between samples;
- critter motion.
With all three stopped the baseline repeats exactly, and only then is a hide/diff meaningful.

**This machine cannot measure most costs.** Frame time sits at the vsync 8.3 ms median under every
load produced so far: 60 enemies, 779 draw calls, and a framebuffer swept up to 14.25 megapixels.
That is worth knowing before optimising — a change here has to be justified by counters and
reasoning, not by a frame-time delta that physically cannot appear.

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
