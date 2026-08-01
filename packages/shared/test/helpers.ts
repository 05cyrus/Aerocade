import {
  addPlayer,
  Buttons,
  createFoundryMap,
  createWorld,
  parseAsciiMap,
  setInput,
  stepWorld,
  type ButtonMask,
  type MapDef,
  type SimWorld,
} from '../src/index.js';

/** A sealed 20×12 box room: flat floor, no obstacles. Predictable physics. */
export function createBoxMap(): MapDef {
  const rows: string[] = [];
  const width = 20;
  const height = 12;
  for (let y = 0; y < height; y++) {
    if (y === 0 || y === height - 1) {
      rows.push('#'.repeat(width));
    } else if (y === height - 2) {
      rows.push('#' + '.S..............S.'.slice(0, width - 2) + '#');
    } else {
      rows.push('#' + '.'.repeat(width - 2) + '#');
    }
  }
  return parseAsciiMap('box', 'Box', rows);
}

export function createTestWorld(map: MapDef = createBoxMap(), seed = 1234): SimWorld {
  return createWorld(map, seed);
}

export interface StagedInput {
  moveX?: number;
  moveY?: number;
  aim?: number;
  buttons?: ButtonMask;
}

/** Stage a player's input for the next step(s). */
export function stage(world: SimWorld, player: number, input: StagedInput): void {
  setInput(world, player, {
    seq: world.tick,
    moveX: input.moveX ?? 0,
    moveY: input.moveY ?? 0,
    aim: input.aim ?? 0,
    buttons: input.buttons ?? 0,
  });
}

/** Step `n` ticks with whatever inputs are currently staged. */
export function run(world: SimWorld, n: number): void {
  for (let i = 0; i < n; i++) stepWorld(world);
}

/** Add a player and clear their spawn protection (most tests want combat live). */
export function addCombatant(world: SimWorld): number {
  const slot = addPlayer(world);
  world.players.protect[slot] = 0;
  return slot;
}

/** Place a player at an exact position, zeroing velocity. */
export function teleport(world: SimWorld, player: number, x: number, y: number): void {
  world.players.posX[player] = x;
  world.players.posY[player] = y;
  world.players.velX[player] = 0;
  world.players.velY[player] = 0;
}

export { Buttons, createFoundryMap, stepWorld };
