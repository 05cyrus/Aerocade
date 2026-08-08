import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards a real bug: the touch control layer's stick zones are full-height
 * halves of the screen, so if they ever stack above the HUD they swallow every
 * tap meant for the scope, pickup and mute buttons. That shipped once — the
 * symptom was "can't click scope on mobile", and the pickup button was broken
 * too, which is how weapons are taken on a phone.
 *
 * It is checked as a CSS invariant rather than in a browser because it is a
 * stacking-order rule, and because Playwright is deliberately not a test
 * dependency until the networking milestone (docs/testing.md).
 */

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');

/** First `z-index` declared inside a rule, or null if the rule sets none. */
function zIndexOf(selector: string): number | null {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(css);
  if (rule === null) throw new Error(`no CSS rule for ${selector}`);
  const match = /z-index:\s*(-?\d+)/.exec(rule[1] ?? '');
  return match === null ? null : Number(match[1]);
}

describe('HUD stacks above the touch control layer', () => {
  it('declares a z-index on both layers', () => {
    // A missing z-index is the failure mode: the HUD had none, so DOM order let
    // the touch layer win.
    expect(zIndexOf('.hud'), '.hud needs an explicit z-index').not.toBeNull();
    expect(zIndexOf('.touch-layer'), '.touch-layer needs an explicit z-index').not.toBeNull();
  });

  it('puts the HUD above the stick zones, so its buttons win a tap', () => {
    const hud = zIndexOf('.hud');
    const touch = zIndexOf('.touch-layer');
    if (hud === null || touch === null) throw new Error('missing z-index');
    expect(hud).toBeGreaterThan(touch);
  });

  it('keeps the rotate prompt above everything', () => {
    const prompt = zIndexOf('.rotate-prompt');
    const hud = zIndexOf('.hud');
    if (prompt === null || hud === null) throw new Error('missing z-index');
    // It blocks play in portrait; a HUD button poking through would let a
    // player fire from an unusable layout.
    expect(prompt).toBeGreaterThan(hud);
  });

  it('leaves the HUD root transparent to pointers', () => {
    // Raising the HUD is only safe because its root ignores pointers and only
    // interactive children re-enable them (docs/ui.md §1). Without this the HUD
    // would block the sticks and the canvas entirely.
    const rule = /\.hud\s*\{([^}]*)\}/.exec(css);
    expect(rule?.[1]).toMatch(/pointer-events:\s*none/);
  });
});
