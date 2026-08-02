import Phaser from 'phaser';
import {
  Buttons,
  DEFAULT_LOADOUT,
  SIM_DT,
  SimEventType,
  TUNING,
  WEAPON_SLOTS,
  addPlayer,
  createFoundryMap,
  createMatch,
  findPickupUnderPlayer,
  PickupKind,
  setInput,
  stepWorld,
  weaponDef,
  type SimWorld,
  type WeaponId,
} from '@aerocade/shared';
import { appStore, type HudState } from '../app/store.js';
import { KeyboardMouseInput } from './input/KeyboardMouseInput.js';
import { ArenaScene, type SceneDriver } from './render/ArenaScene.js';
import { RenderInterpolator } from './render/RenderInterpolator.js';

/** Never simulate more than this many ticks per frame (tab-restore spiral guard). */
const MAX_CATCHUP_TICKS = 8;
/** HUD refresh cadence in sim ticks (10 Hz). */
const HUD_EVERY_TICKS = 6;

const DUMMY_NAMES = ['Bolt Dummy', 'Rivet Dummy'];

/** Dev-only inspection surface used by the screenshot/e2e harness. */
export interface AeroDebug {
  world: SimWorld;
  localPlayer: number;
  /** Local player's position in canvas pixels, for framing screenshots. */
  screenPos: () => { x: number; y: number } | null;
  fps: () => number;
}

declare global {
  interface Window {
    /** Dev-only handle for automated smoke tests (never set in production builds). */
    __aeroDebug?: AeroDebug;
  }
}

/**
 * A local sandbox match: the full deterministic sim, the local player, and
 * two practice dummies, rendered by Phaser. This is the exact sim + loop the
 * networked host runs in M2 — only input sources change (docs/architecture.md).
 */
export class GameSession implements SceneDriver {
  private readonly world: SimWorld;
  private readonly localPlayer: number;
  private readonly dummies: number[] = [];
  private readonly input = new KeyboardMouseInput();
  private readonly interp = new RenderInterpolator();
  private game: Phaser.Game | null = null;
  private scene: ArenaScene | null = null;
  private accumulator = 0;
  private lastAim = 0;
  private lastFrameAt = 0;
  /** Scoped view. Client-only camera state — never reaches the sim (ADR-016). */
  private scoped = false;
  private destroyed = false;

  constructor(parent: HTMLElement) {
    appStore.reset(); // no HUD/kill-feed state may leak from a previous match
    // The sandbox is local-only; wall-clock seeding is fine (the sim itself
    // stays deterministic per seed — networked seeds come from the host).
    this.world = createMatch(createFoundryMap(), Date.now() >>> 0);
    this.localPlayer = addPlayer(this.world);
    this.dummies.push(addPlayer(this.world), addPlayer(this.world));

    this.input.attach();
    if (import.meta.env.DEV) {
      window.__aeroDebug = {
        world: this.world,
        localPlayer: this.localPlayer,
        screenPos: () => this.scene?.worldToScreen(this.localPlayer) ?? null,
        fps: () => this.game?.loop.actualFps ?? 0,
      };
    }
    const scene = new ArenaScene(this, this.world, this.localPlayer);
    this.game = new Phaser.Game({
      type: Phaser.AUTO,
      parent,
      backgroundColor: '#0b1020',
      banner: false,
      audio: { noAudio: true },
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
      scene,
    });
  }

  onSceneReady(scene: ArenaScene): void {
    this.scene = scene;
    this.interp.capture(this.world); // both buffers start at spawn state
    this.interp.capture(this.world);
    this.publishHud(); // the HUD must show this match from the first frame
  }

  onFrame(_phaserDeltaMs: number): void {
    if (this.destroyed || this.scene === null) return;

    // Measure real elapsed time ourselves: Phaser's delta is smoothed, and
    // under heavy render jank it under-reports — which would silently run
    // the simulation slower than wall-clock time.
    const now = performance.now();
    const deltaMs = this.lastFrameAt === 0 ? SIM_DT * 1000 : now - this.lastFrameAt;
    this.lastFrameAt = now;

    this.accumulator += Math.min(deltaMs, 250) / 1000;
    let steps = 0;
    while (this.accumulator >= SIM_DT && steps < MAX_CATCHUP_TICKS) {
      this.tick();
      this.accumulator -= SIM_DT;
      steps += 1;
    }
    if (steps === MAX_CATCHUP_TICKS) this.accumulator = 0; // drop backlog, stay live

    const alpha = this.accumulator / SIM_DT;
    this.scene.renderFrame(this.interp, alpha, deltaMs);
  }

  private tick(): void {
    const scene = this.scene;
    if (scene === null) return;

    const sampled = this.input.sample();
    // The on-screen pickup button feeds the same input path as the E key, so
    // the simulation cannot tell tap from keypress.
    const buttons = sampled.buttons | (appStore.consumeInteract() ? Buttons.Interact : 0);
    // Scope is presentation: the Z key and the on-screen button both flip a
    // client flag the camera reads; nothing about it enters the simulation.
    if (sampled.scopeToggled || appStore.consumeScopeToggle()) {
      this.scoped = !this.scoped;
    }
    scene.setScoped(this.scoped);
    this.lastAim = scene.computeAimFor(this.localPlayer, this.interp);
    setInput(this.world, this.localPlayer, {
      seq: this.world.tick,
      moveX: sampled.moveX,
      moveY: sampled.moveY,
      aim: this.lastAim,
      buttons,
    });
    this.driveDummies();

    stepWorld(this.world);
    this.interp.capture(this.world);
    scene.applyEvents(this.world);
    scene.emitTickEffects(this.world);
    this.consumeEvents();
    this.publishPrompt();
    this.publishScope();

    if (this.world.tick % HUD_EVERY_TICKS === 0) this.publishHud();
  }

  /**
   * Practice dummies: one stands its ground, one paces and hops. Scripted,
   * deterministic input — they use the same input path a remote player will.
   */
  private driveDummies(): void {
    const tick = this.world.tick;
    const pacer = this.dummies[0];
    const sitter = this.dummies[1];
    if (pacer !== undefined) {
      const phase = Math.floor(tick / 90) % 2; // turn around every 1.5 s
      const hop = tick % 240 === 0 ? Buttons.Jump : 0;
      setInput(this.world, pacer, {
        seq: tick,
        moveX: phase === 0 ? 0.6 : -0.6,
        moveY: 0,
        aim: phase === 0 ? 0 : Math.PI,
        buttons: hop,
      });
    }
    if (sitter !== undefined) {
      setInput(this.world, sitter, { seq: tick, moveX: 0, moveY: 0, aim: 0, buttons: 0 });
    }
  }

  private consumeEvents(): void {
    this.world.events.forEach((ev) => {
      if (ev.type === SimEventType.Death) {
        appStore.pushKill(this.nameOf(ev.b), this.nameOf(ev.a));
      } else if (ev.type === SimEventType.PickupTaken && ev.a === this.localPlayer) {
        if (ev.b < 0) {
          appStore.showPickup('GRENADES');
          return;
        }
        const name = weaponDef(ev.b as WeaponId).name.toUpperCase();
        appStore.showPickup(ev.r === 1 ? `${name} AMMO` : `PICKED UP ${name}`);
      }
    });
  }

  /**
   * Offer the pickup button whenever the local player is standing on a stocked
   * pad. Evaluated every tick (it is a handful of distance checks) but pushed
   * to React only on change, so stepping onto a pad shows the button instantly
   * without costing a render per frame.
   */
  private publishPrompt(): void {
    const slot = findPickupUnderPlayer(this.world, this.localPlayer);
    if (slot === -1) {
      appStore.setPrompt(null);
      return;
    }
    const pk = this.world.pickups;
    if ((pk.kind[slot] as PickupKind) === PickupKind.Grenades) {
      const count = pk.mag[slot] ?? 0;
      appStore.setPrompt({ weaponId: -1, weaponName: `Grenades ×${String(count)}` });
      return;
    }
    const weaponId = (pk.weapon[slot] ?? 0) as WeaponId;
    appStore.setPrompt({ weaponId, weaponName: weaponDef(weaponId).name });
  }

  /** Keep the HUD's scope button in sync with the held weapon's zoom. */
  private publishScope(): void {
    const p = this.world.players;
    const i = this.localPlayer;
    const id = (p.weapons[i * WEAPON_SLOTS + (p.weaponSlot[i] ?? 0)] ?? 0) as WeaponId;
    appStore.setScope(this.scoped, weaponDef(id).scope.zoomOut);
  }

  private nameOf(slot: number): string {
    if (slot === this.localPlayer) return 'You';
    const dummyIndex = this.dummies.indexOf(slot);
    if (dummyIndex >= 0) return DUMMY_NAMES[dummyIndex] ?? 'Dummy';
    return slot < 0 ? 'The Arena' : `Player ${String(slot + 1)}`;
  }

  private publishHud(): void {
    const p = this.world.players;
    const i = this.localPlayer;
    const slot = p.weaponSlot[i] ?? 0;
    const slotIndex = i * WEAPON_SLOTS + slot;
    const def = weaponDef((p.weapons[slotIndex] ?? DEFAULT_LOADOUT[0]) as WeaponId);

    const hud: HudState = {
      health: Math.max(0, Math.round(p.health[i] ?? 0)),
      maxHealth: TUNING.player.maxHealth,
      fuel: Math.round(p.fuel[i] ?? 0),
      maxFuel: TUNING.jetpack.maxFuel,
      ammoMag: p.ammoMag[slotIndex] ?? 0,
      ammoReserve: p.ammoReserve[slotIndex] ?? 0,
      weaponName: def.name,
      grenades: p.grenades[i] ?? 0,
      reloading: (p.reload[i] ?? 0) > 0,
      kills: p.kills[i] ?? 0,
      deaths: p.deaths[i] ?? 0,
      respawnIn: p.status[i] === 1 ? 0 : Math.ceil(p.respawn[i] ?? 0),
      protectFor: p.protect[i] ?? 0,
      fps: Math.round(this.game?.loop.actualFps ?? 0),
    };
    appStore.setHud(hud);
  }

  destroy(): void {
    this.destroyed = true;
    if (window.__aeroDebug?.world === this.world) delete window.__aeroDebug;
    this.input.detach();
    this.game?.destroy(true);
    this.game = null;
    this.scene = null;
  }
}
