import { describe, expect, it } from 'vitest';
import { SIM_HZ, NO_PLAYER } from '../src/constants.js';
import { addPlayer } from '../src/sim/spawns.js';
import { assignTeam, createMatch } from '../src/sim/match.js';
import {
  configureMatch,
  DEFAULT_MATCH_RULES,
  MatchPhase,
  SANDBOX_RULES,
  timeRemainingSeconds,
  warmupRemainingSeconds,
} from '../src/sim/match/state.js';
import { FFA_RULES, GameMode, NO_WINNER, rulesetFor, TDM_RULES } from '../src/sim/match/modes.js';
import { leader, restartMatch } from '../src/sim/systems/match.js';
import { stepWorld } from '../src/sim/step.js';
import { Buttons } from '../src/sim/input.js';
import { SimEventType } from '../src/sim/events.js';
import { TUNING } from '../src/sim/tuning.js';
import {
  createSnapshot,
  restoreSnapshot,
  stateHash,
  takeSnapshot,
  type SimWorld,
} from '../src/sim/world.js';
import { createBoxMap, stage } from './helpers.js';
import {
  applyDelta,
  captureSnapshot,
  decodeSnapshot,
  encodeSnapshot,
} from '../src/protocol/codec.js';
import { applySnapshotToWorld } from '../src/net/apply-snapshot.js';

/**
 * The match layer is what turns the sandbox into a game: a clock, a score, and a
 * way to win. It is deliberately part of the deterministic sim rather than UI
 * state, so these tests hold it to the same standard as physics — the clock comes
 * from ticks, the same inputs end the match on the same tick, and every field
 * survives a snapshot round trip.
 */

/** A world with `count` players and a real (ruled) match. */
function ruledMatch(count: number, rules = DEFAULT_MATCH_RULES): SimWorld {
  const world = createMatch(createBoxMap(), 1234, rules);
  for (let i = 0; i < count; i++) {
    const slot = addPlayer(world);
    assignTeam(world, slot);
  }
  return world;
}

function run(world: SimWorld, ticks: number): void {
  for (let i = 0; i < ticks; i++) stepWorld(world);
}

describe('match phases', () => {
  it('starts a ruled match in warmup and goes live on schedule', () => {
    const world = ruledMatch(2);
    expect(world.match.phase).toBe(MatchPhase.Warmup);
    const warmupTicks = Math.round(TUNING.match.warmupSeconds * SIM_HZ);

    run(world, warmupTicks - 1);
    expect(world.match.phase, 'still counting down one tick before the end').toBe(
      MatchPhase.Warmup,
    );
    run(world, 1);
    expect(world.match.phase).toBe(MatchPhase.Live);
    // The live clock starts when the match does, not when the world was created.
    expect(world.match.phaseStartTick).toBe(warmupTicks);
  });

  it('announces every phase change as an event', () => {
    // The renderer, audio and HUD all learn about the match the same way they
    // learn about a kill; polling the phase each frame would be the alternative.
    const world = ruledMatch(2);
    const announced: number[] = [];
    for (let i = 0; i < Math.round(TUNING.match.warmupSeconds * SIM_HZ) + 1; i++) {
      stepWorld(world);
      world.events.forEach((ev) => {
        if (ev.type === SimEventType.MatchPhase) announced.push(ev.a);
      });
    }
    expect(announced).toEqual([MatchPhase.Live]);
  });

  it('locks weapons during warmup but still lets players move', () => {
    // Standing still for a countdown feels broken; a free frag off the line is worse.
    const world = ruledMatch(1);
    const startX = world.players.posX[0] ?? 0;
    const startAmmo = world.players.ammoMag[0] ?? 0;
    stage(world, 0, { moveX: 1, buttons: Buttons.Fire });
    run(world, 30);

    expect(world.players.posX[0], 'walked during warmup').not.toBeCloseTo(startX, 2);
    expect(world.players.ammoMag[0], 'no ammo spent during warmup').toBe(startAmmo);

    // ...and the same held input does fire once the match is live.
    run(world, Math.round(TUNING.match.warmupSeconds * SIM_HZ));
    stage(world, 0, { moveX: 0, buttons: Buttons.Fire });
    run(world, 2);
    expect(world.players.ammoMag[0], 'fires once live').toBeLessThan(startAmmo);
  });

  it('freezes everything once the match is over', () => {
    const world = ruledMatch(1, { ...SANDBOX_RULES, warmup: false, fragLimit: 0 });
    world.match.phase = MatchPhase.Over;
    world.match.phaseStartTick = world.tick;
    const startX = world.players.posX[0] ?? 0;
    stage(world, 0, { moveX: 1, buttons: Buttons.Fire | Buttons.Jump });
    run(world, 30);
    // Gravity may still settle it, so only horizontal intent is asserted.
    expect(world.players.posX[0]).toBeCloseTo(startX, 6);
  });
});

describe('the sandbox is not a match', () => {
  it('is live at once, with no clock and no frag limit', () => {
    // Every sim test and the offline practice arena depend on this.
    const world = createMatch(createBoxMap(), 7);
    expect(world.match.phase).toBe(MatchPhase.Live);
    expect(world.match.timeLimitTicks).toBe(0);
    expect(world.match.fragLimit).toBe(0);
    expect(timeRemainingSeconds(world.match, world.tick)).toBe(Infinity);
  });

  it('never ends, however long it runs', () => {
    const world = ruledMatch(2, SANDBOX_RULES);
    world.players.kills[0] = 9999;
    run(world, 120);
    expect(world.match.phase).toBe(MatchPhase.Live);
    expect(world.match.winner).toBe(NO_WINNER);
  });
});

describe('winning', () => {
  it('ends the match when someone reaches the frag limit', () => {
    const world = ruledMatch(2, { warmup: false, fragLimit: 3, durationSeconds: 0 });
    world.players.kills[1] = 2;
    run(world, 1);
    expect(world.match.phase).toBe(MatchPhase.Live);

    world.players.kills[1] = 3;
    run(world, 1);
    expect(world.match.phase).toBe(MatchPhase.Over);
    expect(world.match.winner).toBe(1);
  });

  it('ends on the clock, awarding it to whoever led', () => {
    const world = ruledMatch(2, { warmup: false, fragLimit: 0, durationSeconds: 1 });
    world.players.kills[0] = 4;
    world.players.kills[1] = 1;
    run(world, SIM_HZ);
    expect(world.match.phase).toBe(MatchPhase.Over);
    expect(world.match.winner).toBe(0);
  });

  it('calls a level score a draw rather than crowning the lower slot', () => {
    // "Player 1 wins" on a drawn match is worse than saying it was drawn.
    const world = ruledMatch(2, { warmup: false, fragLimit: 0, durationSeconds: 1 });
    world.players.kills[0] = 2;
    world.players.kills[1] = 2;
    run(world, SIM_HZ);
    expect(world.match.phase).toBe(MatchPhase.Over);
    expect(world.match.winner).toBe(NO_WINNER);
  });

  it('ignores empty slots when deciding who leads', () => {
    const world = ruledMatch(2, { warmup: false, fragLimit: 0, durationSeconds: 1 });
    world.players.kills[1] = 1;
    // Slot 5 was never occupied; it must not count as a tied entrant on 0 frags.
    expect(leader(world)).toBe(1);
  });

  it('prefers the frag limit over the clock when both land on the same tick', () => {
    // A decisive win should read as a win, not as "time ran out".
    const world = ruledMatch(2, { warmup: false, fragLimit: 2, durationSeconds: 1 });
    world.players.kills[1] = 2;
    run(world, SIM_HZ);
    expect(world.match.winner).toBe(1);
  });

  it('stops scoring once the match is decided', () => {
    const world = ruledMatch(2, { warmup: false, fragLimit: 1, durationSeconds: 0 });
    world.players.kills[0] = 1;
    run(world, 1);
    expect(world.match.phase).toBe(MatchPhase.Over);
    const winner = world.match.winner;
    world.players.kills[1] = 50; // would win, if anything were still counting
    run(world, 10);
    expect(world.match.winner).toBe(winner);
  });
});

describe('mode rulesets', () => {
  it('resolves each mode, and falls back to FFA for a bad id', () => {
    expect(rulesetFor(GameMode.Ffa)).toBe(FFA_RULES);
    expect(rulesetFor(GameMode.Tdm)).toBe(TDM_RULES);
    expect(rulesetFor(99)).toBe(FFA_RULES);
    expect(rulesetFor(-1)).toBe(FFA_RULES);
  });

  it('FFA scores each player for themselves', () => {
    const world = ruledMatch(2, { warmup: false });
    world.players.kills[0] = 3;
    expect(FFA_RULES.fragsOf(world, 0)).toBe(3);
    expect(FFA_RULES.scoreOf(world, 0)).toBe(3 * TUNING.match.killScore);
    expect(FFA_RULES.entrantOf(world, 1)).toBe(1);
  });

  it('TDM balances teams on join', () => {
    const world = ruledMatch(4, { warmup: false, mode: GameMode.Tdm });
    const sizes = [0, 0];
    for (let i = 0; i < 4; i++) {
      const team = world.players.team[i] ?? 0;
      sizes[team] = (sizes[team] ?? 0) + 1;
    }
    expect(sizes, 'four players split evenly').toEqual([2, 2]);
  });

  it('TDM credits the killer’s team and docks a team kill', () => {
    const world = ruledMatch(4, { warmup: false, mode: GameMode.Tdm });
    const teamOf = (i: number): number => world.players.team[i] ?? 0;
    const enemy = [0, 1, 2, 3].find((i) => teamOf(i) !== teamOf(0));
    const mate = [1, 2, 3].find((i) => teamOf(i) === teamOf(0));
    if (enemy === undefined || mate === undefined) throw new Error('teams not split');

    TDM_RULES.onKill(world, 0, enemy);
    expect(world.match.teamFrags[teamOf(0)]).toBe(1);
    TDM_RULES.onKill(world, 0, mate);
    expect(world.match.teamFrags[teamOf(0)], 'a team kill costs a frag').toBe(0);
    // And it never goes negative, which would let a team farm its way back up.
    TDM_RULES.onKill(world, 0, mate);
    expect(world.match.teamFrags[teamOf(0)]).toBe(0);
  });

  it('credits nobody for a suicide', () => {
    const world = ruledMatch(2, { warmup: false, mode: GameMode.Tdm });
    TDM_RULES.onKill(world, NO_PLAYER, 1);
    TDM_RULES.onKill(world, 1, 1);
    expect([...world.match.teamFrags]).toEqual([0, 0]);
  });

  it('keeps a team score when the player who earned it disconnects', () => {
    // Summing players.kills on demand would silently lower the score on a quit.
    const world = ruledMatch(4, { warmup: false, mode: GameMode.Tdm });
    const team = world.players.team[0] ?? 0;
    const enemy = [1, 2, 3].find((i) => (world.players.team[i] ?? 0) !== team);
    if (enemy === undefined) throw new Error('teams not split');
    TDM_RULES.onKill(world, 0, enemy);
    world.players.connected[0] = 0;
    world.players.kills[0] = 0;
    expect(TDM_RULES.fragsOf(world, team)).toBe(1);
  });
});

describe('clocks come from ticks, never wall time', () => {
  it('counts the live phase down from its full duration', () => {
    const world = ruledMatch(2, { warmup: false, durationSeconds: 10, fragLimit: 0 });
    expect(timeRemainingSeconds(world.match, world.tick)).toBeCloseTo(10, 6);
    run(world, SIM_HZ * 4);
    expect(timeRemainingSeconds(world.match, world.tick)).toBeCloseTo(6, 6);
  });

  it('reports the full duration while still in warmup', () => {
    // A HUD showing 07:58 during the countdown looks like the match already started.
    const world = ruledMatch(2, { durationSeconds: 480 });
    run(world, 60);
    expect(timeRemainingSeconds(world.match, world.tick)).toBeCloseTo(480, 6);
  });

  it('counts the warmup down and reports 0 once live', () => {
    const world = ruledMatch(2);
    expect(warmupRemainingSeconds(world.match, world.tick)).toBeCloseTo(
      TUNING.match.warmupSeconds,
      6,
    );
    run(world, SIM_HZ);
    expect(warmupRemainingSeconds(world.match, world.tick)).toBeCloseTo(
      TUNING.match.warmupSeconds - 1,
      6,
    );
    run(world, SIM_HZ * TUNING.match.warmupSeconds);
    expect(world.match.phase).toBe(MatchPhase.Live);
    expect(warmupRemainingSeconds(world.match, world.tick)).toBe(0);
  });

  it('ends on the same tick given the same inputs', () => {
    const end = (): number => {
      const world = ruledMatch(2, { warmup: false, durationSeconds: 2, fragLimit: 0 });
      for (let t = 0; t < 10_000; t++) {
        stage(world, 0, { moveX: 1, buttons: Buttons.Jump });
        stepWorld(world);
        if (world.match.phase === MatchPhase.Over) return world.tick;
      }
      throw new Error('never ended');
    };
    expect(end()).toBe(end());
  });
});

describe('match state is real sim state', () => {
  it('survives a snapshot round trip', () => {
    const world = ruledMatch(2, { warmup: false, mode: GameMode.Tdm, fragLimit: 9 });
    world.match.teamFrags[1] = 4;
    world.match.winner = 1;
    run(world, 5);

    const snap = takeSnapshot(world, createSnapshot());
    const before = stateHash(world);
    // Trash every field, then restore.
    world.match.mode = GameMode.Ffa;
    world.match.phase = MatchPhase.Over;
    world.match.phaseStartTick = 999;
    world.match.timeLimitTicks = 1;
    world.match.fragLimit = 0;
    world.match.winner = NO_WINNER;
    world.match.teamFrags.fill(0);
    expect(stateHash(world), 'the hash must notice').not.toBe(before);

    restoreSnapshot(world, snap);
    expect(stateHash(world)).toBe(before);
    expect(world.match.mode).toBe(GameMode.Tdm);
    expect(world.match.fragLimit).toBe(9);
    expect([...world.match.teamFrags]).toEqual([0, 4]);
  });

  it('is covered by the state hash, field by field', () => {
    // A phase or clock desync is as fatal as a position desync, and would
    // otherwise pass every determinism test in the suite.
    const base = ruledMatch(2, { warmup: false });
    const mutations: ((w: SimWorld) => void)[] = [
      (w) => (w.match.mode = GameMode.Tdm),
      (w) => (w.match.phase = MatchPhase.Over),
      (w) => (w.match.phaseStartTick += 1),
      (w) => (w.match.timeLimitTicks += 1),
      (w) => (w.match.fragLimit += 1),
      (w) => (w.match.winner = 1),
      (w) => (w.match.teamFrags[0] = 3),
    ];
    for (const mutate of mutations) {
      const world = ruledMatch(2, { warmup: false });
      const before = stateHash(world);
      mutate(world);
      expect(stateHash(world), mutate.toString()).not.toBe(before);
    }
    expect(stateHash(base)).toBe(stateHash(ruledMatch(2, { warmup: false })));
  });
});

describe('rematch', () => {
  it('clears the scores and counts down again, without rebuilding the world', () => {
    const world = ruledMatch(2, { warmup: false, fragLimit: 1, durationSeconds: 0 });
    world.players.kills[0] = 1;
    world.players.deaths[1] = 1;
    run(world, 1);
    expect(world.match.phase).toBe(MatchPhase.Over);

    const firstPadArray = world.pads.all[0];
    if (firstPadArray === undefined) throw new Error('no pad pool');
    const padsBefore = [...firstPadArray];
    restartMatch(world);
    expect(world.match.phase).toBe(MatchPhase.Warmup);
    expect(world.match.winner).toBe(NO_WINNER);
    expect([...world.players.kills]).toEqual(new Array(world.players.kills.length).fill(0));
    expect([...world.players.deaths]).toEqual(new Array(world.players.deaths.length).fill(0));
    // Pads keep their stock: a rematch is not a fresh world, which is what lets a
    // networked match restart without re-running the join handshake.
    expect([...firstPadArray]).toEqual(padsBefore);
    // And it is playable again.
    run(world, Math.round(TUNING.match.warmupSeconds * SIM_HZ) + 1);
    expect(world.match.phase).toBe(MatchPhase.Live);
  });
});

describe('configureMatch input handling', () => {
  it('clamps nonsense rather than trusting it', () => {
    const world = createMatch(createBoxMap(), 1);
    configureMatch(world.match, 0, { durationSeconds: -5, fragLimit: -3 });
    expect(world.match.timeLimitTicks).toBe(0);
    expect(world.match.fragLimit).toBe(0);
    configureMatch(world.match, 0, { fragLimit: 7.9 });
    expect(world.match.fragLimit, 'a fractional frag limit is meaningless').toBe(7);
  });
});

describe('match state over the wire', () => {
  it('round-trips the match block and the scoreboard fields', () => {
    // A client with no score and no clock cannot draw a HUD or a scoreboard, and
    // the failure mode is a match that looks like it never started.
    const world = ruledMatch(3, { warmup: false, mode: GameMode.Tdm, fragLimit: 11 });
    world.players.kills[0] = 7;
    world.players.deaths[1] = 4;
    world.match.teamFrags[1] = 6;
    world.match.winner = 1;
    run(world, 9);

    const snap = captureSnapshot(world, 42);
    const decoded = decodeSnapshot(encodeSnapshot(snap, null));

    expect(decoded.match).toEqual(snap.match);
    expect(decoded.match.mode).toBe(GameMode.Tdm);
    expect(decoded.match.fragLimit).toBe(11);
    expect(decoded.match.teamFrags[1]).toBe(6);
    const first = decoded.players.find((r) => r.id === 0);
    const second = decoded.players.find((r) => r.id === 1);
    expect(first?.kills).toBe(7);
    expect(second?.deaths).toBe(4);
    expect(first?.team).toBe(world.players.team[0]);
  });

  it('encodes NO_WINNER as a negative, not as entrant 255', () => {
    const world = ruledMatch(2, { warmup: false });
    expect(world.match.winner).toBe(NO_WINNER);
    const decoded = decodeSnapshot(encodeSnapshot(captureSnapshot(world, 0), null));
    expect(decoded.match.winner).toBe(NO_WINNER);
  });

  it('ships a frag change through the delta rather than swallowing it', () => {
    // The delta only sends players that changed; if the comparison ignored kills,
    // a frag would never reach a client whose position had not moved.
    const world = ruledMatch(2, { warmup: false });
    const baseline = captureSnapshot(world, 0);
    world.players.kills[0] = (world.players.kills[0] ?? 0) + 1;
    const next = captureSnapshot(world, 1);

    const delta = decodeSnapshot(encodeSnapshot(next, baseline));
    expect(
      delta.players.map((r) => r.id),
      'slot 0 is in the delta',
    ).toContain(0);
    expect(applyDelta(baseline, delta).players.find((r) => r.id === 0)?.kills).toBe(1);
  });

  it('projects the match and the score into a client world', () => {
    const host = ruledMatch(2, { warmup: false, mode: GameMode.Tdm, fragLimit: 5 });
    host.players.kills[1] = 3;
    host.match.teamFrags[0] = 2;
    run(host, 12);

    const client = createMatch(createBoxMap(), 99); // a sandbox world, deliberately
    applySnapshotToWorld(client, captureSnapshot(host, 0));

    expect(client.match.mode).toBe(GameMode.Tdm);
    expect(client.match.phase).toBe(host.match.phase);
    expect(client.match.phaseStartTick).toBe(host.match.phaseStartTick);
    expect(client.match.fragLimit).toBe(5);
    expect([...client.match.teamFrags]).toEqual([...host.match.teamFrags]);
    expect(client.players.kills[1]).toBe(3);
    // And the derived clock therefore agrees with the host's.
    expect(timeRemainingSeconds(client.match, client.tick)).toBeCloseTo(
      timeRemainingSeconds(host.match, host.tick),
      6,
    );
  });
});
