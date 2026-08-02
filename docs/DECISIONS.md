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
