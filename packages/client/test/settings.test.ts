import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from '../src/game/input/bindings.js';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  SETTINGS_LIMITS,
  SETTINGS_VERSION,
  type Settings,
} from '../src/app/settings.js';

/**
 * A settings record is the only state that arrives from outside the program —
 * written by an older build, hand-edited in devtools, or truncated by a crash.
 * `normalizeSettings` is the boundary, so these tests hammer it with the shapes
 * that actually turn up rather than the happy path.
 */

describe('normalizeSettings: garbage in, valid settings out', () => {
  // Labelled explicitly: JSON.stringify(undefined) is itself undefined, so
  // building these names from it would print an empty test title.
  const junkCases: [string, unknown][] = [
    ['null', null],
    ['undefined', undefined],
    ['a number', 0],
    ['a string', 'nope'],
    ['an array', []],
    ['a boolean', true],
    ['NaN', NaN],
  ];
  for (const [label, junk] of junkCases) {
    it(`falls back to defaults for ${label}`, () => {
      expect(normalizeSettings(junk)).toEqual(DEFAULT_SETTINGS);
    });
  }

  it('never throws, whatever it is handed', () => {
    const nasty: unknown[] = [
      { sfxVolume: 'loud' },
      { controlScale: null },
      { playerName: 42 },
      { muted: 'yes' },
      { version: 'v9' },
      Object.create(null),
    ];
    for (const value of nasty) expect(() => normalizeSettings(value)).not.toThrow();
  });

  it('always stamps the current version, so a stale one cannot linger', () => {
    expect(normalizeSettings({ version: -5 }).version).toBe(SETTINGS_VERSION);
  });
});

describe('normalizeSettings: clamping', () => {
  it('clamps volume into range instead of trusting it', () => {
    expect(normalizeSettings({ sfxVolume: 999 }).sfxVolume).toBe(SETTINGS_LIMITS.sfxVolume.max);
    expect(normalizeSettings({ sfxVolume: -40 }).sfxVolume).toBe(SETTINGS_LIMITS.sfxVolume.min);
  });

  it('keeps volume an integer', () => {
    expect(normalizeSettings({ sfxVolume: 41.7 }).sfxVolume).toBe(42);
  });

  it('clamps control scale into range', () => {
    expect(normalizeSettings({ controlScale: 9 }).controlScale).toBe(
      SETTINGS_LIMITS.controlScale.max,
    );
    expect(normalizeSettings({ controlScale: 0.1 }).controlScale).toBe(
      SETTINGS_LIMITS.controlScale.min,
    );
  });

  it('rejects non-finite numbers rather than clamping them', () => {
    // Infinity would survive a naive min/max and silently become the limit;
    // NaN would poison every comparison downstream.
    expect(normalizeSettings({ sfxVolume: Infinity }).sfxVolume).toBe(DEFAULT_SETTINGS.sfxVolume);
    expect(normalizeSettings({ controlScale: NaN }).controlScale).toBe(
      DEFAULT_SETTINGS.controlScale,
    );
  });
});

describe('normalizeSettings: player name', () => {
  it('truncates to the maximum length', () => {
    const long = 'x'.repeat(SETTINGS_LIMITS.nameMaxLength + 20);
    expect(normalizeSettings({ playerName: long }).playerName).toHaveLength(
      SETTINGS_LIMITS.nameMaxLength,
    );
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeSettings({ playerName: '  Ace  ' }).playerName).toBe('Ace');
  });

  it('falls back for an empty or whitespace-only name', () => {
    // A blank name renders as an empty kill-feed entry, which reads as a bug.
    expect(normalizeSettings({ playerName: '' }).playerName).toBe(DEFAULT_SETTINGS.playerName);
    expect(normalizeSettings({ playerName: '   ' }).playerName).toBe(DEFAULT_SETTINGS.playerName);
  });

  it('ignores a non-string name', () => {
    expect(normalizeSettings({ playerName: 99 }).playerName).toBe(DEFAULT_SETTINGS.playerName);
  });
});

describe('normalizeSettings: migration behaviour', () => {
  it('keeps valid fields from a partial (older) record', () => {
    const older = { version: 0, sfxVolume: 25, leftHanded: true };
    const result = normalizeSettings(older);
    expect(result.sfxVolume).toBe(25);
    expect(result.leftHanded).toBe(true);
    // Fields the old record never had take defaults, so adding a setting can
    // never invalidate someone's saved preferences.
    expect(result.playerName).toBe(DEFAULT_SETTINGS.playerName);
    expect(result.reducedShake).toBe(DEFAULT_SETTINGS.reducedShake);
  });

  it('drops unknown fields rather than carrying them forward', () => {
    const withExtra = { ...DEFAULT_SETTINGS, aimSensitivity: 1.8, legacyJunk: 'x' };
    expect(normalizeSettings(withExtra)).toEqual(DEFAULT_SETTINGS);
  });

  it('gives a v1 record (no bindings) the default bindings', () => {
    // The migration that mattered in practice: v1 predates keybinding support.
    const v1 = { version: 1, playerName: 'Old', sfxVolume: 30 };
    expect(normalizeSettings(v1).bindings).toEqual(DEFAULT_BINDINGS);
    expect(normalizeSettings(v1).playerName).toBe('Old');
  });

  it('is idempotent — normalising twice changes nothing', () => {
    const once = normalizeSettings({ sfxVolume: 33.4, playerName: '  Pilot Two  ' });
    expect(normalizeSettings(once)).toEqual(once);
  });

  it('round-trips a fully valid record unchanged', () => {
    const custom: Settings = {
      version: SETTINGS_VERSION,
      playerName: 'Vega',
      sfxVolume: 45,
      muted: true,
      controlScale: 1.2,
      leftHanded: true,
      reducedShake: true,
      bindings: DEFAULT_BINDINGS,
    };
    expect(normalizeSettings(custom)).toEqual(custom);
  });
});

describe('defaults are sane', () => {
  it('are themselves valid', () => {
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('start audible but not at full blast, and unmuted', () => {
    expect(DEFAULT_SETTINGS.muted).toBe(false);
    expect(DEFAULT_SETTINGS.sfxVolume).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.sfxVolume).toBeLessThan(SETTINGS_LIMITS.sfxVolume.max);
  });

  it('start with unmirrored controls at neutral scale', () => {
    expect(DEFAULT_SETTINGS.controlScale).toBe(1);
    expect(DEFAULT_SETTINGS.leftHanded).toBe(false);
  });
});
