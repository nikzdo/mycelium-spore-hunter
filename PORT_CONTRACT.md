# Island port — interface contract

Working doc for the island-salvage port (58 items). **Read this before writing code.**
Delete before any PR; it is scaffolding, not documentation.

## Absolute rules

1. **You own the files listed in your task. Do not edit any other file.** Other agents are
   editing other files in this same working tree, concurrently. Touching a file you don't own
   destroys their work. If you need a change in a file you don't own, write it to
   `PORT_NOTES.md` (append-only, one bullet) and move on.
2. **The game must load with zero console errors after your change.** Every wave is committed.
   A wave that breaks the boot is worse than a wave that lands fewer items.
3. **Keep every existing debug query param working**: `?seed=N ?demo ?probe ?boss ?win
   ?glutton ?elder ?god ?tome= ?levelup= ?buy=`. `?demo` and `?probe` are how this codebase is
   verified headlessly — do not regress them.
4. **Respect the perf rules in README.md.** They are load-bearing:
   - Batch repeated geometry into `InstancedMesh` — new content pushes into *existing* instance
     arrays rather than adding draw calls.
   - **Never** attach a `THREE.PointLight` to anything that spawns/despawns in bursts. Real
     lights are reserved for singular, rare landmarks.
   - No per-frame allocations in hot paths. `groundHeight()` and `surfaceAt()` run for every
     entity every frame — plain-number math only, no `new Vector3()`.
   - Diff-based DOM updates; never rebuild HUD every frame.
5. **Comment the invariant, not the code.** This is item 52 and it applies to your own work.
   "Colliders come out of the same loop as the mesh so they can't drift apart" — that kind of
   comment. Not "// loop over tiers".
6. **Match the surrounding style.** No semicolon-free rewrites, no reformatting, no renaming
   things you weren't asked to rename. Terse comments, same density as the file you're in.

## Verification (required, every agent, before you report done)

```bash
# 1. syntax-check every file you touched
for f in js/CHANGED.js ...; do cp "$f" /tmp/chk.mjs && node --check /tmp/chk.mjs || echo "FAIL $f"; done

# 2. server is already running on :8000 from the repo root
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/index.html
```

Then load the page in a browser via the playwright MCP tools and confirm **zero console
errors**: `mcp__playwright__browser_navigate` to `http://127.0.0.1:8000/index.html?demo&seed=42`,
wait ~4s, then `mcp__playwright__browser_console_messages`. Report the actual console output in
your final message. **Do not claim success without having read that output.**

**The playwright browser session is SHARED between concurrently running agents.** Console
messages from another agent's test page will appear in your read, and vice versa. Two rules:
1. Attribute every message to its source URL before believing it. A message whose URL is not
   `index.html` is not yours. One agent already nearly reported another's 404 as its own failure.
2. `/favicon.ico` 404s and `The root document of this element is not valid for pointer lock.`
   are known, pre-existing, and not failures — see PORT_NOTES.md. Report them, don't chase them.

Known-noisy verification path: clicking `#startbtn` for real triggers `requestPointerLock()`,
which headless Chrome refuses. Prefer `?demo`, which skips it.

If playwright is unavailable to you, say so explicitly rather than skipping verification silently.

## Existing interfaces (facts — verified, do not guess)

```js
// js/fx.js
export function noise2(x, y)                      // legacy: fixed field, seed 1337
export function fbm(x, y, oct=4)                   // legacy: gain .5, lac 2.03, unnormalized
export function paintTexture(base, spots, opts={})
export function gradientMap()
export function toonMat(params={})                 // {color, emissive, emissiveIntensity, rim, ...}
export function addOutline(mesh, thickness=0.03)
export class ParticlePool                          // .spawn(x,y,z,opts) .burst(vec3,n,opts)
export function blobTexture()
export function makeBlobShadow(scale=1)

// js/world.js
export const WORLD_SIZE = 420                      // playable radius is ~195, clamped in entities
export const THEMES = [...]                        // 4 curated palettes
export function baseTerrainHeight(x, z)            // terrain WITHOUT the ravine carve
export function groundHeight(x, z)                 // baseTerrainHeight - ravineDepth. HOT PATH.
export function buildWorld(scene, quality=1, seed=1) -> world
//   world = { updaters:[fn(dt,t)], seed, theme, harvestables:[], harvestMushroom(entry) }

// js/rng.js
export function mulberry32(seed) -> fn()
export function deriveSeed(seed, salt) -> uint32    // independent stream per subsystem
export function randomSeed()

// js/entities.js
export const RARITIES, POWERUPS
export class Mushroom { constructor(scene, rarityIdx, pos, zoneMult); hit(); die(); update(dt, game) }
export class Boss extends Mushroom                 // Elder Myconid
export class GluttonBoss extends Mushroom          // Rotmaw
export class Player { update(dt, game); attack(game); hurt(); startDash(game); ... }
export class Powerup

// js/progress.js  — the ONLY thing that touches localStorage (mycelium_* keys)
export class Progress { depth, coins, myco, bank, mutations, contracts,
  advanceDepth(), resetDepth(), harvestFor(id), collect(rarity,n), gearInfo(kind,id,rarity),
  addDupe(kind,id,rarity), levelUpGear(kind,id), gearMultOf(kind,id), buy(id), ... }
export function depthMult(depth), gearMult(stars, level), xpForLevel(level)

// js/main.js — the `game` object passed to every update()
game = { state, player, enemies[], powerups[], boss, particles, audio,
         spawnProjectile, spawnRing, spawnPuddle, kills[], totalKills, rareKills,
         hitStopT, shakeT, shakeAmp, bossSpawned, zone, seed, theme, progress,
         level, xp, dropBonus, rarityJitter[], density, nearestHarvest, spawnEnemy }
```

## New interfaces — build EXACTLY these signatures

Cross-file calls are written against these. Deviating breaks another agent's code.

### js/fx.js — seeded noise (item 07, 08)

```js
// NEW. Build an independent noise field from a seeded stream (Fisher-Yates on rng()).
export function makeNoise(rng)            // -> function(x, y) -> ~[-1,1]

// NEW. Normalized fBm over an explicit field. Divides by summed amplitude, so changing
// `oct` does NOT change output amplitude.
export function fbmOf(noiseFn, x, y, oct=4, lac=2.02, gain=0.5)

// KEEP BOTH LEGACY EXPORTS WORKING, unchanged in behaviour and signature.
// world.js still calls noise2()/fbm() at ~7 sites and is being edited by another agent in a
// later wave. Breaking them breaks the boot. Back them with one module-level default field.
export function noise2(x, y)
export function fbm(x, y, oct=4)
```

### js/fx.js — shared primitives (items 19, 20, 36, 54, 56)

```js
// item 19 — pooled coin//reward pop. Pool owned by fx, parented to a caller-supplied group.
export class RewardPops {
  constructor(scene, opts={})            // opts.geo / opts.mat optional overrides
  pop(x, y, z, n=1)                      // upward vel, gravity, spin, shrink last .3s
  update(dt)
}

// item 20 — one puff primitive. Cap 44, reuse dead, then steal oldest.
// NOTE: ParticlePool already exists and is used everywhere. EXTEND it, do not replace it.
// Add: pool cap + oldest-steal fallback, and a single spawn signature that carries
// colour/size/life/rise so one call covers sparks, steam, frost, trails, embers.

// item 36 — billboarded world-space progress bar
export function makeProgressBar(opts={})  // -> { group, set(progress01, tintHex), dispose() }
//   two planes; fill geometry pre-translated so plain scale.x grows from the left edge;
//   depthTest:false + explicit renderOrder; caller does group.quaternion.copy(camera.quaternion)

// item 54 — frame-claim pool for transient visuals
export class FrameMarks {
  constructor(scene, makeMesh)           // makeMesh() -> THREE.Mesh, called only when short
  begin()                                // reset claim counter
  mark(x, y, z, progress01)               // claim next, position it
  end()                                  // hide everything from the claim index onward
}
//   INVARIANT: begin() must run on every active frame regardless of which
//   ability/element is equipped, or swapping mid-hold strands a stale mark. The
//   not-active early-return still calls begin() then end(), so releasing clears the visuals.

// item 56 — anchor generated geometry at its own base
export function anchorToBase(geo)         // -> { geo, height }
//   computeBoundingBox() then translate(0, -bb.min.y, 0). Returns true height so ONE number
//   drives collider top, billboard height and any contents' position. This is why a shrinking
//   prop sinks like it should instead of contracting toward a floating midpoint.
```

### js/world.js — collision + placement (items 01, 09, 28, 57)

```js
// item 01. One flat array of upright cylinders. Rebuilt by buildWorld().
export const COLLIDERS = []               // [{ x, z, r, bot, top, off? }]
//   INVARIANT: a collider is pushed by the SAME loop that builds its visual mesh, so
//   geometry and collision cannot drift apart.
//   `off = true` retires one when its owner is destroyed — never splice during iteration.

// item 01. THE movement query. HOT PATH — no allocations.
export function surfaceAt(x, z, fromY)    // -> { h, blocked }
//   h       = highest thing you could stand on at (x,z) given feet at fromY
//   blocked = that column is a wall from where you are now
//   Skips c.off. Uses STEP for the climb threshold and PLAYER_R*0.55 for the radius pad.

export function groundOnly(x, z)          // -> surfaceAt(x, z, 1e6).h  (camera//projectiles)

// item 57. Local steepness, central-difference. INDEPENDENT of the STEP collider check:
// a cylinder tells you about walls, a gradient tells you about hillsides.
export function slopeAt(x, z)             // -> |grad h| , epsilon 1.1

// item 28. Exclusion zones, caller picks its own clearance.
export function inExclusion(x, z, pad=2)  // -> bool  (ravine, pockets, authored sites)

// item 09. Rejection sampling with spacing + guard counter.
export function scatter(rng, count, minDist, test)   // -> [{x, z}]
//   test(x,z) -> bool. Predicates MUST query the finished world: height, slope,
//   inExclusion(), and COLLIDERS — not just the noise. That is what stops props
//   spawning inside rocks.

export function findSpawnPoint(seed)      // -> {x, z, h}  deterministic per seed,
//   flat + clear + not in exclusion, hardcoded fallback after ~900 misses.
```

### js/world.js — params (item 32) and staged build (item 31)

```js
export const PARAMS = { ... }             // every generation knob, flat, one object.
//   World is a pure function of (seed, PARAMS). Generation reads ONLY from here.
//   Item 10's dev panel writes into it. Keep keys short and grouped by comment.

// item 31 — terrain build separated from prop build, resolution as an argument
export function buildTerrain(scene, seed, res)   // heightfield + mesh only
export function buildProps(scene, seed)          // props, landmarks, colliders
// buildWorld() keeps its current signature and calls both, so main.js is unaffected.
```

### js/entities.js — movement constants (items 02, 03, 04)

```js
// Export these so world.js placement and the dev panel can read them. Item 52: a movement
// constant is a level-design constraint — say so in the comment when it is one.
export const STEP = 1.5          // auto-climb ledge height
export const PLAYER_R = 0.85
export const PLAYER_H = 2.55
export const COYOTE = 0.13       // grace after leaving ground
export const JUMP_BUF = 0.16     // remembered jump input before landing
export const SNAP_DOWN = 0.55    // downslope stick distance
```

### js/progress.js — currency interlock (item 15)

```js
// The conversion edge. A common activity must convert into ACCESS to a rare one.
// Comment must name why the rate exists, in the style of "boxes are where lockpicks come
// from, so chests always stay reachable."
// Add to Progress: the new resource, its localStorage key under the mycelium_* prefix,
// its save method, and spend/grant methods. Nothing outside progress.js touches localStorage.
```

## Naming, for consistency across agents

Island terms map to ours. Use OUR names in code and UI copy:

| island | ours |
|---|---|
| money box / crate | **spore pod** — jump into it from below |
| goomba | **critter** (fauna, harvested by landing on them — NOT an enemy) |
| warp pipe | **vent** |
| chest + lockpick | **sealed cyst** + **pry-spine** |
| fire / ice ring | **spore burst** / **growth charge** |
| ice block / lava | **corruption crust** / **rot bloom** |
| cash | existing currencies: essence, coins, Mycelium |

## Wave schedule (why you can't touch other files)

| wave | agent | owns |
|---|---|---|
| 1 | fx | `js/fx.js` |
| 1 | ui | `index.html`, `js/audio.js` |
| 1 | econ | `js/progress.js` |
| 2 | world-core | `js/world.js` |
| 3 | world-gen | `js/world.js`, new `js/rockgen.js` |
| 3 | entities | `js/entities.js` |
| 3 | main-ui | `js/main.js` |
| 4 | world-props | `js/world.js` |
| 4 | devpanel | new `js/devPanel.js` |
| 5 | main-wire | `js/main.js` |
