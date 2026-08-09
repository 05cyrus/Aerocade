import { describe, expect, it } from 'vitest';
import { addPlayer } from '../src/sim/spawns.js';
import { createMatch } from '../src/sim/match.js';
import { DEFAULT_MATCH_RULES } from '../src/sim/match/state.js';
import { createBoxMap } from './helpers.js';

/**
 * The lobby badges the host by comparing against slot 0, and a joining client is
 * told nothing else about who the host is. That shortcut is only safe because the
 * host adds itself to a brand-new world before the room exists, so this pins the
 * assumption rather than leaving it implicit.
 */
describe('the host holds slot 0', () => {
  it('is the first slot a fresh world hands out', () => {
    const world = createMatch(createBoxMap(), 1, DEFAULT_MATCH_RULES);
    expect(addPlayer(world)).toBe(0);
    expect(addPlayer(world), 'joiners come after').toBe(1);
  });
});
