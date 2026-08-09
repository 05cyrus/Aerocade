# Aerocade — Architecture Decision Record

Living document. Every entry states the decision, the alternatives considered, and why.
Newer entries may supersede older ones; superseded entries are marked, never deleted.

## ADR-001: Product identity

**Aerocade** is an original 2D side-view jetpack arena shooter, browser-native, playable over
LAN with zero internet, zero cloud, zero accounts. All art, audio, maps, weapon tuning, UI, and
branding are original works. The game is _inspired by the feel_ of 2014–2018 era jetpack arena
shooters but shares no assets, values, or code with any existing title.

## ADR-002: Monorepo with npm workspaces

- `packages/shared` — deterministic simulation, ECS, protocol, math. **Zero runtime
  dependencies, no DOM/node types.** This is the heart of the engine; it must run identically
  in a host browser, a client browser (prediction), and Node (tests, future dedicated host).
- `packages/client` — Vite + React + Phaser 3 PWA. React owns menus/HUD (DOM), Phaser owns the
  game canvas. Depends on `shared`.
- `packages/server` — the **LAN bridge**: a small Node process serving the built PWA over the
  local network plus room discovery/signaling/relay over WebSocket. Depends on `shared`.

Alternatives: pnpm/turborepo (extra tooling for 3 packages — rejected); single package
(couples sim to DOM — rejected).

## ADR-003: Custom fixed-timestep physics instead of Matter.js

The preferred stack suggested Matter.js. We deviate, deliberately:

1. **Determinism.** Client prediction + server reconciliation requires re-simulating ticks
   from a snapshot and getting identical results. Matter's solver iteration order and internal
   caches make bit-stable replay across resimulation impractical.
2. **Rewind.** Lag compensation rewinds hitboxes N ticks; our state is flat struct-of-arrays,
   so a snapshot is a few `TypedArray.set()` calls. Serializing/restoring a Matter world is
   slow and lossy.
3. **Fit.** Arena-shooter needs are AABBs vs. a static tile grid, swept movement, rays
   (hitscan), and circle overlaps (explosions). A general constraint solver buys nothing here
   and costs GC pressure and CPU on mid-range Android.

Trade-off accepted: we own collision correctness ourselves; mitigated with a heavily
unit-tested, small (~500 line) physics core. Phaser's built-in physics (Arcade/Matter) is
**disabled**; Phaser renders only.

## ADR-004: Simulation is authoritative, rendering interpolates

Fixed timestep **60 Hz** (`SIM_DT = 1/60`), accumulator loop, no variable-dt physics anywhere.
Rendering runs at display rate and interpolates between the two most recent sim states
(local sandbox) or the snapshot buffer (networked). Sim state lives in preallocated
struct-of-arrays pools (players ×8, projectiles ×256, pickups ×64) — zero allocation during a
match, snapshots are typed-array copies.

## ADR-005: ECS-lite (pooled struct-of-arrays + system functions)

Entities are integer ids into fixed-capacity pools with `alive` flags; components are parallel
typed arrays; systems are pure functions `(world) => void` run in a fixed deterministic order:
`input → movement → physics → weapons → projectiles → damage → pickups → respawn → match`.
No OOP entity classes, no global mutable state — everything hangs off a `SimWorld` value.
This is data-oriented ECS pragmatically sized for a game with ≤ a few hundred entities;
a generic archetype ECS would add indirection without benefit at this scale.

## ADR-006: Networking — host-authoritative star over WebRTC DataChannels, LAN bridge for rendezvous

**Browser reality check** (evaluated): browsers cannot open listening sockets, cannot UDP
broadcast, cannot mDNS-query (mDNS in WebRTC is _obfuscation_, not discovery), and
WebTransport needs HTTP/3 + trusted certs (hostile on LAN, weak Safari support). Therefore
pure browser-to-browser discovery on a LAN is impossible; a rendezvous point must exist.

**Design:**

- One device on the Wi-Fi runs the **LAN bridge** (`npx aerocade-lan` or the packaged build).
  It serves the PWA at `http://<lan-ip>:8080` and a WebSocket at `/ws`.
- The **host player's browser** owns the authoritative simulation (host-authoritative,
  8 players max). The bridge is deliberately dumb: rooms, signaling, relay. This keeps game
  logic out of Node and lets any phone be the game host.
- Game traffic prefers **WebRTC DataChannels**, host↔client star topology, negotiated through
  the bridge: one unreliable+unordered channel (inputs, snapshots) and one reliable+ordered
  channel (join, spawn, chat, match events).
- **Fallback:** if RTC fails (locked-down APs, client isolation quirks), the transport layer
  falls back to WebSocket relay through the bridge. The `Transport` interface hides this from
  the game; LAN RTT makes TCP head-of-line blocking tolerable as a fallback.
- **Discovery:** clients that loaded the PWA from the bridge auto-discover rooms via the
  bridge's room list. Manual `ip:port` entry is the graceful fallback (documented trade-off:
  browsers can't broadcast, so first contact needs a typed address or a scanned QR code).

Client-side: prediction of the local player, reconciliation against host snapshots (input
sequence acking + replay), snapshot interpolation (~100 ms buffer) for remote entities, brief
extrapolation (≤120 ms) on loss. Host-side: input validation, lag-compensated hitscan via a
rewindable history ring (64 ticks).

## ADR-007: PWA

`vite-plugin-pwa` (Workbox) precaches the full app shell; the game is fully playable offline
in Training/Survival, and on LAN with no internet. Manifest: landscape, fullscreen, original
generated icons (procedural — no third-party art). IndexedDB stores settings/keybinds/name.

## ADR-008: Units and tuning

Simulation uses SI-ish units: meters, seconds, m/s. 1 map tile = 1 m; render scale is the
renderer's business. All gameplay tuning constants live in `sim/tuning.ts` and weapon data in
`sim/combat/weapon-defs.ts` — no magic numbers inside systems. All values are original.

## ADR-009: Determinism rules

- No `Math.random` in sim — only the seeded `Rng` (mulberry32) owned by `SimWorld`.
- No `Date.now`/wall clock in sim — time is `tick * SIM_DT`.
- Iteration is always by ascending entity index.
- Trig/sqrt float nondeterminism across engines is accepted: the host is the single source of
  truth, prediction errors are corrected by reconciliation (we need _practical_ determinism
  for replaying our own inputs, not cross-machine lockstep).

## ADR-010: Testing strategy

- Vitest unit tests target the shared sim (physics invariants, weapon math, snapshot
  round-trips, protocol codec) — sim runs headless by construction.
- Vitest + jsdom for client logic that doesn't need a real canvas (stores, input mapping).
- Playwright e2e (added in the networking milestone, M2+): boot bridge + two browser contexts,
  host + join, assert state convergence. Not installed until then to keep setup light.
- `npm run verify` = typecheck + lint + tests + build; required green before every commit.

## ADR-011: Hover is an explicit input, not an automatic speed band

Original design: thrust auto-modulated into altitude hold whenever |velY| < 1.5 m/s.
Unit tests killed it: with gravity and thrust applied within the same tick, an
_accelerating climb_ passes through the band every liftoff, so players got captured into a
hover millimeters off the ground and could never climb. Any band-based rule is inherently
ambiguous between "climbing through slow speeds" and "wants to hover", and stateful
workarounds (latches, edge tracking) add reconciliation surface for no gameplay win.

**Decision:** hover = thrust + down input (`S` on desktop, stick-down on mobile), while
airborne. The jetpack cancels gravity and brakes vertical speed toward zero at
`hoverBrake` m/s², burning `hoverBurnRate` (cheaper than climbing). Stateless,
deterministic, and an intentional skill action. Supersedes the hover wording in ADR-008-era
docs; docs/physics.md and docs/ui.md follow this ADR.

## ADR-012: Articulated character rig, drawn from a single atlas

Players were a single capsule sprite with a barrel stub. That reads as a placeholder, and the
game's feel depends on seeing what an opponent is doing — which way they face, whether they are
sprinting or hovering, what they are holding.

**Decision:** each player is an articulated rig (`PlayerRig`) — helmeted head, armored torso,
jetpack, two legs, arm, and the held weapon, with a distance-driven run cycle, torso lean,
airborne pose, and aim-tracking arm. All art stays procedurally generated (ADR-001 originality),
and the design is an original chibi-soldier, not a copy of any existing game's character.

**Consequence, learned by measuring:** the first implementation gave every body part its own
texture, which cost **~3.5× the frame time** of the capsule (measured A/B on production builds
against the previous commit) because each distinct texture forces a WebGL batch flush. Packing
every frame — character parts, weapons, projectiles, particles, _and_ tiles — into one runtime
atlas removed the regression and left the rig slightly faster than the capsule it replaced.

**Rule going forward:** all new art joins the single atlas. `docs/rendering.md` states this as a
performance contract; treat one-texture-per-thing as a defect, not a style choice.

A dev-only `window.__aeroDebug` hook plus `packages/client/scripts/screenshot-sandbox.mjs`
(headless Chromium) exist to eyeball renderer changes and to A/B render cost; the hook is
stripped from production builds by `import.meta.env.DEV`.

## ADR-013: Weapon pads — fixed places, random contents

Guns are not chosen at spawn; they are fought over. The map defines fixed **weapon pads**
(`'W'` in the ASCII map), each holding one gun. Touch it and it is yours; the pad then sits
empty for `weaponRespawnDelay` (12 s) and refills with a **randomly rolled** weapon.

Decisions and why:

- **Fixed places, random contents.** Fixed positions make pads learnable map knowledge —
  routes, timings, and contests form around them. Random contents keep every cycle a fresh
  decision rather than a memorized pickup order.
- **Pad index ↔ pickup slot.** Pad positions are static map data, so the sim stores only
  contents (`active`, `weapon`, `respawnIn`). Snapshots stay small and the renderer needs no
  lookup map.
- **Never the same weapon twice in a row.** A refill that repeats the weapon just taken gives
  players nothing to come back for. On a repeat we shift by a second draw instead of looping —
  a fixed number of RNG draws per refill keeps the stream length predictable, which matters for
  reconciliation replays.
- **The roll uses the world RNG** (in the snapshot), so a replay or lag-comp rewind reproduces
  the same weapon on the same pad (ADR-009). It must never use `Math.random`.
- **Collecting replaces the _active_ slot**, fully loaded, and leaves the other slot alone —
  so switching to your throwaway slot before stepping on a pad is a real, learnable skill.
  Walking over a weapon you already carry tops up that slot's reserve ammo instead of swapping,
  so a duplicate is never a downgrade.
- **Contested pads resolve by ascending player index**, like every other tie in the sim, so
  hosts and replays agree on who got it.

Health and ammo pads are the obvious next kinds; they add a marker and a branch in
`grantWeapon`'s sibling, not a new architecture.

## ADR-014: Pickup is opt-in; opponents carry overhead health bars

**Weapons are taken, not absorbed.** Walking over a pad no longer swaps your gun. The pad
offers, and the player accepts with `Buttons.Interact` — the `E` key or a circular on-screen
button that appears only while you are standing on a stocked pad.

Why: auto-pickup punished movement. Routing over a pad mid-fight could silently replace the
weapon you were winning with, and the fix under auto-pickup ("switch to your throwaway slot
before crossing") is a chore, not a skill. Opt-in makes the swap a decision you make when you
want it, which is also what makes a pad worth standing on to contest.

Mechanics:

- **Edge-triggered.** Holding the button does not vacuum up a pad the moment it respawns; each
  pickup needs a fresh press. Tested explicitly.
- **One overlap predicate, `playerReachesPad`, is shared** by the simulation and the UI, so the
  button can never appear when the sim would refuse — or stay hidden when it would accept.
- **The button feeds the normal input path.** Tapping it sets a one-shot latch that the game
  loop ORs into the next tick's `buttons` field, so the sim cannot distinguish tap from
  keypress and netcode needs no special case.
- Adding a ninth button meant `sanitizeInput`'s mask could no longer be a hard-coded `0xff`;
  it is now derived from the `Buttons` table so a new bit can never be silently stripped.

**Health bars float over other players**, read straight from sim health so they track damage
the instant it lands. Green above half, fading through amber to red. The local player is
excluded — that is the HUD's job, and a bar on your own head only blocks your view. Bars are
two tinted sprites from the shared atlas rather than a per-player `Graphics`, which would flush
the batch every frame (ADR-012); and they live outside the rig container, because the rig
mirrors on facing and a bar inside it would drain right-to-left.

## ADR-015: Guns are objects on the ground, not slots on a pad

Weapons used to exist only as pad contents. Two requests broke that model: a swap should
**drop** the gun you were holding, and a death should **scatter everything** the victim
carried. Both need items with real positions and their own ammo, so the pickup pool became a
pool of ground objects and pads became pure spawners.

- **Pads spawn, they do not contain.** `WeaponPadPool` holds a refill timer and the slot of the
  pickup it currently owns. A pad remembers the last gun it offered so the no-repeat rule
  survives the empty period.
- **Ammo travels with the item.** A dropped gun keeps the exact magazine and reserve its owner
  had; picking it back up restores precisely that. Grenades drop as a bundle carrying the count.
- **Drops fall.** They are thrown clear with a fixed (not random) scatter — deterministic
  without consuming RNG draws that reconciliation would have to replay — then fall and settle.
- **Drops expire** after `dropTtl`; pad guns never do. When the pool saturates, the
  shortest-lived _drop_ is recycled and pad guns are never evicted, so the arena's fixed supply
  survives a messy firefight.
- **Two rules found by tests, both real bugs:**
  1. Dropped gear gets an `arm` delay. Without it the gun you dropped while swapping landed in
     a later pool slot and was re-collected on the _same tick_ — you never lost it.
  2. A player collects **at most one item per tick**. Collecting can itself drop gear, and
     nobody should sweep a pile with one press.

Health and ammo pads remain the natural next kinds: another `PickupKind` and a branch in
`collect`, not a new architecture.

## ADR-016: Empty-handed grenade pickup, and scopes as a camera-only concern

**Grenades are gathered by walking over them, up to the carry cap.** Being unable to answer a
grenade because you had to remember a button is a frustration, not a decision, and topping up is
never a choice worth a keypress. The pickup is **partial**: a player holding 1 who crosses a
stack of 3 takes 2 and leaves 1 lying there for the next person, so a stack is a shared resource
rather than a first-come-all-or-nothing prize. A player at the cap takes nothing and leaves the
stack whole.

Because grenades are automatic, they are excluded from the interact prompt entirely — a button
for them could never do anything — and automatic collection is exempt from the
one-deliberate-pickup-per-tick rule, so topping up grenades never swallows the press you meant
for a gun. Weapons are still never auto-collected; swapping your gun must always be a choice
(ADR-014).

**Scope never touches the simulation.** Each weapon carries a `ScopeDef` — a zoom-out factor
and a look-ahead distance — and the scope button reframes the camera by them. It is declared in
`weapon-defs.ts` because how far a weapon lets you see is part of that weapon's design, but the
sim never reads it:

- Scoping changes **what you can see, never what you can hit**. Accuracy, range, and damage are
  untouched, so a scoped player has no hidden combat advantage the host would have to validate.
- It therefore stays client state and needs no protocol field, no snapshot bytes, and no
  reconciliation. `Z` is deliberately _not_ a `Buttons` bit for the same reason.

Profiles run from the Scattergun (1.1×, 2 m — point blank by design) to the Longbolt Rifle
(2.3×, 15 m — sees most of the arena), so picking up a sniper genuinely changes how you read
the map. Zoom and offset both ease frame-rate independently; toggling never snaps.

The button's label shows the **current effective** zoom (`1×` unscoped, the weapon's factor
scoped), not the weapon's potential. Showing the potential made the label look static across a
toggle and implied you were already zoomed when you were not.

## ADR-017: Weapons are slot-locked — primary and secondary

The two inventory slots now mean something. Slot 0 holds a **primary** (SMG, rifle, shotgun,
sniper, launcher); slot 1 holds a **secondary** — a sidearm. Each weapon declares its slot in
`weapon-defs.ts`, and `weapons[player * WEAPON_SLOTS + def.slot]` is the only place it can live.

- **A pickup replaces its own slot and nothing else.** Grabbing a rifle while holding your
  pistol swaps the rifle in and leaves the pistol alone. The displaced gun drops with its exact
  remaining ammo, as before (ADR-015). This makes a loadout something you build rather than a
  single slot you keep overwriting.
- **The pickup equips what you took.** The press was deliberate, so the active slot follows the
  weapon in.
- **Switching is a tap on the weapon panel** (or `Q`). The panel shows the other slot's gun
  behind a `⇄`, so the tap target reads as "switch to that".
- The spawn loadout is `[primary, secondary]` and a test asserts each entry belongs to the slot
  it occupies, so a future roster edit cannot quietly seat a shotgun in the sidearm slot.

**Known roster imbalance:** six of the seven weapons are primaries and the Rivet Pistol is the
only secondary, so the sidearm slot is effectively fixed and a pad rolling a "secondary" always
offers the same gun. The mechanism is right; the content is thin. Adding one or two more
sidearms (a machine pistol, a hand cannon) is the natural follow-up and needs no code change
beyond a definition.

## ADR-018: Traversal primitives — ladders, one-way platforms, consumable pickups

A large vertical arena needs more than "walk and jetpack", so three primitives
landed together. Each is deliberately small and lives in the simulation, because all
three affect where players can be:

- **Ladders** are a tile flag, not entities. Gripping is deliberate — press up or down while
  overlapping the rungs — otherwise you would stick to every ladder you ran past. While gripping,
  gravity is suspended and vertical speed is the player's to choose; **firing is untouched**,
  because the weapons system never consults ladder state, so you can shoot the whole way up.
  Jumping off kicks you clear and starts a short re-grip delay, without which the jump
  re-attaches on the very next tick and you can never let go.
- **One-way platforms** are a second tile flag. A platform catches a body only when it was
  _above_ the surface before the step and has now crossed it, which is exactly what lets you
  jump up through and land on top. A player on a ladder is exempt, so climbing through a
  platform works.
- **Health, ammo and grenade pickups** join weapons as pad kinds. All three are consumables and
  therefore **automatic** (ADR-016): they collect on contact when the player can use them, and
  a player who is full leaves the box for someone who is not. Only weapons need a button.

Tile flags are a bitfield, so a ladder can run through a platform, and `MapBuilder.ladder()`
strips `Solid` — a ladder is never allowed to be a wall.

## ADR-019: Outpost Delta is built, not drawn — and its geometry is tested

Outpost Delta is 175 × 98 tiles (5600 × 3136 px), roughly **135× Foundry's area**. Two decisions
follow from that size:

**Programmatic construction.** A 98-row ASCII grid is unreviewable in a diff and its symmetry
would drift on the first edit. Instead a `MapBuilder` draws rectangles, platforms, ladders and
caves; only the left half plus the centre column is authored, and `mirror()` produces the right.
Symmetry is therefore structural — the test asserting it cannot fail without the mirror breaking.

**The map is verified, not eyeballed.** Hand-placed coordinates on a map this size are wrong by
default, and they were: the first pass had spawns buried in rock and whole regions cut off. So
`validateMap` now rejects any spawn or pad inside solid tiles _at construction_, and a test
flood-fills the finished map and fails unless every spawn, every pad, and >99% of open space is
reachable from spawn 1. A minimap render was used to catch what neither could: the upper third
of the map was empty sky, which the brief explicitly forbids, so the sniper nests moved to the
ceiling band and catwalks now bridge the gap.

**Rendering.** 17,150 tiles cannot be 17,150 sprites. `TerrainView` keeps a pool sized to the
_viewport_ and re-points it at whichever tile rect is on screen, rebuilding only when that rect
moves — frustum culling and chunked drawing without leaving the single atlas (ADR-012).

**Art scope, stated plainly.** The reference image is hand-painted: mountains, foliage, painted
concrete. Aerocade generates every pixel procedurally into one atlas and ships no image files
(ADR-001, ADR-012). Outpost Delta therefore reproduces the reference's _layout and gameplay_ —
bunker decks, flank mountains, tunnels, sniper nests, ladders, pickup placement, symmetry — in
the project's own visual language. Painted parallax backgrounds and decoration passes remain a
future milestone; `maps/outpost_delta/` holds the folder structure and a README saying which
folders are code rather than assets.

## ADR-020: Hollow Works is carved, not assembled — and traversal is tested with a player body

**Hollow Works** (180 × 92 tiles, 5760 × 2944 px) is the default map, replacing Foundry as the
level the game boots into. Foundry stays in the registry as a small fast arena and as the fixture
the determinism, pickups and bridge suites build worlds from.

**Carved, not assembled.** The whole ridge is filled solid once, then every cave, gallery, tunnel
and shaft is _subtracted_ from it, and the skyline is cut by carving the sky down to a per-column
deck height. This is the structural answer to "no floating platforms": a chamber is a hole in
rock, so its floor is attached to the mass by construction. A test asserts no solid tile is
isolated, which catches the exception — a slab whose neighbours were later stripped by a ladder or
overwritten by a one-way platform.

**Not mirrored.** Outpost Delta gets symmetry from `mirror()` (ADR-019). Hollow Works cannot: its
reference has a natural cliff on the left and an industrial works on the right. Balance instead
comes from paired corner spawns — S1/S2 high, S3/S4 low — plus tests for spawn spread and for no
two spawns sharing an open row.

**The physics set the scale, and they are stricter than they look.** Three numbers decided the
geometry, and each one caused a real defect first:

- **Jump rise is 1.76 m** (`8.6² / 2·21`), so a 2-tile step is impossible. Cover blocks placed two
  tiles tall were therefore not cover but _walls_: they severed the lateral route on the layer
  they sat on, and a walk test crossed 1.1 m of the top terrace before stopping dead. `cover()`
  now builds a symmetric staircase and clamps its peak to what the width can ramp up to.
- **The body is 1.65 m tall**, so it needs two open tiles. Tile flood fill happily routes through
  a one-tile gap, so connectivity is verified with a 1×2 body that walks, falls, climbs and
  jetpacks — not with bare tile adjacency.
- **The jetpack climbs ~20 m**, which is generous enough to hide bad ladders. Shafts originally
  stopped a few tiles into the band below, leaving an 8-tile air gap to the floor; the suite still
  passed because it credits a 6-tile jetpack climb. Ladders now run surface-to-surface, and a test
  asserts every ladder run _ends on ground_.

**Verified in the running game, not only in tests.** Thirteen probe points across all five layers
were teleported in and left to settle: all landed grounded, none stuck. Walk, jetpack and ladder
traversal were then driven with real input. That last step mattered — a _tapped_ jump does not
clear a 1-tile step, because `jumpCutGravityMult` 2.2 cuts a released jump short, so an early
"the terrain is blocked" reading was the test's fault rather than the map's.

**Terrain reads as rock, and the map carries no material data to do it.** One flat blue-slate
tile everywhere made a carved cave complex look like stacked blocks, which defeated the point of
carving it. Fixed entirely in the renderer, with no new sim or map data:

- `TerrainView.rockFrame()` picks a frame from the tile's **neighbours** — open above is a
  walkable ledge (mossy, lit), open below is a cave roof (dark underside, stalactites), an
  opening beside it is a cave wall, and anything fully buried is the darkest rock. So the grid
  the sim knows only as "solid" renders as ledges, walls, roofs and bedrock. Buried rock being
  darkest is what makes a cave mouth read as an opening rather than as a differently-coloured
  wall, and the mossy lit top edge is the visual promise "you can stand here".
- **No per-tile border.** A tile outline is what turned a rock mass into brickwork; tiles now
  fill edge to edge and merge into one face, leaving the silhouette to do the shape work.
- **Deterministic per-tile flipping** (a hash of x,y — never `Math.random`, so terrain cannot
  shimmer between rebuilds) breaks the repeat without extra atlas frames. Surfaces and roofs
  flip only horizontally; mirroring them vertically would hang moss underneath or stalactites
  off a floor.
- The arena background moves from navy to a misty ridge haze.

All five frames join the single atlas, so this costs no extra draw calls (ADR-012), and frames
are assigned only while the visible rect is rebuilt — never per frame.

Still not reproduced from the reference: distinct concrete and steel materials for the ruins and
the works (they render as rock), painted parallax backdrops, and decorative props — pipes,
machinery and crates exist as collision geometry but are drawn as rock rather than as objects.

## ADR-021: Sound is synthesised, and it is our own Web Audio graph

The game shipped silent. Sound is now generated the same way art is — from code at boot, no
files — which keeps ADR-001 (originality by construction) and ADR-007 (a tiny PWA precache)
intact for audio too.

**We own the AudioContext; Phaser stays `noAudio: true`.** Phaser's sound manager exists to load
and decode asset files and mix them. We generate every buffer ourselves and need none of that, so
routing through it would add a layer and a second `AudioContext` for nothing. `docs/rendering.md`
previously promised "Web Audio via Phaser sound manager"; that is now corrected — Phaser owns no
audio at all.

**Synthesis is pure and testable.** `sfx.ts` returns mono `Float32Array` data and never touches
the DOM, so it is unit tested in Node — these are the **first tests in the client package**, which
until now had none and whose `test` script failed outright with "no test files found". The tests
assert the properties that actually break audio and that reading the code will not catch: no
NaN (one silences a whole buffer on some implementations), nothing outside [-1, 1] (clips the
master), nothing near-silent, clip length scaling with sample rate, and byte-identical output
across two renders.

**Noise is seeded, never `Math.random`.** Clips must be identical on every boot for the same
reason textures are. This is render-side RNG and is entirely separate from the sim's (ADR-009).

**Oscillators integrate phase.** Evaluating `sin(2π f t)` with a swept `f` is not an oscillator —
the phase jumps every sample and it buzzes instead of sliding.

**One looping voice for jetpacks, not one per player.** The loop is created lazily on first thrust
and only its gain is ramped; restarting a buffer per frame would click and allocate. Intensity is
the loudest distance-weighted thruster in the arena, so a fight overhead is audible without paying
for eight loops.

**The context is released on scene shutdown.** An `AudioContext` is a scarce browser resource —
Chrome allows only a handful per page — and it is not a Phaser object, so `game.destroy()` does
not reclaim it. Without an explicit release, leaving the sandbox and returning leaked one per
visit and audio would silently stop working after a few rounds. React StrictMode double-mounts the
session in development, which is how the leak was caught: instrumenting `AudioContext` in a
headless browser showed two constructed and none closed.

**Mute is a single master gain**, driven from the store by the HUD toggle, and muted playback
allocates no nodes at all. Volume settings and persistence wait for the settings screen (M5).

Not done: no footstep, landing or impact sounds; no music; no per-material impact variation; no
audio for remote players' reloads distinguishable from your own.

## ADR-022: Touch controls merge with the keyboard, and the aim stick owns aim

The mobile twin-stick layer specified in `docs/ui.md` §5 is now built. Three decisions were not
obvious from the spec.

**The aim stick must override pointer aim explicitly.** The scene composed aim from
`this.input.activePointer` through the camera, which is correct for a mouse. On a touchscreen the
"active pointer" is whichever finger moved last, so dragging the MOVE stick swung the player's aim.
`TouchInput` therefore reports an aim angle that is `null` when the stick is idle, and the game
loop prefers it over the pointer only while it is engaged.

**Touch is merged with keyboard input, not switched to.** Buttons are OR'd and each axis takes
whichever source is actually deflected. A tablet with a keyboard, or a phone player tapping a HUD
button mid-run, must never have one source cancel the other.

**The sticks live outside React state.** Deflection is read at 60 Hz; putting it in the store would
re-render the HUD on the game loop's schedule, which `docs/ui.md` §4 forbids. So `touchInput` is a
module singleton the components write and the loop drains — the same shape as the existing
`requestInteract` latch, extended from one-shot pulses to held values. Only the stick ring visuals
are React state, and only while a stick is held.

**The walk/run tiers needed rescaling, not a flag.** `moveX` is analog (`target = moveX * speedCap`)
and `Buttons.Walk` swaps the cap. Setting Walk below the 0.55 threshold and passing raw deflection
makes speed _fall_ as the thumb pushes further — 0.54 × 4.2 = 2.3 m/s, then 0.56 × 7.4 = 4.1 m/s.
`moveAxis` instead rescales per tier so the walk band spans 0 → walkSpeed and the run band
continues walkSpeed → runSpeed. A test asserts speed rises monotonically across the whole travel,
which is the property the spec's "matching the 4.2 / 7.4 tiers" actually implies.

**Tested as maths, verified as touches.** The formulas — deadzone re-normalisation, follow-mode
re-anchoring, fire hysteresis, tier continuity — are pure functions in `input/stick.ts` with 21
unit tests, because the alternative is testing them by hand on a device. The wiring was then driven
with synthetic multi-touch through CDP on an emulated phone: small deflection walks with the Walk
bit set, full deflection runs without it, releasing returns `moveX` to exactly 0, the jetpack button
climbs, and with **both thumbs down** the aim stick fires straight up while the move stick holds
full deflection — the cross-wiring case that pointer-id routing exists to prevent.

Not done: no grenade hold-power arc, no left-handed mirror, no layout-scale or sensitivity setting
(all wait on the settings screen), and Gamepad API support is still open.

## ADR-023: Settings persist to IndexedDB, and only settings with a consumer ship

The settings screen from `docs/ui.md` §6 is built: one scrollable grouped list, every change applied
live and written immediately. There is no Save button — a change that can be lost by backing out is
a change the player will lose.

**Validation is the whole risk, so it is pure and heavily tested.** A settings record is the only
state that enters the program from _outside_ it — written by an older build, hand-edited in
devtools, or truncated by a crash. `normalizeSettings` coerces and clamps every field and doubles
as the migration path: a partial or older record keeps whatever still validates and takes defaults
for the rest, so adding a setting never invalidates saved preferences and removing one never leaves
a stale value behind. 24 tests cover the shapes that actually turn up, including the two that
survive naive clamping — `Infinity` (a min/max would silently accept it as the limit) and `NaN`
(poisons every later comparison).

**Failing to read a preference is not a reason to refuse to start.** `loadSettings` never rejects:
private-browsing modes, disabled storage and corrupt records all resolve to defaults, and loading
happens after first paint so defaults render immediately.

**Two settings from the spec are deliberately absent rather than stubbed.**

- **Aim sensitivity has nothing to scale.** Aerocade aims _absolutely_ — the mouse aims at a world
  point, the aim stick reports a direction — so there is no relative delta for a multiplier to act
  on. Shipping the slider would have been a control that silently does nothing.
- **Keybind remapping needs the keyboard sampler to become data-driven first.** `KeyboardMouseInput`
  hard-codes its `KeyA`/`KeyD` checks; a table that cannot actually rebind is worse than no table.

**`muted` moved out of the store and into settings**, so there is one source of truth and the HUD
toggle persists for free. Mute still wins over volume at the master gain rather than being folded
into it, so unmuting restores the level the player chose.

Verified end to end in a browser: changes apply live, survive a full page reload via IndexedDB
(name, volume, scale, left-handed and reduced-shake all restored), reset returns defaults, and the
configured name reaches the kill feed — `Vega ⚡ Bolt Dummy`, where it previously read `You`.

Not done: no keybind table, no gamepad bindings, no music volume (no music), no colourblind palette.

## ADR-024: Gamepad is a third input channel, polled, sharing the touch layer's maths

Gamepad support completes the input story: keyboard/mouse, touch and now a controller all write the
same `InputCommand`, and the simulation cannot tell them apart.

**Polled, not evented.** The Gamepad API has no button events, and a `Gamepad` object is a snapshot
that never updates — so `navigator.getGamepads()` is re-read inside `sample()`, once per simulation
tick, alongside the other samplers. Holding a `Gamepad` reference and reading it later returns stale
values, which is the classic bug here.

**Mapping is pure, so it is testable without hardware.** `mapGamepad(pad, walkSpeed, runSpeed)` takes
a `GamepadLike` — just `axes` and `buttons` — so 21 tests drive synthetic pads through every binding,
the deadzone, D-pad precedence and a half-pulled analog trigger. CI needs no controller.

**The deadzone curve is now shared with the touch sticks.** `applyDeadzone` was extracted from
`resolveStick` rather than reimplemented: both need "dead below the threshold, and no jump when
crossing it", and a physical stick needs it more than a thumb does because it rests off-centre as it
wears. The extraction is behaviour-preserving — all 21 existing stick tests stayed green.

Three details worth recording:

- **An idle right stick must report `null`, not an angle of 0.** Aim is absolute, so returning 0
  would snap the soldier to face right the instant a controller is connected, silently stealing
  mouse aim. Unplugging hands aiming straight back to the mouse.
- **Aiming and firing are separate on a pad.** The touch layer fires from aim-stick deflection
  because it has no trigger; a controller has one, so the right stick aims and the right trigger
  fires. You can track a target without shooting.
- **The D-pad wins over the left stick** when both are deflected, so a thumb resting on a worn,
  drifting stick cannot fight a deliberate D-pad press.

Verified in a browser against a synthetic pad injected over `navigator.getGamepads`: walk/run tiers,
aim exactly −π/2 from the right stick with fire disengaged, trigger firing, jetpack climbing, and
mouse aim returning on disconnect.

**A note on the harness, not the feature.** The first run of that scenario appeared to show the right
stick and trigger being ignored. They were not — the headless run manages ~36 fps, the accumulator
drops backlog, and fixed `waitForTimeout` sleeps were reading state before any tick had consumed the
new pad values. The scenario now waits on `world.tick` advancing. Worth remembering: any in-game
assertion in this project must wait on sim ticks, never wall clock.

Not done: no rebinding (the same blocker as the keyboard — `KeyboardMouseInput` is not yet
data-driven), no rumble, no per-pad profiles, and no on-screen indication that a pad is connected.

### Follow-up: the touch layer was eating HUD taps

Reported as "not able to click scope in mobile", and it was worse than one button. The stick zones
are full-height halves of the screen and `.touch-layer` carried `z-index: 5` while `.hud` declared
none, so DOM order put the zones **on top of** the HUD. Three controls were dead on touch: scope and
pickup (inside the right/aim zone) and mute (inside the left/move zone). Pickup is how a weapon is
taken on a phone, so the map was effectively unplayable there.

`docs/ui.md` §5 already said "zones exclude the button cluster's bounds"; the requirement was missed
for the HUD's own buttons.

**Fix:** `.hud` gets `z-index: 6`, above the layer. Raising the whole HUD is safe precisely because
its root is `pointer-events: none` and only interactive children re-enable it (§1) — everything else
still passes through to the sticks.

**Guarded by a test that was proven to fail.** `hud-stacking.test.ts` asserts the invariant against
`styles.css` — that both layers declare a z-index, that the HUD's is higher, that the rotate prompt
is above both, and that the HUD root stays pointer-transparent. Before trusting it, the fix was
reverted and the browser probe re-run: it reported `.scope-button BLOCKED by .touch-zone
touch-zone-right` and `.mute-toggle BLOCKED by .touch-zone touch-zone-left`, reproducing the bug
exactly. It is a CSS invariant rather than an e2e test because Playwright stays out of the test
dependencies until the networking milestone (docs/testing.md).

Writing that test also surfaced a second, quieter problem: `.rotate-prompt` declared its stacking
only _inside_ its portrait media query, so the base rule had no z-index at all. Layout now lives in
the base rule and the query flips visibility only.

## ADR-025: Bindings are data, and a rebind warns instead of stealing

Keybind remapping was the last M5 item, and it was blocked on its own
prerequisite: `KeyboardMouseInput` hard-coded `KeyA`, `Space`, mouse button 0 and the rest, so a
settings table could display bindings but never change them. Bindings now live in
`game/input/bindings.ts` as data, the sampler resolves actions through them, and the UI edits them.

**`KeyboardEvent.code`, not `key`.** Codes are layout-independent — `KeyA` is the same physical key
on QWERTY and AZERTY. Binding `event.key` would silently rebind itself when the OS layout changed.

**Keyboard and mouse share one string space** (`KeyA`, `Mouse0`). One namespace makes conflict
detection a plain string comparison instead of two parallel code paths, and it lets a player put
Fire on a key or Melee on a mouse button without the model caring.

**Two slots per action**, because the arrow-key alternates have always worked and dropping to one
binding would have been a silent regression dressed up as a feature.

**A rebind warns; it does not steal.** The first implementation cleared the code from whatever else
held it, which guarantees no duplicates — and the in-browser check showed why that is wrong:
binding Grenade to `R` left **Reload with nothing bound at all**, visible only as a dash in a table.
Losing a control silently is worse than a visible clash, and `docs/ui.md` §6 asks for a warning
rather than a rejection. Duplicates are now allowed, flagged inline and on both cells, and nothing
is lost without the player choosing it. A test asserts that binding every action to one shared key
still leaves every action bound.

**Validation matches the rest of the settings record.** `normalizeBindings` never throws; an action
whose stored codes are all junk falls back to its defaults rather than becoming permanently
**unbindable**, which is the one corruption that would need clearing site storage to escape. The
settings record went to v2; a v1 record simply picks up default bindings.

**Rebinding a held key clears held state.** Otherwise a key held while its action is remapped stays
stuck down for an action it no longer feeds.

**The menu hint is generated from live bindings.** It used to be hard-coded, so it would have
confidently advertised A/D to a player who had rebound them — a doc bug that only appears once
rebinding exists.

Verified in a browser: after remapping Move right to `L`, holding `D` moves **0 m** and holding `L`
moves **5.61 m**; Escape cancels a capture instead of binding itself; per-table reset restores
defaults; a binding survives a page reload; and the menu hint updates from `D` to `L`.

Not done: no gamepad rebinding (the pad mapping is still fixed), no per-profile bindings, and no
conflict resolution beyond the warning.

## ADR-026: The wire codec is built and tested before any transport

M2 starts with the binary codec from `docs/networking.md` §5, not with sockets. Prediction,
reconciliation and interpolation are all meaningless if a snapshot does not survive a round trip, and
a quantization bug at this layer surfaces as lag or suspected cheating rather than as a bug. ADR-010
has listed "snapshot round-trips" as a test target since M0; those tests now exist (32 of them).

**The spec's quantization note was stale, and it mattered.** It says positions fit `u16` at 1/256 m
because "the map is 48×27 m". Hollow Works is 180×92 m. It still fits — the real ceiling is
**255.996 m** — but the headroom is a third of what that note implies, and a map past 256 m would
**wrap silently**, teleporting players with no error anywhere. `assertEncodable` now fails loudly, and
a test walks every registered map through it. Velocity headroom was checked the same way: ±127.99 m/s
against a `hardSpeedCap` of 45.

**Aim resolution was chosen against the longest shot, not by feel.** A `u16` over a full turn is
~0.0055°; at the Longbolt's 70 m range that is under 7 mm of drift, well inside a player's 0.85 m
width. The test asserts that product rather than the raw angle, so it stays meaningful if either
number changes.

**The pickup record is 6 bytes, not the spec's 2.** `index, state` cannot place an item. That is fine
for pad guns, whose position comes from the map, but wrong for gear dropped on a swap or a death —
that is thrown and falls under gravity (ADR-015), so a client given 2 bytes has nowhere to draw it.
Position is carried rather than inferred. Deltas also explicitly report a pickup that _vanished_;
omitting it means "unchanged", so without that the client would keep drawing a looted gun forever.

**`tuningHash` exists because desync is invisible.** Two peers on different tuning values produce
different positions from identical inputs, which reads as lag or cheating. Hashing protocol version
plus tuning plus weapon defs into `WELCOME` turns that into an immediate, legible rejection. FNV-1a
is used because it is dependency-free and stable across engines — a hash that differed per browser
would reject every join.

**Naming:** the wire type is `WireSnapshot`, because `sim/world.ts` already exports `Snapshot` for the
rollback copy of the whole pool set. Conflating the quantized network subset with the rollback state
would be a genuinely confusing bug.

Two of the first test failures were the tests' fault, worth recording because both are easy to
repeat: `createMatch` builds an _empty_ match, so a capture found no players until the test called
`addPlayer`; and aim error must be measured as a **shortest arc**, since −π and +π are the same
heading yet differ by 2π as plain numbers, which reported a full turn of error for a perfect round
trip.

Still to come in M2: the `Transport` interface with a WebSocket-relay implementation, then WebRTC
behind the same interface, then the host/client session, then prediction and reconciliation, then
interpolation. `H2C_EVENT` is specified but not yet encoded — it lands with the session that needs it.

## ADR-027: The transport seam, and why its test uses the real bridge

`Transport` (docs/networking.md §3) is the interface the game talks to; it never sees a socket. ADR-006
requires the WebSocket-relay fallback to be invisible to the game, and the only way to keep that
promise true is to give the game no way to tell the paths apart. `RelayTransport` is the first
implementation; the WebRTC one lands behind the same interface.

**The socket is injected, and that is a testing decision as much as a layering one.** `packages/shared`
may not reference DOM or Node types (ADR-002), so `BridgeClient` takes a factory that adapts whatever
WebSocket the environment has to plain callbacks. The payoff is that the code the browser runs is
**exactly** the code the tests drive — from Node, against the real bridge, with no environment branch.
A mocked transport would prove nothing here: every interesting failure in this layer is base64
handling, the channel tag, room addressing or a payload cap, and a stub fakes all four happily. The
12 new tests in `packages/server/test/relay.test.ts` run two real clients through the real bridge
carrying real codec frames.

**Base64 is hand-rolled** rather than `btoa`/`atob` (browser-only) or `Buffer` (Node-only), because
this exact path runs in both and branching would mean the tested path is not the shipped path. It
returns `null` on malformed input instead of throwing or emitting partial bytes — a truncated game
frame is garbage, not a partial update (docs/security.md). Tested across every byte value and every
length modulo 3, so the padding cases are actually exercised.

**A 1-byte channel tag** carries the reliable/unreliable distinction over the single relay socket, and
is what lets the relay honour "unreliable" at all: `Channel.Data` frames are dropped when the socket
is backed up, because a queued 60 Hz input is already stale by the time it flushes and holding it
only delays the next one. `send` returns false on a deliberate drop so callers can count them rather
than assume delivery, and `broadcast` tags once and reuses the buffer — tagging per peer would copy
it eight times per snapshot, which is exactly the per-frame allocation the budget forbids.

**Oversized frames fail at the sender.** The bridge rejects a relay payload over 16 KiB; discovering
that as a mysterious disconnect would be miserable to debug, so `sendRelay` refuses and reports
`bad-message` locally. A test asserts the socket is still usable afterwards.

**`error` is awaited alongside every happy-path reply.** The bridge answers a bad request with
`error`, so a request that only listened for its success message would time out after 8 s and never
say why — verified by asserting a join to a missing room rejects with `room-not-found`.

Still to come in M2: the host/client session that drives this (host runs the authoritative sim and
broadcasts snapshots, clients send inputs), the WebRTC transport, then prediction, reconciliation and
the interpolation buffer. `H2C_EVENT` remains specified but unencoded until the session needs it.

## ADR-028: A client projects snapshots into a real `SimWorld`, and prediction waits

The host/client session layer (docs/networking.md §2, §5, §6) is in place: the host runs the only
authoritative simulation, admits joins, applies client inputs once each, and broadcasts 30 Hz
snapshots delta-encoded per client. Nine tests drive a real host and a real client through the real
bridge, and the assertion that matters is **convergence** — a client's world coming to agree with the
host's is the only thing the netcode exists to achieve.

**A joining client keeps a full `SimWorld` and overwrites it from snapshots.** The alternative — some
parallel "remote state" structure — would have needed a second renderer path. Because the renderer,
interpolator, HUD and audio layer all already read a `SimWorld`, projecting into one means a client
needs **no** rendering changes to display a remote match, and when prediction arrives the same world
is what gets re-simulated forward, so there is no second representation to keep in step.
`applySnapshotToWorld` touches only the fields the wire carries; cooldowns, bloom and ladder regrip
stay host-authoritative and untouched, which keeps it a projection rather than a partial and subtly
wrong simulation.

**There is deliberately no prediction yet, and the client feels a full round trip of lag.** That is
the honest intermediate state. Prediction plus reconciliation (§7) is a distinct piece of subtle work,
and a half-finished version produces rubber-banding that is far harder to diagnose than plain
latency — the symptom stops pointing at the cause.

**Sequence comparison is wrap-safe, and this is not hypothetical.** Input seq is `u16` at 60 Hz, so it
wraps every ~18 minutes. A plain `>` works perfectly until then and the client simply goes mute —
a bug that only appears in long matches, which is exactly when nobody is watching a debugger.
`isNewerSeq` does a windowed comparison and is shared by both sides so they cannot disagree.

**Queued inputs are applied exactly once, then cleared.** Held buttons arrive every tick anyway, so
clearing means a dropped packet costs one tick of input rather than repeating a stale frame forever.

**A repeated join is idempotent.** A lost WELCOME leaves the client unable to tell whether the host
heard it, so it must be safe to ask again — re-joining returns the same slot instead of consuming a
second one, verified by a test.

**A stale delta is dropped, not guessed at.** If the client no longer holds the baseline a delta cites,
it discards the frame; the host resends a keyframe once the ack goes stale, so the gap self-heals
without a request path. Out-of-order frames are dropped too — the data channel is unordered, and
applying an older snapshot would visibly rewind everything on screen.

**The seed is passed into `HostSession`, not read off the world.** `SimWorld` keeps an `Rng` instance
and not the seed that produced it; adding a field for the netcode's benefit would put transport
concerns inside the simulation.

Still to come in M2: the WebRTC transport behind the existing `Transport` interface, prediction and
reconciliation, and the interpolation buffer. The lobby that makes all of it reachable is ADR-029.

## ADR-029: The lobby completes the handshake, the store owns the socket, and a lost match says so

Host/Join LAN Match are now live buttons. `netplay.ts` reduces the whole browser side — bridge
connection, relay transport, session — to one `NetHandle` with six members, so `GameSession` learns
nothing about netcode beyond three fields: which world, which player, and whether it may step.
Verified in two real Chromium contexts against the real bridge: the guest sees the host's room, joins,
both report two players in distinct slots, and the guest holding `D` moves **that** player +6.07 m in
the host's authoritative sim (`A` → −10.66 m). The guest's own view trailed the host by ~1 m, which is
exactly the missing prediction from ADR-028 made visible — a full round trip, as documented.

**The handshake finishes in the lobby, before the game screen mounts.** A joining client's player slot
does not exist until the host's WELCOME lands, and the renderer, interpolator and HUD are all built
around a known local player id. Entering the scene first would mean rendering a match with no idea
which soldier is yours, and every one of those readers would need a null case for a state that lasts
one round trip.

**The store owns the `NetHandle`; the session must not close it.** The first version had
`GameSession.destroy()` close the net handle, which read as tidy and was wrong: the handle now had two
owners. React StrictMode double-mounts, so the first teardown left the room and closed the socket the
instant a match started — the host sat in a live-looking game while the bridge reported **zero rooms**,
and no guest could ever see it. The failure was invisible from the host's own screen, which is what
made it worth an ADR: lifetime belongs to whoever created the thing, and a renderer that is expected
to be built twice cannot be trusted with it.

**A match that ends on its own is reported, not frozen.** This is the gap the verification actually
found. A client never steps its own world by design (ADR-028), so a dead socket has no symptom — the
world simply stops, indistinguishable from a hang. `BridgeEvents` already carried `onDisconnected` and
`onRoomClosed`; nothing was listening. Both now feed a one-shot latch (one-shot because a dropped
socket _also_ closes the room — two events, one thing that happened) which the store turns into a
notice drawn **over** the last known frame rather than a snap back to the menu: the player needs to
know whether the host quit or the network dropped, and a silent jump looks like a crash. The handle is
deliberately left open until the notice is dismissed, so the frame stays on screen. Verified by
killing the host and then by killing the bridge process mid-match: `the host ended the match` and
`lost the connection to the LAN bridge` / `...to the host`, with a control asserting no notice exists
while the match is healthy. The latch also notifies a late subscriber, because a socket can die
between WELCOME and the store's subscription.

**A peer too slow to drain its socket gets dropped, and that is the heartbeat working.** Chasing the
frozen guest turned up the mechanism: this box software-renders WebGL, two contexts starved the guest
page to roughly one animation frame per second, Chromium's network service stops reading a socket the
renderer is not draining, so the bridge's ping was never read, never ponged, and two missed pongs
terminated the peer (code 1006). No code was wrong. It is recorded because the same chain will hit a
genuinely underpowered phone, and the visible symptom — one player freezing while everyone else plays
on — points at the network rather than at frame rate. The notice above is what makes it legible.

**The shipped lobby is the bottom half of ui.md §7.** Host-immediately, a 2 s polled room list, join,
and plain-language failures are in. QR share, the `contacting bridge → … → in lobby` progress
breakdown and the RTC-vs-relay badge are not — the badge in particular has nothing to report until
the WebRTC transport exists.

## Milestones

- **M0** Scaffold + tooling + docs (this ADR) ✅
- **M1** Deterministic sim core + playable local sandbox (move/jetpack/aim/shoot/damage/
  respawn, one original map, HUD) + unit tests
- **M2** LAN bridge, transports (RTC + WS fallback), host-authoritative sync, prediction/
  reconciliation/interpolation, Playwright e2e
- **M3** Full weapon set, grenades, melee, pickups, lag compensation
- **M4** Match lifecycle: FFA/TDM/CTF, scoreboard, kill feed, timer, end screen
- **M5** Mobile twin-stick controls, Gamepad API, settings, audio (generated)
- **M6** PWA polish, more maps, moving platforms/jump pads, performance hardening
- **M7** AI opponents, Survival waves, Training mode
- **M8** Release hardening: soak tests, docs completion, packaging
