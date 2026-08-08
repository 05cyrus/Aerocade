import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { Buttons, TUNING } from '@aerocade/shared';
import {
  fireHeld,
  moveAxis,
  resolveStick,
  STICK_DEADZONE,
  STICK_RADIUS_PX,
  JET_THRESHOLD,
} from '../../game/input/stick.js';
import { touchInput } from '../../game/input/TouchInput.js';

/**
 * Mobile twin-stick control layer (docs/ui.md §5).
 *
 * Left 40% of the viewport is the move stick, right 40% the aim stick, with a
 * centre dead strip so a stray thumb in the middle grabs nothing. Both sticks
 * spawn where the finger lands rather than sitting at a fixed base, which is
 * what makes them usable without looking.
 *
 * Pointer ids are captured per stick, so two thumbs plus a button press never
 * fight over one handler — the layer tolerates the spec's five concurrent
 * touches because each pointer is routed by id, not by "the active pointer".
 *
 * Only the visual ring state lives in React. The values the simulation reads go
 * straight into `touchInput`, because re-rendering on every pointermove would
 * put React on the game loop's schedule (docs/ui.md §4).
 */

interface StickState {
  pointerId: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
}

/** Ring positions, re-rendered only while a stick is actually held. */
interface Visual {
  originX: number;
  originY: number;
  knobX: number;
  knobY: number;
}

export function TouchControls(): ReactElement {
  const move = useRef<StickState | null>(null);
  const aim = useRef<StickState | null>(null);
  const firing = useRef(false);
  const [moveVisual, setMoveVisual] = useState<Visual | null>(null);
  const [aimVisual, setAimVisual] = useState<Visual | null>(null);

  // Releasing everything on unmount matters: a held stick would otherwise latch
  // the player into running forever after leaving the sandbox.
  useEffect(
    () => () => {
      touchInput.reset();
    },
    [],
  );

  const applyMove = (stick: StickState | null): void => {
    if (stick === null) {
      touchInput.clearMove();
      touchInput.release(Buttons.Walk | Buttons.Jump | Buttons.Thrust);
      return;
    }
    const axis = moveAxis(stick.x, TUNING.player.walkSpeed, TUNING.player.runSpeed);
    touchInput.setMove(axis.moveX, stick.y);
    if (axis.walk) touchInput.press(Buttons.Walk);
    else touchInput.release(Buttons.Walk);
    // Pushing up is an alternate jetpack input, so a player can fly one-thumbed.
    if (-stick.y >= JET_THRESHOLD) touchInput.press(Buttons.Jump | Buttons.Thrust);
    else touchInput.release(Buttons.Jump | Buttons.Thrust);
  };

  const applyAim = (stick: StickState | null): void => {
    if (stick === null) {
      touchInput.setAim(null);
      touchInput.release(Buttons.Fire);
      firing.current = false;
      return;
    }
    const magnitude = Math.hypot(stick.x, stick.y);
    // Aim only updates above the deadzone: letting a resting thumb write an
    // angle would snap the soldier's aim to wherever the finger happened to sit.
    if (magnitude > 0) touchInput.setAim(Math.atan2(stick.y, stick.x));
    const held = fireHeld(magnitude, firing.current);
    firing.current = held;
    if (held) touchInput.press(Buttons.Fire);
    else touchInput.release(Buttons.Fire);
  };

  const beginStick = (slot: 'move' | 'aim', e: ReactPointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const state: StickState = {
      pointerId: e.pointerId,
      originX: e.clientX,
      originY: e.clientY,
      x: 0,
      y: 0,
    };
    const visual: Visual = {
      originX: e.clientX,
      originY: e.clientY,
      knobX: e.clientX,
      knobY: e.clientY,
    };
    if (slot === 'move') {
      move.current = state;
      setMoveVisual(visual);
      applyMove(state);
    } else {
      aim.current = state;
      setAimVisual(visual);
      applyAim(state);
    }
  };

  const dragStick = (slot: 'move' | 'aim', e: ReactPointerEvent<HTMLDivElement>): void => {
    const ref = slot === 'move' ? move : aim;
    const stick = ref.current;
    if (stick === null) return;
    // Route strictly by pointer id: with two thumbs down, the other stick's
    // moves also arrive here, and honouring them would cross-wire the sticks.
    if (stick.pointerId !== e.pointerId) return;
    const s = resolveStick(stick.originX, stick.originY, e.clientX, e.clientY);
    stick.originX = s.originX;
    stick.originY = s.originY;
    stick.x = s.x;
    stick.y = s.y;
    const visual: Visual = {
      originX: s.originX,
      originY: s.originY,
      knobX: s.originX + s.x * STICK_RADIUS_PX,
      knobY: s.originY + s.y * STICK_RADIUS_PX,
    };
    if (slot === 'move') {
      setMoveVisual(visual);
      applyMove(stick);
    } else {
      setAimVisual(visual);
      applyAim(stick);
    }
  };

  const endStick = (slot: 'move' | 'aim', e: ReactPointerEvent<HTMLDivElement>): void => {
    const ref = slot === 'move' ? move : aim;
    if (ref.current?.pointerId !== e.pointerId) return;
    ref.current = null;
    if (slot === 'move') {
      setMoveVisual(null);
      applyMove(null);
    } else {
      setAimVisual(null);
      applyAim(null);
    }
  };

  const zone = (slot: 'move' | 'aim'): Record<string, unknown> => ({
    onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      beginStick(slot, e);
    },
    onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => {
      dragStick(slot, e);
    },
    onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => {
      endStick(slot, e);
    },
    // A cancel is as final as an up (browser gesture, call interrupt), and
    // ignoring it is how a stick gets stuck fully deflected.
    onPointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => {
      endStick(slot, e);
    },
    onLostPointerCapture: (e: ReactPointerEvent<HTMLDivElement>) => {
      endStick(slot, e);
    },
  });

  const button = (label: string, glyph: string, bit: number): ReactElement => (
    <button
      key={label}
      type="button"
      className="touch-btn"
      aria-label={label}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        touchInput.press(bit);
      }}
      onPointerUp={() => {
        touchInput.release(bit);
      }}
      onPointerCancel={() => {
        touchInput.release(bit);
      }}
      onLostPointerCapture={() => {
        touchInput.release(bit);
      }}
    >
      <span aria-hidden="true">{glyph}</span>
    </button>
  );

  return (
    <>
      {/* Landscape is requested by the manifest (ADR-007); where a browser
          ignores it, this blocks play rather than handing the player a layout
          with no room for two sticks. CSS decides when it is visible. */}
      <div className="rotate-prompt" role="alert">
        <div>ROTATE YOUR DEVICE</div>
        <div>Aerocade plays in landscape</div>
      </div>
      <div className="touch-layer">
        <div className="touch-zone touch-zone-move" {...zone('move')} />
        <div className="touch-zone touch-zone-aim" {...zone('aim')} />

        {[
          { visual: moveVisual, key: 'm' },
          { visual: aimVisual, key: 'a' },
        ].map(({ visual, key }) =>
          visual === null ? null : (
            <div key={key} aria-hidden="true">
              <span
                className="stick-ring"
                style={{
                  left: visual.originX,
                  top: visual.originY,
                  width: STICK_RADIUS_PX * 2,
                  height: STICK_RADIUS_PX * 2,
                }}
              />
              <span
                className="stick-dead"
                style={{
                  left: visual.originX,
                  top: visual.originY,
                  width: STICK_RADIUS_PX * 2 * STICK_DEADZONE,
                  height: STICK_RADIUS_PX * 2 * STICK_DEADZONE,
                }}
              />
              <span className="stick-knob" style={{ left: visual.knobX, top: visual.knobY }} />
            </div>
          ),
        )}

        <div className="touch-cluster">
          {button('Jetpack', '▲', Buttons.Jump | Buttons.Thrust)}
          {button('Grenade', '✸', Buttons.Grenade)}
          {button('Reload', '⟳', Buttons.Reload)}
          {button('Melee', '✖', Buttons.Melee)}
        </div>
      </div>
    </>
  );
}
