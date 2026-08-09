import { useEffect, useState, type ReactElement } from 'react';
import { appStore, useAppState } from '../store.js';
import {
  ACTION_LABELS,
  ALL_ACTIONS,
  assignBinding,
  BINDING_SLOTS,
  clearBinding,
  DEFAULT_BINDINGS,
  describeCode,
  findConflicts,
  mouseCode,
  type InputAction,
} from '../../game/input/bindings.js';

/**
 * Keybinding table with "press any key" capture (docs/ui.md §6).
 *
 * Capture listens on `KeyboardEvent.code` so bindings are layout-independent,
 * and on mouse buttons too, since Fire and Melee live there by default.
 *
 * Conflicts are **warned about, not blocked**. Refusing the keystroke would
 * leave a player mid-rebind holding a key they cannot place; instead a rebind
 * steals the code from whoever else had it, and any remaining duplicate is
 * called out inline so it can be fixed in any order.
 */
export function Keybinds(): ReactElement {
  const bindings = useAppState((s) => s.settings.bindings);
  /** Which slot is currently capturing, or null. */
  const [capturing, setCapturing] = useState<{ action: InputAction; slot: number } | null>(null);
  const conflicts = findConflicts(bindings);

  useEffect(() => {
    if (capturing === null) return undefined;

    const finish = (code: string): void => {
      appStore.patchSettings({
        bindings: assignBinding(bindings, capturing.action, capturing.slot, code),
      });
      setCapturing(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      e.preventDefault();
      // Escape cancels rather than binding itself, or a player could trap
      // themselves in a modal whose only exit is the key they just consumed.
      if (e.code === 'Escape') setCapturing(null);
      else finish(e.code);
    };
    const onMouse = (e: MouseEvent): void => {
      e.preventDefault();
      finish(mouseCode(e.button));
    };
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('mousedown', onMouse, { capture: true });
    window.addEventListener('contextmenu', onMouse, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
      window.removeEventListener('mousedown', onMouse, { capture: true });
      window.removeEventListener('contextmenu', onMouse, { capture: true });
    };
  }, [capturing, bindings]);

  return (
    <section className="settings-group">
      <h2>Controls</h2>
      {capturing !== null && (
        <p className="settings-capture" role="status">
          Press any key or mouse button for <b>{ACTION_LABELS[capturing.action]}</b> — Esc to cancel
        </p>
      )}
      <table className="keybinds">
        <tbody>
          {ALL_ACTIONS.map((action) => (
            <tr key={action}>
              <th scope="row">{ACTION_LABELS[action]}</th>
              {Array.from({ length: BINDING_SLOTS }, (_, slot) => {
                const code = bindings[action][slot];
                const clash = code !== undefined && conflicts.has(code);
                const active = capturing?.action === action && capturing.slot === slot;
                return (
                  <td key={slot}>
                    <button
                      type="button"
                      className={`keybind${active ? ' capturing' : ''}${clash ? ' clash' : ''}`}
                      onClick={() => {
                        setCapturing({ action, slot });
                      }}
                    >
                      {active ? '…' : code === undefined ? '—' : describeCode(code)}
                    </button>
                    {code !== undefined && (
                      <button
                        type="button"
                        className="keybind-clear"
                        aria-label={`Clear ${ACTION_LABELS[action]} binding ${String(slot + 1)}`}
                        onClick={() => {
                          appStore.patchSettings({
                            bindings: clearBinding(bindings, action, slot),
                          });
                        }}
                      >
                        ×
                      </button>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {conflicts.size > 0 && (
        <p className="settings-warn" role="alert">
          Bound twice:{' '}
          {[...conflicts.entries()]
            .map(
              ([code, actions]) =>
                `${describeCode(code)} (${actions.map((a) => ACTION_LABELS[a]).join(', ')})`,
            )
            .join('; ')}
        </p>
      )}
      <p className="settings-note">
        Scope only reframes the camera, so it never reaches the simulation. Movement keys are an
        axis rather than a button.
      </p>
      <button
        type="button"
        onClick={() => {
          appStore.patchSettings({ bindings: DEFAULT_BINDINGS });
        }}
      >
        Reset controls to defaults
      </button>
    </section>
  );
}
