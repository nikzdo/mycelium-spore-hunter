# Port notes — cross-file requests

Append-only. One bullet each: what you need, in which file you do NOT own, and why.


- **fx → world.js (item 41, colour audit).** `THEMES[*].grassBase` / `grassTip` are raw 0-1 triples pushed straight into `THREE.Vector3` shader uniforms (world.js:627-630) and are never linearized, but the values are clearly authored as sRGB (0.30,0.55,0.20). Under ACES + exposure 1.28 they render darker and flatter than intended, and the grass shader's base→tip mix happens between sRGB-encoded numbers, which is exactly the muddy-blend case. Fix: `srgbTriple(r,g,b)` (new in fx.js) and feed the resulting `Color` to the uniform.
- **fx → world.js (item 41).** `canColor.setHSL(...)` (world.js:315) and `bushBase/tint(...).offsetHSL(...)` (world.js:190, 253, 489) run in the *working* (linear) space in r160 — `setHSL`/`getHSL` default to `ColorManagement.workingColorSpace`, not sRGB. So an authored lightness of 0.42 renders as ~0.68 sRGB (canopies read washed out) and hue offsets rotate non-perceptually. Fix: pass `THREE.SRGBColorSpace` as the 4th arg to `setHSL`, and do HSL offsets before conversion.
- **fx → main.js (item 20).** `ParticlePool` now takes an optional 3rd arg `{cap}` (live-particle ceiling, default = `max`, so `new ParticlePool(scene, 700)` is unchanged) plus `PUFF_CAP = 44` and a new `puff(x,y,z,{color,size,life,rise,spread,grav,drag,alpha,n})`. I deliberately did NOT make 44 the default: main.js fires 40- and 60-particle bursts (main.js:126, 1024) that a 44 cap would visibly clip. If we want the island's budget, either pass `{cap: PUFF_CAP}` on a second puff-only pool or shrink those bursts first.
- **ui → main.js (item 44, count-up easing).** CSS half is done: `font-variant-numeric:tabular-nums` now covers `#kills #coinhud #mycohud #lvlbadge #xplabel #fps #bossname .cprog .tstat .glvl .buff .n .gearslot .gt .hotslot .htier .potslot .pcnt .potslot .ptimer .essrow .cnt`, plus a `.num` utility class for any new readout. The easing itself is JS: `#coinhud` / `#mycohud` / `#kills` counts (main.js:541-545) and `#xplabel` (main.js:530) still snap. Lerp the *displayed* number toward the real one in the HUD update (diff-based — only write textContent when the rounded value actually changes, per perf rule 4).
- **ui → main.js (item 45a, zero-state).** New `.zero` class greys a counter out when its value is 0 (works on `#coinhud` / `#mycohud` as a whole-element class since both are set via `textContent`, and on `.potslot` / `.buff` / `.gearslot`). main.js must toggle it: `el.classList.toggle('zero', value === 0)` in `updateHud()` for `#coinhud`/`#mycohud`/kills rows, and in `updateBackpack()` add `' zero'` to the `.potslot` className when `count === 0` (currently only `has`/`active` are set, main.js:459).
- **ui → main.js (item 45b, HUD stats as controls).** CSS now styles hover/active/`:focus-visible` for `[data-weapon]`, `[data-potion]` and `[data-gear]`, and re-arms `pointer-events` for them (`#hud` is `pointer-events:none`). main.js should, in `updateBackpack()`/`updateGearHud()`: set `d.dataset.weapon = String(i+1)` and `d.dataset.weaponId = id` on each `.hotslot` (keys 1-7); `d.dataset.potion = def.id` (`power|haste|swift|vitality|fortify`) and `d.dataset.potionKey = def.key` (Q/E/R/F/G) on each `.potslot`; `d.dataset.gear = slot` on each `.gearslot`. Also `d.tabIndex = 0` + Enter/Space handling so the loadout is keyboard-reachable, and add `sel` to the className of the currently equipped weapon / active potion (`.sel` is the selection ring; it coexists with the existing `.active`/`.on`, so either name can drive it, but `.sel` is the one the new focus/hover states are written against).
- **ui → main.js (item 48, announce variants).** `#announce` now takes one of `good` / `bad` / `cool` alongside `show`. Suggested mapping for `announce(txt)` (main.js:147) — give it a second arg `kind`: `good` for contract complete, level-up follow-up, potion/gear pickups, "Hunt the Bloom!"; `bad` for boss awakens, corruption/death-adjacent warnings; `cool` for rare/legendary finds and star-ups (main.js:375/398). `el.className = 'show' + (kind ? ' ' + kind : '')` right where `show` is added is enough — the classes are additive and mutually exclusive by convention. Keep `#harvestPrompt` out of this; it is the contextual prompt, not an announcement.
- **ui → main.js (item 50, boot overlay).** New `#boot` overlay (markup + CSS in index.html) is invisible until it gets the class `on`. main.js should `document.getElementById('boot').classList.add('on')` immediately before `buildWorld()` (yield a frame first, e.g. `requestAnimationFrame`, or the overlay never paints before the stall) and `.classList.remove('on')` after the first `renderer.render()` completes — it then fades out over .5s and returns to `visibility:hidden` on its own, so no `hidden` class juggling is needed. Optional: `#bootnote` textContent can be swapped for the current stage ("terrain", "props"). Do NOT show it on the title screen; it is for the generation stall only.
- **econ → main.js (item 15/11, spore pods).** When a pod bursts (jumped into from below), call `progress.spineRoll('pod')` → `{got, forced, chance, dry, spines, label}`. It grants the pry-spine itself and owns the pity rule, so main.js must NOT roll its own chance. Announce on `got` ("🦴 Pry-spine!"); `forced` means the pity fired. Pods should also keep dropping coins/essence from the existing drop table — the spine is the *extra*, not the payout.
- **econ → main.js (item 15/14, sealed cysts).** Prompt line: `progress.cystPrompt(tierId, state)` returns a ready string ("🥚 Pry the crusted cyst — 45% per spine (3 held)"). Numbers for a custom widget: `progress.cystInfo(tierId, state)` → `{id,name,icon,chance,pct,expectedSpines,maxTries,tries,triesLeft,coins,myco,gearChance,spines,canPry}`. The interact key calls `progress.pryCyst(tierId, state)` → `{ok,opened,forced,pct,coins,myco,gear,tries,triesLeft,spines}` (or `{ok:false, reason:'no-spines'}`). It spends the spine and banks coins/Mycelium itself. **`gear:true` is a request to main.js to roll exactly one gear drop from its existing powerup drop table and run it through `applyPowerup()`** — that is the cyst→duplicates→stars edge and it deliberately stays in main.js so cysts pay from the same table as everything else. Tier ids: `crusted` / `ironbound` / `elder` (exported as `CYST_TIERS` / `CYST_BY_ID`).
- **econ → world.js (item 15, cyst props).** A sealed cyst prop needs two things on its entry object: a tier id from `CYST_TIERS` (`crusted` common, `ironbound` uncommon, `elder` one per world at most) and a mutable `state = { tries: 0 }` that `pryCyst()` increments. `state` is intentionally per-run and NOT persisted — attempt history dies with the world, and progress.js never writes it to localStorage.
- **econ → main.js (item 12, critters).** Landing on a critter calls `progress.stompCritter(chain)` → `{coins, spine, spines, coinsTotal}` where `chain` is the current un-broken stomp count (0-based). It banks the coins (2 + chain*2, capped 12) and rolls the critter spine chance (12%) itself. A stomp never pays nothing, so the HUD can always show something.
- **econ → main.js (item 30, floor guarantee).** Call `progress.ensureSpineFloor()` once when a hunt starts → `{granted, spines}`. It grants one pry-spine only when the player has 0 spines AND less than `SPINE_MYCO_COST` (12) Mycelium, so it can't be farmed by restarting. Without this call, a player who spent everything can start a hunt with no way into any cyst.
- **econ → main.js + index.html (item 15, HUD + Tome).** (a) HUD needs a pry-spine counter next to `#coinhud`/`#mycohud` — suggest `<span id="spinehud">` fed with `'🦴 ' + progress.spines` in the same diff-based `updateHUD()`. (b) Spore Tome needs the Mycelium sink: `progress.spineExchange()` → `{cost, myco, spines, max, affordable}` and `progress.buySpine(n=1)` → bool. Mycelium currently has one source and zero sinks; this is the only edge out of it.
- **econ → main.js (item 04, publish the star rate).** `gearInfo(kind, id, rarity)` keeps every existing key and adds `dupesPer` (duplicates per star at this rarity), `dupesLeft`, `dupeProgress01`, `dupesToMax`, `starLadder` (cost of all 6 stars), `perStar` 0.12, `perLevel` 0.01, `nextStarMult`, `nextLevelMult`. The Tome/Backpack cards should show "2 more dupes → ★3 (×1.45)" instead of an unlabelled bar. `starLadder(rarity)` is also exported standalone for a rarity-comparison row.
- **audio → main.js (item 49, reward arpeggios).** Every existing method keeps its name/arity, so nothing breaks, but the reward shape is now available per-moment instead of everything routing through `pickup()`/`click()`/`mutate()`. New methods, safe to call blind (no-op without a ctx): `powerup()` (392/523/659/880 run — use in `applyPowerup` for stat/potion powerups instead of the generic `pickup()`), `unlock()` (523/659/784/1046 + shimmer — first-time weapon/armor unlock, main.js:366 area), `gearUp(stars)` (star-up/level-up run — replaces the bare `audio.click()` at main.js:690, 754, 821, where a star-up currently reads as a UI click), `contract()` (harvest-contract completion — replaces `audio.mutate()` at main.js:237 so alchemy purchases and contract payouts stop sharing a cue), `warp()` (up-slide whoosh for vent travel) and `telegraph(big)` (rising slide for boss wind-ups, pairs with `bossSpawn()`).
- **integrator → main.js (verification hazard, pre-existing).** `startRun()` calls
  `renderer.domElement.requestPointerLock()` (main.js:934, guarded by `!DEMO`). In headless Chrome
  this throws `The root document of this element is not valid for pointer lock.` It is NOT a
  regression and not user-visible, but it means "click start in headless" is a noisy verification
  path — prefer `?demo` (which skips it) and treat that one message as known. Worth wrapping in a
  try/catch anyway, since a browser refusing pointer lock should never surface as an error.
- **integrator → whoever owns item 42.** `rerollWorld()` (main.js:21) sets `location.search`, i.e.
  a full page reload, and `buildWorld()` is called exactly once per load. So there is no in-session
  teardown today and disposal flags buy nothing yet. They become mandatory the moment item 31's
  build split + item 10's live rebuild exist, because the panel rebuilds the world many times per
  session. Implement 42 together with 31/10, not standalone.
- **rockgen → world.js (items 34, 55).** New self-contained `js/rockgen.js` (owned by rockgen, nothing else touched). API: `polyRing(rng, sides, wobble)`, `makeStack(rng, opts, collidersOut) -> BufferGeometry`, `placeGeo(geo, x, y, z, rotY, tiltX, tiltZ)`, `mergeGeos(list) -> BufferGeometry` (disposes inputs), `mergeStacks(list) -> {geo, hull}`, `jitterLattice(rng, spec) -> [{x,z,r,h,sides,tiers,rotY,tiltX,tiltZ,edge}]`, plus `PRESETS` (`boulder|spire|tower|crystal|ridge`) and `ROCK_PAL`. To consume: build stacks with placement in `opts` (`x,y,z,rotY,tiltX,tiltZ`, `hull:0.06`), passing `COLLIDERS` as the 3rd arg — `makeStack` **pushes one `{x,z,r,bot,top}` per tier from the same loop that writes that tier's vertices, transformed by the same matrix**, so nothing else needs to compute collider positions (item 01 holds by construction). Tiers whose mean radius is under `minColliderR` (0.55) are skipped: PLAYER_R 0.85 / STEP 1.5 means a smaller lump is stepped over, and walling it would just feel sticky. Then `const {geo, hull} = mergeStacks(geos)` → `new THREE.Mesh(geo, toonMat({vertexColors:true, rim:0.3}))` plus `new THREE.Mesh(hull, hullMat)` (world.js's existing BackSide `hullMat` is exactly right). **Do NOT call `addOutline()` on the merged mesh** — it scales about the mesh origin, which for merged world-space geometry pushes every rock away from the world origin instead of thickening it; that is why the shell is baked per rock and merged separately. Measured on a 133-rock harness: 2 draw calls, 7801 fill tris + 7801 ink tris, 146 colliders, 8.8 ms total generation (0.066 ms/rock). This *replaces* the rock `InstancedMesh` pattern for varied rocks (one instanced silhouette can't give per-rock tiers/sides/taper); the ambient 70-rock scatter can stay instanced if you prefer, the two coexist fine.
- **world-core → main.js (item 09, player spawn).** `buildWorld()` now returns `world.spawnPoint = {x, z, h}` (from the new `findSpawnPoint(seed)`): deterministic per seed, flat, clear of every collider, outside every exclusion, with a hardcoded origin fallback after ~900 misses. `resetRun()` currently drops the player near the origin regardless of what generated there — use `world.spawnPoint` (`player.group.position.set(sp.x, sp.h, sp.z)`) instead. Also worth pointing the title/`?demo` camera at it.
- **world-core → entities.js + main.js (item 01, collision).** `js/world.js` now exports `COLLIDERS` (`{x,z,r,bot,top,off?}`, 200-ish per world: tree trunks, rock formations, cave walls, standing stones, the mother-mushroom tower, the rune boulder, crystal clusters, withered spikes, and the bridge deck as a *standable* column), plus `surfaceAt(x,z,fromY) -> {h,blocked}`, `groundOnly(x,z)`, `slopeAt(x,z)`, `inExclusion(x,z,pad,skipTag)`, `scatter(rng,count,minDist,test,area)`, `findSpawnPoint(seed)`. Nothing consumes them yet: `Player.update` / `Mushroom.update` / the camera clamp still call `groundHeight()`, so props remain walk-through until wave 3 swaps in `surfaceAt` (movement, honouring `blocked`) and `groundOnly` (camera at main.js:1082, projectile ground test at main.js:1200). **`surfaceAt` returns a shared module-level object** — read `.h`/`.blocked` immediately, never store the reference; that is deliberate, it is called per entity per frame and must not allocate. Measured 0.66 µs/query with 215 colliders (20k queries in 13.2 ms), so a linear scan is fine; no spatial index.
- **world-core → entities.js (items 02-04).** `world.js` currently declares its own `STEP = 1.5`, `PLAYER_R = 0.85`, `PLAYER_H = 2.55` at module scope because `surfaceAt` needs them and entities.js imports world.js — importing back would put them in TDZ during module init. When entities.js exports them, either leave world.js's copies as the source of truth and have entities import them from world.js, or keep both and *keep the numbers identical*: `STEP` doubles as the collider-registration threshold (a prop shorter than STEP deliberately gets no collider), so changing it in one file only would silently create invisible walls.
- **world-core → main.js (item 32, dev panel prerequisite).** All generation knobs are now in `export const PARAMS` (147 keys, flat, grouped by comment) — counts, radii, densities, landmark/pocket probabilities, ravine ranges, scatter/exclusion/spawn clearances. Pure extraction, no value changed (verified: seed 42's terrain hash and all 19 instanced-mesh matrix hashes are bit-identical). Terrain *height* coefficients are deliberately still inside `baseTerrainHeight()` — the terrain-shaping wave owns those; PARAMS is the right home for them afterwards if that wave wants it.
- **world-core → main.js (item 35, instanced harvestables — API preserved).** Decorative mushrooms are now `InstancedMesh` (1 stem draw + 1 cap draw per species = 5 total, was 2 meshes per mushroom → 196 draw calls on seed 42, 270 on seed 3). `world.harvestables`, `world.harvestMushroom(entry)`, `entry.species/alive/respawnT/baseScale` are unchanged, and `entry.g` is a `DecoHandle` façade: a real `THREE.Vector3` `position` (so `.clone()` still works) plus a `visible` getter/setter whose setter writes the instance matrix at scale 0. main.js needs **no change**. If a later wave wants to move a mushroom, it must call the world's writer, not just mutate `entry.g.position` — the façade's position is the source of truth but only re-uploads on a `visible` write or the sway tick.
- **main-ui → world.js (item 06, sun shadow rig).** main.js now owns the renderer side: `renderer.shadowMap.enabled` + `PCFSoftShadowMap`, a quality tier (`?shadows=off|low|med|high`, else derived from `?q`: 512/1024/2048), a per-frame retarget of the sun onto the player, and a one-time `shadowize(root)` opt-in pass that walks the scene and sets `castShadow`/`receiveShadow` on opaque meshes (skipping additive/transparent shells, `BackSide` ink shells, `ShaderMaterial` — vertex-animated grass would cast from its un-swayed pose — and anything with a bounding radius > 320, i.e. the sky dome and cloud shell). It is idempotent and runs on spawn, never per frame, so **world.js setting its own flags costs nothing and is still welcome**. Two things worth doing in world.js: (a) expose `world.sun` (the `DirectionalLight`) — main.js currently finds it by scanning `scene.children` for `isDirectionalLight`, which works but is a guess; (b) if you configure `sun.shadow` yourself (2048 / ±120 ortho / bias -0.0007 / normalBias 0.4), main.js detects that (`camera.right > 5`) and leaves your box alone, only forcing `mapSize` for the quality tier. **Also note main.js re-places `sun.position` every frame**: the day-cycle updater sets it from the origin, so main.js reads that direction and re-places the light relative to the player (retargeting alone skews the light by however far the player has walked from origin). If world.js starts positioning the sun relative to the player itself, drop the main.js re-place.
- **main-ui → world.js/entities.js (item 47, hover tags).** `game.hoverTags.register(root, label, opts) -> unregisterFn` is live in main.js. `label(root)` returns the chip text or null/'' for "nothing to say right now"; `opts.range` (default 22, world units from the player) and `opts.lift` (default 1.6, metres above `root.position` the chip anchors). The raycast runs at ~14 Hz against registered roots only, from the pointer or from screen centre when pointer-locked, and entries whose `root.parent` is null are pruned automatically — **a prop that despawns with `scene.remove()` never has to unregister**. Enemies and every ground drop are registered already. Pods/cysts/vents should register with copy that names the verb, not the noun ("🥚 Sealed cyst — [E] pry with a spine (3 held)"), and `progress.cystPrompt()` already returns exactly that string. Note the anchor is `root.position`, so an `InstancedMesh`-backed prop needs a real `Object3D` per instance to be taggable.
- **main-ui → index.html (item 47, chip styling).** The chip is created from JS as `#hovertag` with inline styles (position:fixed, translate(-50%,-100%), cream on rgba(20,12,26,.72), 2px border) because index.html was finished before this item landed. If index.html is ever reopened, moving that into a `#hovertag` CSS rule would let it inherit the `.dmg`/`#harvestPrompt` language properly; main.js only sets `left`/`top`/`display`/`textContent`, so a CSS rule can own everything else.
- **main-ui → entities.js (item 48, announce kinds).** `announce(txt, kind)` now takes `''|'good'|'bad'|'cool'`. The three `game.announce()` calls in entities.js (Elder summons brood, Rotmaw inhales, Rotmaw burps brood) still pass one argument, so they render neutral. All three want `'bad'`, and the copy pass wants them to name the counterplay rather than the event — e.g. "Rotmaw inhales — get behind it before the cone lands". Same treatment for any new telegraph.
- **main-ui → wave 5 (main.js, deliberately NOT done here).** (a) `resetRun()` still drops the player near the origin; `world.spawnPoint` is available and wanted, but that is movement/gameplay wiring, not camera/HUD. (b) The projectile ground test at the bottom of `tick()` still uses `groundHeight()`, not `groundOnly()` — only the camera was switched this wave. (c) `progress.spineRoll/cystPrompt/pryCyst/stompCritter/ensureSpineFloor` and `audio.warp()` have no call sites yet because pods/cysts/vents/critters do not exist yet. (d) `makeProgressBar` is unused: the boss bar is already a diff-based DOM bar that reads at any range, and there is no channelled ability to bar yet — the first honest call site is a cyst pry or a boss channel.
- **main-ui → whoever owns perf (item 06 cost).** With shadows at 2048 the shadow pass roughly doubles draw calls for the ~265 opted-in meshes. `renderer.info.programs` was verified stable (84) across ~150 frames, so there are no per-frame recompiles, but if a low-end tier is ever needed beyond `?shadows=low`, the cheapest next step is to stop `shadowize()`ing the terrain mesh (it is the one caster whose contribution is subtle) rather than dropping the map size again.
- **entities → main.js (item 03, jump is now a request not an event).** `tryJump()` (main.js:885) should become `p.bufferJump()` and nothing else. `bufferJump()` remembers the press for `JUMP_BUF` (0.16s) and fires it the moment the feet land, and it accepts a press up to `COYOTE` (0.13s) after walking off a ledge as a *ground* jump (no air jump spent). It returns true only when the jump left the ground **this frame**, so the cue must not hang off the return value — set `p.onJump = (p)=>{ audio.jump(); particles.burst(p.group.position.clone(), 6, {...}); }` once in `resetRun()` and Player fires it whenever a jump actually happens, immediate or buffered. Do NOT keep writing `p.vy = 11; p.jumps++` from main.js: it bypasses the buffer and the launch stretch. The legacy path still works untouched (coyote is implemented by spending the ground jump when the window lapses, so even the old `if(p.jumps < p.getMaxJumps())` check gets correct coyote behaviour) — but buffering only exists through `bufferJump()`.
- **entities → main.js + world.js (item 11, spore pod registration).** `entities.js` exports `HEAD_HITS` (array), `registerHeadHit(entry)` and `clearHeadHits()`. An entry is `{x, z, bot, r, off?, onHead(player, game)}` where `bot` is the world-Y of the pod's **underside** — the plane the crown crosses — and `r` its horizontal radius. Player.update runs a genuine crossing test (`prevHead <= bot && headY >= bot` while `vy > 0`, plus a radius check), then clamps the player to `bot - PLAYER_H - 0.01`, sets `vy = -2`, stretches the squash to 1.28 and calls `onHead`. Empty registry = one `length` check per frame, so it is a no-op until pods exist. Whoever places pods owns lifetime: set `off = true` when one bursts (never splice), and call `clearHeadHits()` wherever the world is rebuilt/`resetRun()` runs, or last run's pods stay bonkable. The `onHead` callback is the place to call `progress.spineRoll('pod')` + the drop table (see the econ bullet above); entities.js deliberately knows nothing about rewards.
- **entities → main.js (items 01/02, the last two `groundHeight` consumers).** `Player.update` and `Mushroom.update` now resolve movement through `surfaceAt()` and honour `blocked`, so props are solid and prop tops are standable. Two call sites in main.js still read raw terrain and should move to `groundOnly(x, z)`: the camera's keep-above-terrain clamp (`groundHeight(desired.x, desired.z) + 0.7`) and the projectile ground test (`gp.y < groundHeight(gp.x,gp.z)+0.2`) — otherwise the camera clips through rock formations the player is standing behind, and projectiles fly through the mother-mushroom tower. Also: the enemy-separation pass writes `ap.x/ap.z` directly, which is the one movement path that bypasses `Mushroom.tryDir()` and can shove a creature into a prop; it self-heals (a creature that finds itself inside a column is allowed to walk out — that escape valve is deliberate), but if you want it exact, feed the push through `a.slideStep(dx, dz, a.baseY, false)`.
- **entities → world.js (items 02-04, constants are now exported and MUST stay in sync).** `entities.js` exports `STEP = 1.5`, `PLAYER_R = 0.85`, `PLAYER_H = 2.55`, `COYOTE = 0.13`, `JUMP_BUF = 0.16`, `SNAP_DOWN = 0.55`. I deliberately did NOT make world.js import them (that is the TDZ cycle world-core warned about) — world.js keeps its own copies and the numbers are identical today. `STEP` is load-bearing in both files at once: it is the player's auto-climb height AND the collider-registration threshold in world.js, so if a later wave tunes it, tune both or short props become invisible walls. A dev panel should write both or neither.
- **entities → js/audio.js (item 04, landing thump).** The hard-landing cue (`vy < -14`) is currently synthesized inline as `audio.beep(96, 0.13, 'sine', 0.17, 52)` + `audio.hiss(0.09, 0.1, 180, 900)` because there is no landing sound. `Player.land()` already prefers `audio.land()` when it exists, so adding a real `land()` to audio.js is a drop-in upgrade — a low thud with a dust-scuff tail, quieter than `hurt()`.
- **entities → main.js (item 09/57, spawn points must be clear of colliders).** `spawnEnemy`/`spawnWave` place enemies from a bare angle+distance roll, and `resetRun` still drops the player near the origin. Both can now land *inside* a collider column. Player and creatures each carry an escape valve (already inside a column ⇒ collision is ignored until they step out), so this is never a soft-lock, but it looks like a creature walking out of a rock. Use `world.spawnPoint` for the player, and reject an enemy spawn where `surfaceAt(x, z, groundOnly(x,z)).blocked` or `slopeAt(x,z) > 0.85` (that 0.85 is `MOB_SLOPE_MAX` in entities.js — a creature spawned on a wall face refuses every heading until it has walked off it).
- **world-terrain → main.js (item 06, the shadow rig).** `buildWorld()` now returns `world.sun`: a `DirectionalLight` with `castShadow=true`, `shadow.mapSize` 2048 scaled by the `quality` argument (floor 512), an ortho box of ±120 (`near` 1, `far` 420), `bias -0.0007`, `normalBias 0.4`, and **`sun` and `sun.target` are both already added to the scene** — do not add them again. main.js must (a) set `renderer.shadowMap.enabled = true` and a type (`PCFSoftShadowMap` matches what the rig was tuned against) **before the first render**, and (b) each frame do `world.sun.target.position.copy(player.group.position)`. The day-cycle updater places the light *relative to its target* (`sun.position = target + dir*111`), so a target left at the origin drags the ±120 shadow box off the player as soon as they walk away from spawn. Terrain is `receiveShadow`; trees/rocks/bushes/logs/stones/spikes/crystals/tower/bridge cast; the ink-outline hulls and the 22k-blade grass deliberately do not. Verified: `renderer.info.programs` goes 27→33 on frame 1 (initial depth-material compile) then is flat for every frame after — no per-frame recompiles.
- **world-terrain → main.js (item 43, fog/background/sky reconciled).** world.js now owns one horizon colour: `world.fogColor` (a `THREE.Color`) is used for `scene.fog`, is cloned into `scene.background`, and is fed to the sky dome's new `uFog` uniform so the dome's lowest band mixes into exactly that colour. So distant terrain, the sky behind it and the background can no longer disagree per theme. main.js:37's hardcoded `scene.background = new THREE.Color(0xe8b07a)` is now only the pre-`buildWorld` placeholder (world.js overwrites it) — harmless, but if item 50's boot overlay wants the right colour during the generation stall it should use `THEMES` or just leave the placeholder warm.
- **world-terrain → whoever owns item 18 (guaranteed reward).** `world.sites` is the hook: an array of 1-2 authored terrain set-pieces, `{x, z, r, base, coreH, bowlD, rimH}`, carved into the heightfield itself (item 26) — a rimmed bowl with a flat raised plinth in the middle. **Put the reward on the plinth: `(s.x, s.base + s.coreH, s.z)`, flat out to `r * PARAMS.siteCoreR` (0.16·r ≈ 3 m).** Sites are rolled through the same rejection sampler as every other landmark, so they are already clear of the ravine, the bridge, the caves, the pockets and the spawn basin, and they push an `EXCLUSIONS` entry tagged `'site'` — pass `inExclusion(x, z, pad, 'site')` if your own props belong *inside* a site (note: one shared tag, so that opts out of every site's zone at once). `world.shape` carries this world's rolled silhouette dials if you need the local grade.
- **world-terrain → main.js/devPanel (items 31, 42, dev-panel prerequisites).** `buildWorld(scene, quality, seed)` is unchanged and now just calls `buildTerrain(scene, seed, res=PARAMS.terrainSegs, quality=1)` then `buildProps(scene, seed, world)`. `buildTerrain` owns the layout roll (theme, ravine, pockets, landmark set, authored sites), fog/sky/lights and the mesh; `buildProps` needs `buildTerrain` to have run first and defaults its `world` argument to the last-built one, so the contract's 2-arg signature works. The two use **separate rng streams**, so re-running terrain at a new `res` cannot shuffle the props. `world.dispose()` exists (item 42) and removes only what world.js added: ownership is decided by a use-count pass (`userData.ownGeo`/`ownMat` set only where a geometry/material is used by exactly ONE of our meshes), shared resources are left alone, and `COLLIDERS`/`EXCLUSIONS`/`world.updaters` are truncated in place. `world.disposeStats` reports `{roots, owned, shared}` (195/117/67 on seed 42). Also new/renamed on `world`: `sun`, `fogColor`, `terrain`, `terrainRes`, `sites`, `shape`, `dispose`, `disposeStats`; `edgeCrest(angle)` is exported for a panel readout.
- **world-terrain → entities.js (items 22-24, the world edge is no longer a circle).** The 195-unit player clamp and the 190-unit spawner reject are still correct and still the design constraint, but the boundary they sit inside is now a wobbled curve, not a bowl: `edgeCrest(angle) = PARAMS.edgeRMin + PARAMS.edgeRVar * wobble`, with `edgeRMin = 200` and a **strictly positive** wobble, so the crest is ≥200 in every direction of every world and the "rim wins" override is gated at `edgeLock (0.975) * crest ≥ 195`. **If anyone raises the clamp above 195, raise `PARAMS.edgeRMin` with it or the wall moves inside the playable disc.** Measured over a 2 m grid across the full 195 disc on 10 seeds: 0 non-finite samples, crest min 200.2-207.2, and 0.3-0.7% of cells above a 2.0 gradient (all of them authored site rims or ravine banks, none impassable — the player's vertical resolve snaps to terrain, so terrain is never a wall). Terrain build is 56-104 ms and `groundHeight` is 0.36 µs/call (was 0.08; the extra buys per-world noise fields, domain warp and per-region relief).
- **world-terrain → world-props wave (item 26 + the mesh got bigger).** The terrain mesh is now `PARAMS.terrainSpan` (500) wide, not `WORLD_SIZE` (420), at `terrainSegs` 172. `WORLD_SIZE` is unchanged and is still the box every prop scatter is expressed in — the mesh is deliberately larger so the wobbled rim crest (up to 232) plus its outer skirt fits inside it; a crest outside the mesh shows sky where the ground should be. Don't scatter props past ~195; do use `PARAMS.terrainSpan` if you need the mesh extent. Also **fixed on the way through**: the distant-mountain jitter was `noise2(i, 3+ring)` with *integer* arguments, and a lattice noise is exactly 0 at integer coordinates — every mountain was on a perfect ring with zero jitter. Now sampled at fractional offsets.
- **world-terrain → main.js (verification hazard, for the next agent).** The shared playwright browser is being re-navigated by concurrent agents mid-call: a `browser_tabs select` followed by `browser_evaluate` frequently lands on someone else's page, and a dynamic `import()` of a module the page already loaded can return a *stale* cached copy of it (I read an export list missing three new exports while the page's own copy had them). Two habits that fixed it: (1) start every evaluate with `if(!location.href.includes(':8000')) return {WRONG_TAB: location.href}` and check that field before believing the result, and (2) for anything numeric, run it in **node** instead — `world.js` loads headlessly with a ~20-line 2D-canvas stub (`document.createElement` returning an object whose `getContext` returns a no-op Proxy, and `createLinearGradient`/`createRadialGradient` returning `{addColorStop(){}}`), since three only stores the canvas as a texture image. That harness builds a full world in ~60 ms and made the 10-seed sweep possible at all.
- **fauna → main.js (item 12, critters).** New file `js/fauna.js`, owns nothing else. `buildFauna(scene, rng, world, opts={})` → handle `{ critters[], species, group, update(dt,t,playerPos,playerVy), tryStomp(playerPos,playerVy), resetChain(), chain, hoverTargets(), labelFor(objOrRoot), harvest(critter), dispose() }`. `opts = { parent, progress, particles }` — `progress` is the `Progress` instance (omit it and rewards still compute but nothing is banked, which is how the harness ran); `particles` is `game.particles` for the death puff. Build it AFTER `buildWorld()` so placement sees the finished `COLLIDERS`: `game.fauna = buildFauna(scene, mulberry32(deriveSeed(seed, 0xfa11a)), world, { progress: game.progress, particles: game.particles })`. It never touches localStorage, never registers a collider (you walk through and land on them — an invisible wall around a wandering animal would be miserable) and never damages the player.
- **fauna → main.js (item 12, the per-frame calls).** (a) `game.fauna.update(dt, t, player.group.position, player.vy)` once per frame while `state==='play'` — it wanders, animates and runs its own 20 s respawn clock. (b) Right after `player.update()`, `const s = game.fauna.tryStomp(player.group.position, player.vy)`; on a hit set `player.vy = s.popVy` (14.5) and refresh the air-jump counter (`player.jumps = 0`) so stomps chain. `playerPos.y` must be the player's FEET, which is what `player.group.position.y` already is. (c) Call `game.fauna.resetChain()` on the rising edge of `player.grounded` — landing is what ends a chain; the 1.6 s `FAUNA.chainWindow` is only the fallback for a chain that dies in mid-air. (d) `game.fauna.dispose()` in the same teardown that drops the world.
- **fauna → main.js (item 12, the payout).** `tryStomp()` returns `{ critter, species, reward, chain, popVy }` or null. `reward` is `progress.stompCritter(chain)`'s result (`coins`, `spine`, `spines`, `coinsTotal` — coins and the 12 % spine roll are already banked) plus, for main.js to credit: `species`/`name`/`icon`, `chain`, `essence` (number), `myco` (number), `harvest` (`{id, n}` or null — a mushroom species id, credit it exactly the way picking that species credits a harvest contract), `label` (ready to show, e.g. `🪲 Spore Beetle ×3`) and `banked` (false only if no `progress` was passed). Announce `reward.spine` with the same "🦴 Pry-spine!" line the pods use, and fire the existing `RewardPops` at the critter's position — fauna.js deliberately reports instead of touching HUD or audio.
- **fauna → main.js (item 12, species → resource, so the HUD copy can match).** `sporebeetle` 🪲 Spore Beetle, amber (`0xffcf5a`), flat glade r 14-104 → **essence** 2 + chain, cap 6. `cragmite` 🐛 Crag Mite, violet (`0xb47aff`), broken shoulders r 58-150 slope 0.18-0.58 → **harvest-contract credit** for `violet`, 1 + chain, cap 3. `puffdrifter` 🎈 Puff Drifter, azure (`0x6ad0ff`), outer highlands r 110-172, hovers → **Mycelium** 1 + chain/2, cap 3. Every species also pays coins + the shared spine roll through `stompCritter`. Mycelium currently has one source and one sink, so the drifter is deliberately the farthest walk on the map.
- **fauna → main.js (item 12, hover tags).** `hoverTargets()` returns the critter root groups and the array is STABLE for the whole run — a dead critter stays parented and turns invisible, and respawn revives it in place, so register once at build time and never again: `for(const root of game.fauna.hoverTargets()) game.hoverTags.register(root, o=>game.fauna.labelFor(o), { range:20, lift:1.4 })`. `labelFor()` walks up to the critter and returns null while it is dead or dying, which the tag registry already treats as "nothing to say".
- **fauna → devpanel (item 12).** `FAUNA` (popVy, stompBand, stompCeil, chainWindow, respawnEvery, step, minGroundH, edgeR, alts) and `CRITTER_SPECIES` (counts, habitat bands, speeds, maxSlope) are both exported live objects, same convention as `world.PARAMS` — writing into them takes effect on the next frame, except `count`, which the respawn clock picks up on its next tick.
- **props → main.js + world.js (items 11, 13, 14, 18 — new `js/props.js`, nothing else touched).**
  API: `buildProps(scene, rng, world, opts) -> handle` (also exported as `buildInteractiveProps` —
  world.js already has its own `buildProps`, so alias one of them at the import site). Plus
  `PROP_PARAMS` (every knob, flat, for item 10's dev panel) and `HEAD_APEX` (4.567 m, derived from
  the imported `PLAYER_H` — it is what clamps pod height to something a jump can actually reach).
  `opts = { progress, pops, parent, onEvent, grantCoins, quality, podClusters, ventCount,
  cystCrusted, cystIronbound, treasureCount, registerHeadHit }`. Only `progress` really matters;
  everything else has a working default. Handle:
  `{ root, pods[], cysts[], vents[], treasures[], colliders[], events[], treasureSource, anchors,
  update(dt,t,camera,playerPos), nearestCyst(px,pz,py), promptFor(cyst), infoFor(cyst), pry(cyst),
  ventUnderfoot(px,pz,py,grounded), travel(vent), collectTreasure(tr), payPod(pod,game),
  hoverTargets(), labelFor(mesh), propOf(mesh), setHovered(prop|null), headEntries(), dispose() }`.
  Call `update()` once per frame with the camera (it billboards the cyst progress bars) and the
  player position (it does treasure pickup). Every payout/travel/pickup is *reported* through
  `opts.onEvent(ev)` and mirrored into `handle.events` — props never touch the DOM or audio.
  Event kinds: `pod` `{pod, coins, mult, hits, charges, chargesLeft, spent, spine, x,y,z, clampY, vy}`,
  `cyst` `{cyst, tier, result, info, gear}`, `travel` `{from, to, x, y, z, aimAt}`,
  `treasure` `{treasure, coins, left, x,y,z}`. **`ev.gear === true` on a cyst event is the request
  to roll exactly one drop from main.js's powerup table** (progress.js's contract, unchanged).
  `ev.aimAt` on a travel event is a world point to re-aim the camera at on arrival, so you land
  facing something.
- **props → main.js (item 11 wiring, head hits).** Pods register themselves with entities.js's
  `registerHeadHit()` at build time, so the crossing test stays in `Player.headBonk()` and main.js
  needs nothing. Two consequences: (a) call `clearHeadHits()` before any world rebuild, or a dead
  world's pods keep paying; (b) pods bob, so `head.bot` and the pod's collider `bot`/`top` are
  re-synced from the mesh in `update()` — that is deliberate, and it means `props.update()` must run
  before or after movement consistently, not sometimes both.
- **props → main.js (item 13 wiring, vents).** Interact key: `const v = props.ventUnderfoot(px,pz,py,player.grounded); if(v) props.travel(v)`. `travel()` returns
  `{from, to, x, y, z, aimAt}` and does NOT move the player — main.js owns the fade-to-black, the
  teleport and the camera re-aim (pair it with `audio.warp()`). Vents link in a ring, so travel
  always terminates and an odd count still links.
- **props → main.js (item 14 wiring, cysts).** Prompt: `props.promptFor(props.nearestCyst(px,pz,py))`
  returns progress.js's published-odds string ready to render into `#harvestPrompt`. Interact:
  `props.pry(cyst)` — it spends the spine through `progress.pryCyst()`, drives the lid swing and the
  failure shake, and returns the event. Each cyst owns its own `state = {tries:0}`, per-run and never
  persisted, exactly as econ specified.
- **props → main.js (item 18 fallback, authored sites).** Item 18 reads `world.sites` (the field
  world-core already exposes: `{x,z,r,base,coreH,...}`) and picks the HIGHEST one, since
  "hardest to reach" is a real property. It probes `treasureSites` / `authoredSites` / `sites` /
  `setPieces` / `landmarkSites` in that order, then falls back to `world.motherShroom` /
  `world.pondPos` with an 11 m standoff, then to a 400-sample highest-clear-ground search. Whichever
  path fired is on `handle.treasureSource` — on seed 42 it is `world.sites`. If a later wave adds a
  better field, add its name to `siteFields` in props.js and nothing else changes.
- **props → main.js (perf, measured).** 26 props on seed 42 = **79 draw calls, 16.6k triangles**,
  8.3 ms to build, 2.8 µs per `update()` tick for the whole set. Geometry and materials are shared
  per prop type (11 pods share ONE geometry and 12 materials; hover brightening and the
  fresh/cracked/husk states are material *swaps*, not per-pod materials) — the exception is vents,
  which own their geometry because the highlight band is baked in world space after the yaw. Roughly
  a third of the calls are the `addOutline()` ink hulls. If that budget ever matters, the honest fix
  is an `InstancedMesh` per (kind, wear-stage) with pods migrating between them on a state change;
  it is a real bookkeeping change, not a tweak, so it was left out deliberately.
- **props → whoever owns world.js/entities.js (a footgun worth knowing).**
  `BufferGeometry.toNonIndexed()` returns **`this`**, not a copy, when the geometry has no index —
  which is every `PolyhedronGeometry`/`Octahedron`. So `const g = src.toNonIndexed(); g.translate(...)`
  writes straight into `src`, and if `src` is shared between instances every instance bakes its
  transform into the source, compounding. Always `src.index ? src.toNonIndexed() : src.clone()`.
  Same class of bug as disposing a shared geometry, in transform form.
- **props → world.js (import direction, load-bearing).** `js/props.js` imports `world.js` (COLLIDERS,
  groundHeight, groundOnly, slopeAt, inExclusion, scatter), `entities.js` (registerHeadHit, PLAYER_H),
  `fx.js`, `rng.js` and `rockgen.js`. So it must be called **from main.js, after `buildWorld()`** —
  importing it *into* world.js would close the loop world → props → entities → world and put
  world.js's module-scope constants in TDZ during init, which is the same trap world-core already
  documented for STEP/PLAYER_R. Its placement predicates read the FINISHED collider list, so calling
  it after buildWorld is also the only order that makes them correct.

## FINAL OPTIMIZATION PASS — brief (user-requested, run LAST)

Measured numbers gathered during the port. Start from these, re-measure before changing
anything, and report before/after. Do not regress correctness or the art direction to win
draw calls.

**Draw calls — current estimate ~500 in a populated frame.**
| source | measured | note |
|---|---|---|
| scene with shadows | 339 | vs 124 with `?shadows=off` — inherent second depth pass |
| interactive props (26) | 79 | ~1/3 are `addOutline()` ink hulls = the art direction |
| fauna (10 critters) | 70 | **7 draw calls per critter** — worst per-object cost in the game |
| rockgen (133 rocks) | 3 | already excellent, merged fill + ink. The model to copy. |
| harvestables | 5 | was 196 before item 35. Already fixed. |

**Ranked candidates:**
1. **Fauna, 7 calls/critter.** Merge each critter's static sub-meshes; only genuinely animated
   parts need to stay separate. Biggest single win available.
2. **Props, 79 calls.** `InstancedMesh` per (kind, wear-stage) — the props agent deliberately
   skipped this as real index bookkeeping, not a tweak, and it complicates the wear-state
   texture swap. Do it carefully or not at all; do NOT break `HEAD_HITS` registration or the
   bob-tracked `bot` (a stale `bot` fires the pod hit at the wrong height).
3. **Ink hulls.** Merge hulls per prop type the way rockgen does, rather than one hull per mesh.
4. **Shadow casters (291-324).** Cull small casters, tighten the ortho box around the player,
   or lower the default tier. `shadowize()` is already one-time and idempotent.

**Hot path regression worth attention:**
- `groundHeight()` went **0.08us -> 0.36us per call** (4.5x) after the terrain-shaping wave —
  more noise fields, domain warp, authored curve. It has ~41 call sites and runs per entity per
  frame, so this is the most likely CPU cost in the game now. Options: cache per (x,z) at a
  coarse grid, reduce octaves in the per-frame path vs the mesh-build path, or split a cheap
  `groundHeightFast()` for entity queries from the full-quality version used at build time.
- `surfaceAt()` is 0.65us with 216 colliders (linear scan, squared-distance early-out). A
  spatial index was deliberately NOT added — measure again once props/fauna/rockgen have pushed
  the collider count up, and only add one if it now pays.
- World build 56-104ms. Only matters once item 10's live-rebuild panel exists.

**Rules that must survive the pass** (CLAUDE.md): no `PointLight` on anything that spawns in
bursts; no per-frame allocations in hot paths; diff-based DOM; `surfaceAt`'s shared return
object stays read-immediately-never-store; seeded determinism unchanged.
- **palette → world.js (item: generative palettes, new file `js/palette.js`).** `js/palette.js` has
  **zero imports** on purpose: it emits sRGB hex ints, 0-1 sRGB triples and `{h,s,l}` triples only, so
  the sRGB→working conversion stays at the one boundary item 41 established, and it runs under plain
  `node` (that is how the contrast/variety numbers below were measured rather than asserted). Wiring,
  in order:
  1. `import { makePalette, jitterFor, rockSetFor } from './palette.js';`
  2. Delete `export const THEMES = [...]` and replace the pick in `buildTerrain()` —
     `const theme = THEME = THEMES[(rng()*THEMES.length)|0];` becomes
     `const theme = THEME = makePalette(rng);`. **Keep the field named `world.theme`**: main.js reads
     `world.theme.name` in four places (Tome row, pause, game-over, victory) and the palette carries a
     generated `name`, so those keep working untouched. Nothing else about the call site changes —
     `makePalette` is a pure function of the rng stream, consumes it in a fixed order, and every field
     `world.js` reads today (`skyTop/skyMid/skyBot/fog/sun/hemiSky/hemiGround`, `grassBase`/`grassTip`
     as the same 6-number sRGB triples, `terraHue/terraSat/canopyHue/canopySat/canopyBase`) is still
     there with the same name and shape. **A one-line swap gets you the whole system.**
  3. Optional, and this is where the actual variety lands. Each is independent:
     - **terrain strata** — `theme.terra` = `{grass, emerald, dry, moss, rock, clear, path, corrupt}`
       hexes, i.e. exactly the eight `tint(0x…)` constants at the top of the colour pass. Use them
       directly (`const cGrass = new THREE.Color(theme.terra.grass)`) instead of `tint()`. The legacy
       `terraHue/terraSat` offsets still work if you'd rather not touch that block; `terra` is the
       enforced-contrast version and the one the readability floors were measured on.
     - **tree variety** — replace the canopy `canColor.setHSL(((0.26+rng()*0.08+theme.canopyHue)…)` line
       with `const j = jitterFor(theme,'tree',rng, J); canColor.setHSL(j.h, j.s, j.l, THREE.SRGBColorSpace);`
       (hoist `const J = {h:0,s:0,l:0,hex:0}` out of the loop — `jitterFor` writes into `out`, so the
       instance loop allocates nothing). Same call shape you already have, so item 41 is preserved.
       That gives 3 weighted canopy variants × per-instance jitter = several related greens per forest
       instead of one. `theme.canopyL` is a drop-in `[canLMin, canLVar]` if you keep the old path.
     - **bushes / undergrowth** — `theme.bush`, `theme.bushDeep`, `theme.undergrowth`, `theme.moss`
       replace the hardcoded `0x4a7a2e` / `#2f5a1c`; `jitterFor(theme,'bush',rng,out)` per instance.
     - **trunks** — `theme.trunk` / `theme.trunkDark` replace `0x8a5a35`; `jitterFor(theme,'trunk',…)`.
     - **rocks** — `theme.rock` is ROCK_PAL's exact shape (`{stone,basalt,chalk,crystal,rot}` each
       `{base,side,tint}`) but as hex ints, so `const pal = paletteOf(theme.rock)` (fx.js, already
       imported) gives you a per-world drop-in for `ROCK_PAL` at the `ROCK_PAL[palNames[…]]` site. For
       per-formation variety use `rockSetFor(theme, stepRng)` → `{family, base, side, tint}` hexes,
       which is `makeStack()`'s parameter shape unchanged.
     - **crystals / emissive props** — `theme.accent` (diffuse), `theme.accentEmissive` and
       `theme.accentIntensity` (**0.85, do not raise**: ACES at exposure 1.28 clips an additive term at
       1.0 to flat white and the hue is gone), `theme.accentDark`, `theme.flowers[3]`.
     - **distant mountains** — `theme.mountains[3]` replaces the hardcoded `0x6a5490/0x8d76b0/0xbaa9cf`
       ring colours; they are derived from this world's horizon so the haze sits behind the fog.
  4. **Do not break item 43.** `theme.fog` IS the horizon band and `theme.skyBot` is derived *from* it
     (same hue, slightly darker/more saturated) as its neighbour, so the existing
     `fogCol → scene.fog → background → uFog` chain stays correct with no change.
  - **Measured, 200 seeded palettes (174 generated + 26 authored), `node` harness.** Zero failures and
    zero constraint relaxations on every floor. min / median contrast ratio: grass-tip vs ground
    **1.81 / 2.07** (floor 1.35) · grass-base vs ground **1.58 / 1.73** (1.15) · canopy vs sky-mid
    **1.76 / 1.90** (1.50) · canopy vs ground **1.26 / 1.70** (1.15) · canopy vs fog **1.24 / 3.09**
    (1.20) · accent vs ground **1.90 / 2.00** (1.90) · prop-cream `0xf2e4c8` vs ground **1.93 / 2.48**
    (1.70) · dark-critter `0x8a6a42` vs ground **1.36 / 1.60** (1.35) · bush vs ground **1.18 / 1.92**
    (1.18) · rock-side vs ground **1.81 / 1.85** (1.30). Accent hue separation from foliage and soil
    min **0.114** (floor 0.11). |warm/cool split between sun and hemisphere fill| min **1.81** of a
    possible 2.0 — the "never both warm" rule, measured, not claimed.
  - **Why the ground is always a mid-tone:** the cream prop colour and the dark critter colour bracket
    it from both sides, which pins ground luminance to **[0.232, 0.442]** in every world. That single
    window is what the rest of the palette is solved against; if entities.js ever restyles the stem or
    the Common cap, update `PROP_CREAM`/`CRITTER_BROWN` in palette.js and the floors re-derive.
  - **Variety, same 200:** base hue spans 0.002–0.997 (sd 0.288, 12 hue buckets all populated, 9–20
    each); foliage hue 0.042–0.454 (sd 0.108 — bounded on purpose, that is the "foliage reads as
    foliage" band); soil hue 0.010–0.994; accent hue 0.000–0.997 (sd 0.286); saturation multiplier
    0.62–1.38; ground luminance 0.236–0.382; sky-mid luminance 0.072–0.541. 169 distinct
    (season, hour, ground, harmony, hue-octant) signatures out of 174 generated, and 160 distinct
    generated names — not clustering into a few looks.
  - **Per-instance jitter budgets** (±, sRGB HSL; `JITTER` is exported so the dev panel can read it):
    tree 0.020/0.070/0.085 · bush 0.016/0.060/0.070 · grass 0.014/0.050/0.060 · rock 0.012/0.050/0.075
    · trunk 0.014/0.060/0.065 · moss 0.020/0.070/0.080 · deco 0.022/0.080/0.090. Hue is deliberately
    capped near 0.02 — about half the narrowest season band — so an individual instance can never
    leave the band its world established. Measured realised spread over 400 instances of one palette:
    trees 0.090 hue / 0.247 sat / 0.277 value (variant offsets + jitter), bushes 0.032/0.119/0.140,
    rocks 0.024/0.100/0.150.
  - **The 4 authored themes are preserved as authored entries the roll selects** (`AUTHORED`,
    `AUTHORED_CHANCE = 0.18`, so ~1 world in 5.5), NOT as generator seeds — a generator that happened
    to reproduce them today would stop the moment anyone re-tuned a table. Their sky/sun/grass/canopy
    numbers are byte-identical to the old `THEMES`; only the NEW fields (terra strata, rock families,
    canopy variants, accent, haze) are derived for them, through the same solver, so they meet the same
    floors. One honest exemption: Teal Dusk and Blossom Spring violate the warm/cool split rule
    (|split| 0.49 and 0.81) because their authored sun and hemisphere are both cool. That is the
    authored art direction and it is left alone — it is also exactly the accident the generator now
    makes structurally impossible.
  - **Determinism:** `makePalette(rng)` is a pure function of the stream, no `Math.random()`. Verified
    across two fresh `node` processes: seeds 1/42/1337/9999 →
    sha256 `c05465127ee931556afe823639ac55acf685a20b58694ff181dde8d9fcd6152b`, identical both runs.
  - Contact sheet for 18 generated + the 4 authored palettes: **`palette-sheet.png`** in the repo root.

## HUD text pass — the one item that needs JS (hud2, index.html only)

The brief on floating combat numbers was "too big, too many, and low contrast". Size and contrast
are done in `index.html` (`.dmg` 14→11px, `.dmg.crit` 19→15px, `.dmg.harvest` 11→9px, plus a closed
`-webkit-text-stroke` ring in `--ink` with `paint-order:stroke fill` so the outline paints behind the
fill instead of eating the glyph). **"Too many" cannot be fixed from CSS** — it is a spawn-rate
question and both call sites live in `js/main.js`:

- `damageNumber(worldPos, dmg, crit, isPlayer)` (~L183) appends one `div.dmg` per hit with no cap and
  no coalescing, and a `±20px` horizontal jitter that spreads a multi-hit swing into a cloud.
- `pickupText(worldPos, text, color)` (~L198) appends one `div.dmg.harvest` per pickup, so a stomp
  that pays essence + coins + Mycelium puts three lines in the same 40px.

Whoever owns `main.js` next: the fix that keeps the information is **accumulate per target inside the
0.85s window** — keep a `Map<target, {el, total, crit}>`, and on a second hit to the same target
update `el.textContent` to the running total and restart the animation, instead of creating a second
node. That turns a 5-hit flurry from five numbers into one number that climbs, which is also the
clearer read. A hard cap (`if(liveDamageNumbers > 8) return;`) is the cheap version if the Map is too
invasive. Neither can be done from `index.html`.

Also noted while measuring: `js/main.js` clamps the hover chip's anchor to `[40, innerHeight-40]` and
draws the chip above it (`translate(-50%,-100%)`), so a prop whose origin is off the top of the view
parks the chip at y≈7px. Sampled over a full `?demo&seed=42` run, the chip's box lands in the top 10%
of the viewport on **54%** of frames. That is why `#announce` is now anchored off the bottom stack
rather than at a percentage of the height — the upper two thirds of the screen belong to the chip. If
the chip ever grows a "don't cover the banner" rule, that clamp is the place to put it.
