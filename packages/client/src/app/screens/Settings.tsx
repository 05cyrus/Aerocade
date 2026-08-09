import type { ReactElement } from 'react';
import { appStore, useAppState } from '../store.js';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS } from '../settings.js';
import { Keybinds } from './Keybinds.js';

/**
 * Settings screen (docs/ui.md §6): one scrollable grouped list where every
 * change applies **live** and is persisted immediately — there is no Save
 * button, so a change can never be silently lost by backing out.
 *
 * Only settings with a real consumer are shown. **Aim sensitivity** is absent on
 * purpose rather than stubbed: Aerocade aims absolutely (the mouse aims at a
 * world point, the stick reports a direction), so there is no relative delta a
 * multiplier could act on.
 *
 * Keybind remapping lives in `Keybinds.tsx`. It became possible once
 * `KeyboardMouseInput` started resolving actions through a binding table instead
 * of hard-coded key codes.
 */
export function Settings(): ReactElement {
  const s = useAppState((st) => st.settings);

  return (
    <div className="menu settings">
      <h1>SETTINGS</h1>

      <section className="settings-group">
        <h2>Player</h2>
        <label className="settings-row" htmlFor="set-name">
          <span>Display name</span>
          <input
            id="set-name"
            type="text"
            value={s.playerName}
            maxLength={SETTINGS_LIMITS.nameMaxLength}
            onChange={(e) => {
              appStore.patchSettings({ playerName: e.target.value });
            }}
          />
        </label>
        <p className="settings-note">Shown in the kill feed in place of “You”.</p>
      </section>

      <section className="settings-group">
        <h2>Audio</h2>
        <label className="settings-row" htmlFor="set-sfx">
          <span>SFX volume</span>
          <input
            id="set-sfx"
            type="range"
            min={SETTINGS_LIMITS.sfxVolume.min}
            max={SETTINGS_LIMITS.sfxVolume.max}
            step={1}
            value={s.sfxVolume}
            onChange={(e) => {
              appStore.patchSettings({ sfxVolume: Number(e.target.value) });
            }}
          />
          <output>{s.sfxVolume}</output>
        </label>
        <label className="settings-row" htmlFor="set-mute">
          <span>Mute all sound</span>
          <input
            id="set-mute"
            type="checkbox"
            checked={s.muted}
            onChange={(e) => {
              appStore.patchSettings({ muted: e.target.checked });
            }}
          />
        </label>
        <p className="settings-note">
          Music is not implemented yet, so there is no separate music slider.
        </p>
      </section>

      <section className="settings-group">
        <h2>Layout</h2>
        <label className="settings-row" htmlFor="set-scale">
          <span>Touch control scale</span>
          <input
            id="set-scale"
            type="range"
            min={SETTINGS_LIMITS.controlScale.min}
            max={SETTINGS_LIMITS.controlScale.max}
            step={0.05}
            value={s.controlScale}
            onChange={(e) => {
              appStore.patchSettings({ controlScale: Number(e.target.value) });
            }}
          />
          <output>{s.controlScale.toFixed(2)}×</output>
        </label>
        <label className="settings-row" htmlFor="set-lefty">
          <span>Left-handed (mirror sticks)</span>
          <input
            id="set-lefty"
            type="checkbox"
            checked={s.leftHanded}
            onChange={(e) => {
              appStore.patchSettings({ leftHanded: e.target.checked });
            }}
          />
        </label>
        <p className="settings-note">Applies to the on-screen controls on touch devices.</p>
      </section>

      <Keybinds />

      <section className="settings-group">
        <h2>Accessibility</h2>
        <label className="settings-row" htmlFor="set-shake">
          <span>Reduced screen shake</span>
          <input
            id="set-shake"
            type="checkbox"
            checked={s.reducedShake}
            onChange={(e) => {
              appStore.patchSettings({ reducedShake: e.target.checked });
            }}
          />
        </label>
        <p className="settings-note">
          Damps shake to a quarter rather than removing it, so explosions still register.
        </p>
      </section>

      <div className="settings-actions">
        <button
          type="button"
          onClick={() => {
            appStore.patchSettings({ ...DEFAULT_SETTINGS });
          }}
        >
          Reset to defaults
        </button>
        <button
          type="button"
          onClick={() => {
            appStore.setScreen('menu');
          }}
        >
          ← Back
        </button>
      </div>
    </div>
  );
}
