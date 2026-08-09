# Roadmap

This document is the committed delivery plan for Aerocade. It restates the M0–M8 milestone
plan from [DECISIONS.md](DECISIONS.md) with concrete, testable acceptance criteria, then lays
out post-1.0 directions ranked by value/effort, each with honest feasibility notes about what
a browser-only, LAN-only, no-cloud game can and cannot do. Anything not listed here — and
everything in the "won't do" section — is out of scope until this document changes.

## Committed milestones (pre-1.0)

Milestones are sequential; a milestone is _done_ when every acceptance criterion passes and
`npm run verify` (typecheck + lint + tests + build) is green. Playwright joins the gate at M2
per [DECISIONS.md](DECISIONS.md) ADR-010.

### M0 — Scaffold, tooling, docs ✅

Shipped. Monorepo (npm workspaces: `packages/shared`, `packages/client`, `packages/server`),
strict TypeScript, ESLint, Prettier, Vitest, `npm run verify`, and the docs/ set including the
ADR. See [architecture.md](architecture.md).

### M1 — Deterministic sim core + local sandbox

- Fixed 60 Hz sim (`SIM_DT = 1/60`) with accumulator loop and render-rate interpolation;
  no variable-dt physics anywhere. Verified by a unit test stepping the sim with irregular
  frame times and asserting identical tick counts and state.
- Determinism: two `SimWorld`s with the same seed and input log produce byte-identical
  snapshot typed arrays after 10,000 ticks (unit test).
- Movement feel complete per tuning constants: run/walk, ground/air accel, friction, jump,
  gravity, max fall, jetpack thrust/fuel/burn/regen, hover auto-modulation. Each has at least
  one invariant test (e.g. fuel never negative, hover holds altitude within ±0.2 m over 5 s).
- Rivet Pistol hitscan, damage, death, 3 s respawn, 2.5 s spawn protection cleared on firing.
- "Foundry" (48×27 tiles) loads and plays in the local sandbox; player cannot tunnel through
  tiles at max speed (swept-AABB test at 26 m/s).
- HUD shows health, fuel, ammo; desktop controls per [ui.md](ui.md).
- Zero allocations during a steady-state match tick (asserted with a pool-watermark test).

### M2 — LAN networking

- Bridge serves the built PWA at `http://<lan-ip>:8080` and WebSocket `/ws`; implements the
  message set `hello`, `room:create`, `room:list`, `room:join`, `signal`, `relay`, `error`,
  `pong` (codec round-trip tests). Bridge remains game-logic-free.
- Host browser is authoritative; up to 8 players in a star. WebRTC DataChannels
  (unreliable+unordered for 60 Hz inputs / 30 Hz delta snapshots; reliable+ordered for
  join/welcome/events) with automatic WebSocket-relay fallback behind the `Transport`
  interface — a forced-RTC-failure test must complete a join over relay.
- Client prediction + reconciliation (input seq acking + replay), ~100 ms interpolation
  buffer, ≤120 ms extrapolation. Acceptance: with 80 ms simulated one-way delay and 5 % loss,
  local player correction error stays under 0.15 m per reconciliation in a soak test.
- Discovery: room list via bridge, manual `ip:port` + QR fallback.
- Playwright e2e: boot bridge, host context + join context, both shoot, assert kill counts
  converge on both screens.

### M3 — Full combat

- Complete roster: Rivet Pistol, Vortex SMG, Pulse Rifle, Scattergun, Longbolt Rifle, Thumper,
  Lobber, Arclight Beam, Emberjet, Frag grenade, Spanner Strike melee. Every weapon's damage,
  cycle, mag, spread/falloff/splash values come from `weapon-defs.ts` with a per-weapon math
  unit test (e.g. Scattergun falloff at 14 m, Thumper splash at r = 3.2 m, frag restitution 0.45).
- Rocket-jumping works: Thumper self-knockback propels the player measurably (test asserts
  vertical velocity gain within a tolerance band).
- Weapon/health/ammo pickups spawn and respawn deterministically from the seeded RNG.
- Lag compensation: 64-tick rewind ring; a hitscan test fires at a target's _rewound_ position
  and must register the hit that a non-compensated check would miss.

### M4 — Match lifecycle

- FFA and TDM playable end-to-end: lobby, countdown, scoreboard (Tab), kill feed, match
  timer, score/frag limits, end screen, return to lobby. CTF behind a flag if it slips.
- Match state is part of the deterministic sim (the `match` system), snapshot-serialized, and
  covered by codec round-trip tests.
- Playwright: full FFA match to frag limit between two contexts, winner shown identically.

**Status (ADR-031, ADR-036).** FFA is done and verified. Players wait in a **pre-game lobby** that
only the host can start — there is no countdown (ADR-036). Then: the match
clock, the frag limit, the held-Tab scoreboard, the end screen, and back to the menu. Match state
lives in the sim, is snapshot-serialised, is covered by the state hash, and rides every snapshot,
so a joining client shows the same clock and score as the host. The two-context frag-limit run
passes with both sides naming the same winner. Player names arrive over `H2C_ROSTER` (ADR-032), so
the scoreboard shows what players actually chose. TDM's ruleset, team balancing and team scoring are
implemented and tested but not yet selectable in the lobby; CTF is unstarted. One gap remains: there
is no **rematch button** (`restartMatch` exists and is tested, but nothing calls it).

### M5 — Input breadth, settings, audio

- Mobile twin virtual sticks (left move; right aim + fire past deadzone threshold) plus
  jetpack/grenade/reload/switch/melee buttons; verified on a touch-emulated Playwright run.
- Gamepad API support with a default mapping.
- Settings persisted to IndexedDB (name, keybinds, audio levels) per ADR-007.
- All audio procedurally generated (Web Audio) — no third-party assets.

### M6 — PWA polish, maps, dynamics, performance

- `vite-plugin-pwa` precache complete; Training/Survival fully playable offline; install
  prompt and landscape/fullscreen manifest verified.
- At least two additional original maps beyond Foundry.
- **Moving platforms and jump pads** land here as deterministic sim features (tile-grid
  extensions driven by `tick * SIM_DT`, never wall clock).
- Performance budget met on mid-range Android: sim tick ≤ 2 ms, steady 60 fps render, zero
  per-tick GC. Budgets and measurement method in [performance.md](performance.md).

### M7 — AI, Survival, Training

- Deterministic AI opponents (seeded RNG only — replays must stay reproducible) feeding
  inputs through the same input pipeline as humans.
- Survival wave mode and Training mode (free practice, target dummies).

### M8 — Release hardening (1.0)

- 2-hour 8-player soak with zero desyncs, zero leaks (heap watermark flat), no unhandled
  rejections in bridge or clients.
- Docs complete and cross-linked; `npx aerocade-lan` packaging works from a clean machine.
- Security posture per [security.md](security.md) re-audited (host-side input validation,
  bridge message size/rate limits).

## Post-1.0 directions

Ranked by value against effort. "Effort" assumes the shipped architecture; feasibility notes
call out where the browser platform, not our code, is the constraint.

| Rank | Item                                     | Value   | Effort  | Key risk / constraint                       |
| ---: | ---------------------------------------- | ------- | ------- | ------------------------------------------- |
|    1 | Replay recording & playback              | High    | Low     | None — determinism makes it nearly free     |
|    2 | Gun Game + King of the Hill modes        | High    | Low     | None — pure sim-side systems                |
|    3 | Spectator mode                           | Med     | Low     | Host upload bandwidth per extra subscriber  |
|    4 | Dedicated Node host                      | Med     | Med     | Node-side WebRTC needs a lib, or WS-only    |
|    5 | Controller remapping UI                  | Med     | Low–Med | UI surface area, conflict handling          |
|    6 | Map editor + IndexedDB maps + file share | High    | High    | Map validation, versioning, UX cost         |
|    7 | Destructible props                       | Med     | Med     | Snapshot size + determinism of debris       |
|    8 | Audio synthesis upgrades                 | Low–Med | Med     | Web Audio scheduling jitter on mobile       |
|    9 | Localization pass                        | Low–Med | Med     | String extraction across React + canvas HUD |
|   10 | Internet play via community bridge+TURN  | Med     | High    | Explicitly out of core scope (see below)    |

### Replay recording from input logs

The cheapest big feature we can ship, and the reason ADR-009 exists: the sim is a pure
function of `(seed, input log)`. A replay is just the match seed plus every player's input
stream — a few KB per minute — replayed through the exact same `SimWorld` the game runs. No
snapshot capture, no video. Constraints to respect: replays are only valid against the sim
version that recorded them, so the replay header must carry a sim/protocol version and refuse
mismatches; and host-side (not client-predicted) inputs are the canonical stream. Storage in
IndexedDB, export as a file (same share path as custom maps).

### Additional modes: Gun Game, King of the Hill

Both are new `match`-system rule sets over existing mechanics — no new netcode, no new
physics. Gun Game: ladder of the M3 roster, weapon advance on kill, demotion on melee death.
KotH: a scored zone using the existing circle-overlap query. Each needs mode-specific HUD
elements and unit tests for scoring edge cases (contested zone, simultaneous kills). Low risk.

### Spectator mode

A spectator is an extra snapshot subscriber on the host with no input stream and no player
pool slot. The star topology already fans snapshots out per-peer; the work is a spectator flag
in the join handshake, a free-fly/follow camera, and hiding HUD elements. Constraint: each
spectator costs the host ~the same upstream bandwidth as a player (30 Hz deltas), and the host
is a browser on Wi-Fi — cap spectators (e.g. 4) and count them against a total peer budget.

### Optional dedicated Node host

Already architected for: `packages/shared` has zero DOM dependencies precisely so the
authoritative sim can run in Node (ADR-002). The seam is the `Transport` interface plus the
host game-loop module — a Node host imports the same sim and host-side systems, swapping the
browser's `requestAnimationFrame` accumulator for a Node timer loop and the browser RTC stack
for either a WebRTC implementation library or WS-only transport. Honest note: Node has no
built-in WebRTC, so v1 of this would likely be WS-only (fine on LAN), colocated with the
bridge process. Value: no host-migration problem, stable frame pacing, and it un-tethers match
lifetime from one player's phone staying awake.

### Map editor with IndexedDB storage and share-via-file

High value, high effort. In-browser tile editor for 48×27-style grids, original tile palette,
saved to IndexedDB; sharing is a downloaded/imported JSON file (or QR for tiny maps) because
we have no cloud. Hard requirements: schema versioning, a validator (bounds, spawn-point
minimums, reachability check so players can't spawn in sealed rooms), and the host transmits
the map blob to joiners over the reliable channel so clients never need the file in advance.

### Destructible props

Feasible if kept deterministic and pooled: props as a small fixed pool (like pickups) with
health, destroyed flags in snapshots, debris purely cosmetic (renderer-side, never simulated).
The constraint is discipline, not the browser: destruction state must live in the sim pools
and delta-encode cheaply. Full destructible _terrain_ (mutating the tile grid mid-match) is a
much bigger snapshot/reconciliation problem and is not planned.

### Moving platforms and jump pads

Already committed in **M6** — listed here only because it is often assumed to be post-1.0.
See the M6 criteria above.

### Internet play via community-run bridge + TURN

Explicitly **out of scope for core** (ADR-001: zero internet, zero cloud). The honest note:
nothing in the code forbids it — a bridge on a public host plus a TURN server for NAT
traversal would work with today's transport layer — but we will not run, fund, or officially
endorse such infrastructure. If a community operates one, the only core changes worth
accepting are configurable ICE servers and a bridge URL field. Latency expectations (100 ms+
RTT vs. LAN's ~2 ms) would strain the 100 ms interpolation buffer; that tuning burden belongs
to whoever operates it.

### Controller remapping UI

Gamepad API support ships in M5 with fixed mapping; post-1.0 adds per-action rebinding stored
in IndexedDB alongside keybinds. Feasibility note: the Gamepad API exposes stable button
indices but inconsistent labels across browsers/pads, so the UI must use "press the button
now" capture rather than named lists.

### Localization pass

Externalize strings from React menus and HUD into locale maps; canvas-rendered text needs
font coverage checks for non-Latin scripts. No cloud translation services (won't-do list) —
community-contributed locale files shipped in-repo.

### Audio synthesis upgrades

All audio is generated (M5). Post-1.0: richer layered synthesis, per-map ambience,
convolution-free reverb approximations (real `ConvolverNode` impulses are viable but must be
generated, not recorded assets). Constraint: Web Audio scheduling on mid-range Android
requires lookahead scheduling; keep the audio thread work bounded.

## Won't do

Tied directly to the project's values (ADR-001, ADR-007) — these are decisions, not gaps:

- **Accounts / authentication / profiles** — identity is a locally stored name. Nothing to
  breach, nothing to reset.
- **Cloud services of any kind** — no matchmaking servers, cloud saves, leaderboards, or CDN
  dependencies. The game must work forever on a Wi-Fi island.
- **Telemetry / analytics / crash reporting phone-home** — no network calls beyond the LAN
  bridge and peers. Diagnostics stay local (exportable logs only).
- **Paid features, ads, monetization** — Aerocade is a complete game, not a funnel.
- **Third-party art/audio assets** — everything remains original and generated; this also
  keeps the PWA payload small.

## Cross-references

- Architecture and package boundaries: [architecture.md](architecture.md)
- Netcode details the M2 criteria summarize: [networking.md](networking.md)
- Sim/physics invariants behind M1/M3 tests: [physics.md](physics.md), [ecs.md](ecs.md)
- Budgets behind the M6 gate: [performance.md](performance.md)
- Threat model for M8 hardening: [security.md](security.md)
- Test strategy and the `verify` gate: [testing.md](testing.md)
- Project overview: [../README.md](../README.md)
