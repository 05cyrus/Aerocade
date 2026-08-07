import Phaser from 'phaser';
import {
  Buttons,
  MAX_PICKUPS,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  PickupKind,
  ProjectileKind,
  SimEventType,
  TUNING,
  WEAPON_SLOTS,
  type SimWorld,
  type WeaponId,
} from '@aerocade/shared';
import { WEAPON_COUNT, weaponDef } from '@aerocade/shared';
import {
  ATLAS,
  Frames,
  generateTextures,
  PLAYER_COLORS,
  PX_PER_M,
  RIG_SCALE,
  frameDataUrl,
  weaponFrame,
} from './textures.js';
import { PlayerRig } from './PlayerRig.js';
import { TerrainView } from './TerrainView.js';
import type { RenderInterpolator } from './RenderInterpolator.js';

/** Target visible area in meters; zoom adapts the viewport to show this much. */
const VIEW_WIDTH_M = 26;
const VIEW_HEIGHT_M = 15.5;
/** Camera looks ahead toward the aim point by this fraction of the distance. */
const AIM_LOOKAHEAD = 0.12;
const MAX_TRACERS = 32;
const MAX_RINGS = 8;
/** Pad disc sits just below the tile center so it reads as lying on the floor. */
const PAD_DISC_OFFSET_PX = 15;
/** Per-frame blend toward the scope's target zoom/offset at 60 fps. */
const SCOPE_EASE_PER_FRAME = 0.12;
/** Dropped gear fades over its last seconds so vanishing is not a pop. */
const PICKUP_FADE_SECONDS = 3;
/** Hover animation for a stocked pad's gun. */
const PAD_BOB_PX = 3.5;
const PAD_BOB_SPEED = 0.0028;
/** Overhead health bars: 64×10 atlas frame scaled down, floated above the head. */
const HEALTH_BAR_SCALE = 0.5;
const HEALTH_BAR_WIDTH_PX = 64 * HEALTH_BAR_SCALE;
const HEALTH_BAR_Y_OFFSET_PX = -34;
/** Empty-portion color; must contrast with the arena, not blend into it. */
const HEALTH_BAR_BACK_COLOR = 0x39456b;
/** Fill colors interpolated by remaining health: green → amber → red. */
const HEALTH_COLOR_FULL = 0x55e08c;
const HEALTH_COLOR_MID = 0xf5e663;
const HEALTH_COLOR_LOW = 0xff4d5e;

interface Tracer {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  ttl: number;
}

interface Ring {
  x: number;
  y: number;
  radius: number;
  ttl: number;
  maxTtl: number;
}

/** Drives everything the scene needs from the game loop each frame. */
export interface SceneDriver {
  onSceneReady(scene: ArenaScene): void;
  onFrame(deltaMs: number): void;
}

/**
 * Renders a SimWorld. Owns no game state: every frame it draws the
 * interpolated snapshot it is handed. Effects are fire-and-forget visuals
 * spawned from sim events (docs/rendering.md).
 */
export class ArenaScene extends Phaser.Scene {
  private readonly driver: SceneDriver;
  private readonly world: SimWorld;
  private readonly localPlayer: number;

  private terrain: TerrainView | null = null;
  private rigs: PlayerRig[] = [];
  private projectileSprites = new Map<number, Phaser.GameObjects.Sprite>();
  /** One disc per map weapon pad (static furniture). */
  private padDiscs: Phaser.GameObjects.Sprite[] = [];
  /** One sprite per pickup slot — pad guns and dropped gear alike. */
  private padGuns: Phaser.GameObjects.Sprite[] = [];
  /** Overhead health bar per player: dark backing plus a tinted fill. */
  private healthBacks: Phaser.GameObjects.Sprite[] = [];
  private healthFills: Phaser.GameObjects.Sprite[] = [];
  private cameraTarget!: Phaser.GameObjects.Rectangle;
  private overlay!: Phaser.GameObjects.Graphics;
  private explosionEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private jetEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private deathEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private pickupEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  private readonly tracers: Tracer[] = [];
  private readonly rings: Ring[] = [];

  /** Zoom that fits the design view size to the current viewport. */
  private baseZoom = 1;
  /** Eased toward the scoped/unscoped target so toggling never snaps. */
  private appliedZoom = 1;
  /** Eased camera slide toward the aim point, in pixels. */
  private scopeOffsetX = 0;
  private scopeOffsetY = 0;
  private scoped = false;

  constructor(driver: SceneDriver, world: SimWorld, localPlayer: number) {
    super({ key: 'arena' });
    this.driver = driver;
    this.world = world;
    this.localPlayer = localPlayer;
  }

  // Phaser lifecycle hook (not on the Scene base type, so no `override`).
  create(): void {
    generateTextures(this);
    this.buildTiles();
    this.buildPickups();
    this.buildPlayers();
    this.buildEffects();
    this.buildCamera();
    this.scale.on('resize', () => {
      this.applyZoom();
    });
    this.driver.onSceneReady(this);
  }

  override update(_time: number, deltaMs: number): void {
    this.driver.onFrame(deltaMs);
  }

  // ---------- construction ----------

  private buildTiles(): void {
    // Sized to the viewport, never to the map: Outpost Delta has 17k tiles and
    // only a few hundred are ever on screen (see TerrainView).
    const capacity = TerrainView.capacityFor(Math.ceil(VIEW_WIDTH_M), Math.ceil(VIEW_HEIGHT_M));
    this.terrain = new TerrainView(this, this.world.map, capacity);
  }

  /**
   * Weapon pads are static map geometry, so their sprites are built once:
   * a floor disc that dims while the pad is empty, and the gun hovering above
   * it. Both are pooled by pad index — no churn when pads are looted.
   */
  private buildPickups(): void {
    // Pad discs are static map furniture — one per pad, positioned once.
    for (const pad of this.world.map.pads) {
      this.padDiscs.push(
        this.add
          .sprite(pad.x * PX_PER_M, pad.y * PX_PER_M + PAD_DISC_OFFSET_PX, ATLAS, Frames.Pad)
          .setScale(RIG_SCALE)
          .setDepth(1),
      );
    }
    // Ground items move (they are thrown and fall), so they get their own
    // pooled sprites indexed by pickup slot.
    for (let i = 0; i < MAX_PICKUPS; i++) {
      this.padGuns.push(
        this.add
          .sprite(0, 0, ATLAS, Frames.Rocket)
          .setScale(RIG_SCALE)
          .setDepth(2)
          .setVisible(false),
      );
    }
  }

  private buildPlayers(): void {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      this.rigs.push(new PlayerRig(this, PLAYER_COLORS[i % PLAYER_COLORS.length] ?? 0xffffff));

      // Health bars live outside the rig container: the rig mirrors on facing
      // (scaleX = -1) and a bar inside it would drain right-to-left.
      this.healthBacks.push(
        this.add
          .sprite(0, 0, ATLAS, Frames.Bar)
          .setScale(HEALTH_BAR_SCALE)
          // Mid-slate, not near-black: the backing has to read against a dark
          // arena or a nearly-empty bar looks like a floating chip instead of
          // a bar that is nearly empty.
          .setTint(HEALTH_BAR_BACK_COLOR)
          .setAlpha(0.9)
          .setDepth(7)
          .setVisible(false),
      );
      this.healthFills.push(
        this.add
          .sprite(0, 0, ATLAS, Frames.Bar)
          .setScale(HEALTH_BAR_SCALE)
          .setOrigin(0, 0.5) // grows from the left edge
          .setDepth(8)
          .setVisible(false),
      );
    }
  }

  private buildEffects(): void {
    this.explosionEmitter = this.add.particles(0, 0, ATLAS, {
      frame: Frames.Spark,
      speed: { min: 60, max: 340 },
      lifespan: { min: 250, max: 550 },
      scale: { start: 1.2, end: 0 },
      tint: [0xffa03c, 0xffe0a0, 0xff4d5e],
      emitting: false,
    });
    this.jetEmitter = this.add.particles(0, 0, ATLAS, {
      frame: Frames.Spark,
      speed: { min: 30, max: 80 },
      lifespan: { min: 120, max: 260 },
      scale: { start: 0.45, end: 0 },
      alpha: { start: 0.8, end: 0 },
      tint: [0x3cd6ff, 0xffe0a0],
      angle: { min: 80, max: 100 }, // downward plume
      emitting: false,
    });
    this.deathEmitter = this.add.particles(0, 0, ATLAS, {
      frame: Frames.Spark,
      speed: { min: 50, max: 220 },
      lifespan: { min: 300, max: 700 },
      scale: { start: 0.9, end: 0 },
      tint: [0xff4d5e, 0xdbe6ff],
      emitting: false,
    });
    this.pickupEmitter = this.add.particles(0, 0, ATLAS, {
      frame: Frames.Spark,
      speed: { min: 20, max: 110 },
      lifespan: { min: 200, max: 420 },
      scale: { start: 0.6, end: 0 },
      alpha: { start: 0.9, end: 0 },
      tint: [0x3cd6ff, 0xdff4ff],
      emitting: false,
    });
    this.overlay = this.add.graphics().setDepth(10);
  }

  private buildCamera(): void {
    const map = this.world.map;
    this.cameraTarget = this.add.rectangle(0, 0, 2, 2, 0, 0);
    this.cameras.main.setBounds(0, 0, map.width * PX_PER_M, map.height * PX_PER_M);
    this.cameras.main.startFollow(this.cameraTarget, false, 0.12, 0.12);
    this.cameras.main.setBackgroundColor('#0b1020');
    this.applyZoom();
  }

  private applyZoom(): void {
    const w = this.scale.width;
    const h = this.scale.height;
    this.baseZoom = Math.max(w / (VIEW_WIDTH_M * PX_PER_M), h / (VIEW_HEIGHT_M * PX_PER_M));
    if (this.appliedZoom === 1) this.appliedZoom = this.baseZoom; // first sizing
    this.cameras.main.setZoom(this.appliedZoom);
  }

  /**
   * One data-URL icon per weapon, cropped from the atlas so the HUD shows the
   * same art the player sees in their hands. Built once, after textures exist.
   */
  weaponIcons(): string[] {
    const icons: string[] = [];
    for (let id = 0; id < WEAPON_COUNT; id++) {
      icons.push(frameDataUrl(this, weaponFrame(id as WeaponId)));
    }
    return icons;
  }

  /** Toggle the scoped view. Purely a camera change — see ADR-016. */
  setScoped(scoped: boolean): void {
    this.scoped = scoped;
  }

  // ---------- per-frame rendering ----------

  /** Aim angle from a player's current position toward the mouse pointer. */
  computeAimFor(player: number, interp: RenderInterpolator): number {
    const pointer = this.input.activePointer;
    pointer.updateWorldPoint(this.cameras.main);
    const px = interp.playerX(player, 1) * PX_PER_M;
    const py = interp.playerY(player, 1) * PX_PER_M;
    return Math.atan2(pointer.worldY - py, pointer.worldX - px);
  }

  /**
   * A player's canvas-pixel position. Derived from the camera's visible world
   * rect so it stays correct under zoom, scroll, and bounds clamping.
   */
  worldToScreen(player: number): { x: number; y: number } {
    const view = this.cameras.main.worldView;
    const wx = (this.world.players.posX[player] ?? 0) * PX_PER_M;
    const wy = (this.world.players.posY[player] ?? 0) * PX_PER_M;
    return {
      x: ((wx - view.x) / view.width) * this.scale.width,
      y: ((wy - view.y) / view.height) * this.scale.height,
    };
  }

  renderFrame(interp: RenderInterpolator, alpha: number, deltaMs: number): void {
    const world = this.world;
    const p = world.players;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const rig = this.rigs[i];
      if (rig === undefined) continue;
      if (interp.playerVisible[i] !== 1) {
        rig.setVisible(false);
        // Clear the bar in the same frame the player dies. Skipping this left
        // the last drawn sliver of health frozen over the corpse.
        this.hideHealthBar(i);
        continue;
      }
      const x = interp.playerX(i, alpha) * PX_PER_M;
      const y = interp.playerY(i, alpha) * PX_PER_M;
      const aim = interp.playerAim(i, alpha);

      rig.setVisible(true);
      rig.setActiveWeapon((p.weapons[i * WEAPON_SLOTS + (p.weaponSlot[i] ?? 0)] ?? 0) as WeaponId);
      rig.update(deltaMs / 1000, x, y, aim, p.velX[i] ?? 0, p.grounded[i] === 1);

      // Spawn protection shimmer.
      rig.setAlpha((p.protect[i] ?? 0) > 0 ? 0.55 + 0.3 * Math.sin(this.time.now / 60) : 1);

      this.renderHealthBar(i, x, y);
    }

    this.renderPickups();
    this.renderProjectiles(interp, alpha);
    this.renderOverlay(deltaMs);
    this.moveCamera(interp, alpha, deltaMs);
    this.terrain?.update(this.cameras.main);
  }

  private hideHealthBar(player: number): void {
    this.healthBacks[player]?.setVisible(false);
    this.healthFills[player]?.setVisible(false);
  }

  /**
   * Floating health bar over a player's head, read straight from sim health
   * so it tracks damage the moment it lands. Every living player carries one,
   * including you — the HUD bar answers "how am I doing", the overhead bar
   * answers it without looking away from the fight.
   */
  private renderHealthBar(player: number, x: number, y: number): void {
    const back = this.healthBacks[player];
    const fill = this.healthFills[player];
    if (back === undefined || fill === undefined) return;

    const p = this.world.players;
    const frac = Phaser.Math.Clamp((p.health[player] ?? 0) / TUNING.player.maxHealth, 0, 1);
    const barY = y + HEALTH_BAR_Y_OFFSET_PX;

    back.setPosition(x, barY).setVisible(true);
    fill
      .setPosition(x - HEALTH_BAR_WIDTH_PX / 2, barY)
      .setScale(HEALTH_BAR_SCALE * frac, HEALTH_BAR_SCALE)
      .setTint(healthTint(frac))
      .setVisible(frac > 0);
  }

  /**
   * Pads are state-driven, not event-driven: a stocked pad shows its gun
   * bobbing over a bright disc, a looted one dims to a faint marker so
   * players still know where to come back to.
   */
  private renderPickups(): void {
    const world = this.world;
    const pk = world.pickups;
    const bob = Math.sin(this.time.now * PAD_BOB_SPEED) * PAD_BOB_PX;

    // Pad discs: bright while stocked, dim while empty, brightening as the
    // refill nears so players can read an incoming restock from across the map.
    for (let i = 0; i < this.padDiscs.length; i++) {
      const disc = this.padDiscs[i];
      if (disc === undefined) continue;
      const owned = world.pads.pickup[i] ?? -1;
      if (owned >= 0 && pk.alive[owned] === 1) {
        disc.setAlpha(0.95);
      } else {
        const left = world.pads.timer[i] ?? 0;
        const readiness = 1 - Math.min(1, left / TUNING.pickups.weaponRespawnDelay);
        disc.setAlpha(0.18 + 0.34 * readiness);
      }
    }

    // Ground items: pad guns hover, dropped gear lies where it landed and
    // fades out as its lifetime runs down.
    for (let i = 0; i < MAX_PICKUPS; i++) {
      const sprite = this.padGuns[i];
      if (sprite === undefined) continue;
      if (pk.alive[i] !== 1) {
        sprite.setVisible(false);
        continue;
      }
      const frame = pickupFrame(pk.kind[i] as PickupKind, (pk.weapon[i] ?? 0) as WeaponId);
      if (sprite.frame.name !== frame) sprite.setFrame(frame);

      const fromPad = (pk.padIndex[i] ?? -1) >= 0;
      const ttl = pk.ttl[i] ?? 0;
      sprite
        .setPosition(
          (pk.posX[i] ?? 0) * PX_PER_M,
          (pk.posY[i] ?? 0) * PX_PER_M + (fromPad ? bob : 0),
        )
        .setAlpha(!fromPad && ttl > 0 && ttl < PICKUP_FADE_SECONDS ? ttl / PICKUP_FADE_SECONDS : 1)
        .setVisible(true);
    }
  }

  private renderProjectiles(interp: RenderInterpolator, alpha: number): void {
    const pr = this.world.projectiles;
    for (let i = 0; i < MAX_PROJECTILES; i++) {
      const active = interp.projVisible[i] === 1;
      let sprite = this.projectileSprites.get(i);
      if (!active) {
        sprite?.setVisible(false);
        continue;
      }
      const isGrenade = (pr.kind[i] as ProjectileKind) === ProjectileKind.FragGrenade;
      const frame = isGrenade ? Frames.Grenade : Frames.Rocket;
      if (sprite === undefined) {
        sprite = this.add.sprite(0, 0, ATLAS, frame);
        this.projectileSprites.set(i, sprite);
      } else if (sprite.frame.name !== frame) {
        sprite.setFrame(frame);
      }
      const x = interp.projX(i, alpha) * PX_PER_M;
      const y = interp.projY(i, alpha) * PX_PER_M;
      sprite.setPosition(x, y).setVisible(true);
      if (isGrenade) {
        sprite.setRotation(this.time.now / 150);
      } else {
        sprite.setRotation(Math.atan2(pr.velY[i] ?? 0, pr.velX[i] ?? 0));
      }
    }
  }

  private renderOverlay(deltaMs: number): void {
    const g = this.overlay;
    g.clear();

    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      if (t === undefined) continue;
      t.ttl -= deltaMs;
      if (t.ttl <= 0) {
        this.tracers.splice(i, 1);
        continue;
      }
      g.lineStyle(1.5, 0xffe0a0, Math.min(1, t.ttl / 90) * 0.8);
      g.lineBetween(t.x1, t.y1, t.x2, t.y2);
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      if (r === undefined) continue;
      r.ttl -= deltaMs;
      if (r.ttl <= 0) {
        this.rings.splice(i, 1);
        continue;
      }
      const progress = 1 - r.ttl / r.maxTtl;
      g.lineStyle(3, 0xffa03c, (1 - progress) * 0.9);
      g.strokeCircle(r.x, r.y, r.radius * progress);
    }
  }

  /**
   * Follow the local player, leading slightly toward the crosshair. While
   * scoped, widen the view and slide further down-range by the active
   * weapon's scope profile — a sniper sees most of the arena, a shotgun
   * barely more than usual. Both quantities ease so toggling never snaps.
   */
  private moveCamera(interp: RenderInterpolator, alpha: number, deltaMs: number): void {
    const i = this.localPlayer;
    const x = interp.playerX(i, alpha) * PX_PER_M;
    const y = interp.playerY(i, alpha) * PX_PER_M;
    const pointer = this.input.activePointer;
    pointer.updateWorldPoint(this.cameras.main);

    const scope = weaponDef(
      (this.world.players.weapons[i * WEAPON_SLOTS + (this.world.players.weaponSlot[i] ?? 0)] ??
        0) as WeaponId,
    ).scope;

    // Frame-rate independent easing toward the current target.
    const ease = 1 - Math.pow(1 - SCOPE_EASE_PER_FRAME, Math.max(deltaMs, 1) / 16.67);

    const targetZoom = this.scoped ? this.baseZoom / scope.zoomOut : this.baseZoom;
    this.appliedZoom += (targetZoom - this.appliedZoom) * ease;
    this.cameras.main.setZoom(this.appliedZoom);

    const aim = interp.playerAim(i, alpha);
    const reach = this.scoped ? scope.lookAhead * PX_PER_M : 0;
    this.scopeOffsetX += (Math.cos(aim) * reach - this.scopeOffsetX) * ease;
    this.scopeOffsetY += (Math.sin(aim) * reach - this.scopeOffsetY) * ease;

    const lookX = (pointer.worldX - x) * AIM_LOOKAHEAD;
    const lookY = (pointer.worldY - y) * AIM_LOOKAHEAD;
    this.cameraTarget.setPosition(x + lookX + this.scopeOffsetX, y + lookY + this.scopeOffsetY);
  }

  // ---------- sim event visuals ----------

  /**
   * Per-sim-tick continuous effects (60 Hz regardless of display refresh —
   * per-frame emission would scale plume density with the monitor).
   */
  emitTickEffects(world: SimWorld): void {
    const p = world.players;
    for (let i = 0; i < MAX_PLAYERS; i++) {
      if (p.connected[i] !== 1 || p.status[i] !== 1) continue;
      const cmd = world.inputs[i];
      if (cmd === undefined || (cmd.buttons & Buttons.Thrust) === 0 || (p.fuel[i] ?? 0) <= 0) {
        continue;
      }
      // Hover (thrust + down input, ADR-011) idles the jets at half density.
      const hovering = cmd.moveY > 0.5 && p.grounded[i] !== 1;
      if (hovering && world.tick % 2 === 0) continue;
      // Plume leaves the jetpack nozzles, which sit behind the facing direction.
      const facingLeft = Math.abs(p.aim[i] ?? 0) > Math.PI / 2;
      const x = (p.posX[i] ?? 0) * PX_PER_M + (facingLeft ? 8 : -8);
      const y = (p.posY[i] ?? 0) * PX_PER_M + 4;
      this.jetEmitter.emitParticleAt(x, y, 1);
    }
  }

  /** Called once per sim tick with that tick's events. */
  applyEvents(world: SimWorld): void {
    world.events.forEach((ev) => {
      switch (ev.type) {
        case SimEventType.Shot: {
          const aim = world.players.aim[ev.a] ?? 0;
          const mx = (ev.x + Math.cos(aim) * 0.75) * PX_PER_M;
          const my = (ev.y + Math.sin(aim) * 0.75) * PX_PER_M;
          const flash = this.add.image(mx, my, ATLAS, Frames.Muzzle).setDepth(9);
          this.tweens.add({
            targets: flash,
            alpha: 0,
            scale: 0.4,
            duration: 70,
            onComplete: () => {
              flash.destroy();
            },
          });
          break;
        }
        case SimEventType.Trace: {
          if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
          const sx = (world.players.posX[ev.a] ?? 0) * PX_PER_M;
          const sy = (world.players.posY[ev.a] ?? 0) * PX_PER_M;
          this.tracers.push({ x1: sx, y1: sy, x2: ev.x * PX_PER_M, y2: ev.y * PX_PER_M, ttl: 90 });
          break;
        }
        case SimEventType.Explosion: {
          const x = ev.x * PX_PER_M;
          const y = ev.y * PX_PER_M;
          this.explosionEmitter.explode(26, x, y);
          if (this.rings.length >= MAX_RINGS) this.rings.shift();
          this.rings.push({ x, y, radius: ev.r * PX_PER_M, ttl: 320, maxTtl: 320 });
          this.shakeFor(ev.x, ev.y, ev.r);
          break;
        }
        case SimEventType.Death: {
          this.deathEmitter.explode(22, ev.x * PX_PER_M, ev.y * PX_PER_M);
          this.spawnDeathDebris(
            ev.x * PX_PER_M,
            ev.y * PX_PER_M,
            PLAYER_COLORS[ev.a % PLAYER_COLORS.length] ?? 0xffffff,
          );
          break;
        }
        case SimEventType.GrenadeBounce: {
          this.explosionEmitter.explode(2, ev.x * PX_PER_M, ev.y * PX_PER_M);
          break;
        }
        case SimEventType.PickupTaken: {
          this.pickupEmitter.explode(14, ev.x * PX_PER_M, ev.y * PX_PER_M);
          break;
        }
        case SimEventType.PickupSpawn: {
          // A soft puff announces a pad refilling, so players notice restocks.
          this.pickupEmitter.explode(8, ev.x * PX_PER_M, ev.y * PX_PER_M);
          break;
        }
        default:
          break;
      }
    });
  }

  /**
   * A short-lived tumble of gear where a soldier fell. Allocates a handful of
   * sprites, but only on the (rare) death event — they self-destroy.
   */
  private spawnDeathDebris(x: number, y: number, tint: number): void {
    const parts = [Frames.Head, Frames.Leg, Frames.Leg, Frames.Arm, Frames.Insignia];
    for (const frameName of parts) {
      const piece = this.add.sprite(x, y, ATLAS, frameName).setScale(RIG_SCALE).setDepth(6);
      // The uniform is untinted olive, so the insignia is what shows whose
      // gear this was (docs/character.md).
      if (frameName === Frames.Insignia) piece.setTint(tint);
      const driftX = Phaser.Math.Between(-70, 70);
      const rise = Phaser.Math.Between(30, 90);
      this.tweens.add({
        targets: piece,
        x: x + driftX,
        y: { value: y - rise + 130, ease: 'Quad.easeIn' }, // pops up, then falls
        angle: Phaser.Math.Between(-300, 300),
        alpha: 0,
        duration: Phaser.Math.Between(550, 800),
        onComplete: () => {
          piece.destroy();
        },
      });
    }
  }

  /** Screenshake scaled by explosion proximity to the local player. */
  private shakeFor(x: number, y: number, radius: number): void {
    const px = this.world.players.posX[this.localPlayer] ?? 0;
    const py = this.world.players.posY[this.localPlayer] ?? 0;
    const dist = Math.hypot(px - x, py - y);
    const strength = Math.max(0, 1 - dist / (radius * 3));
    if (strength > 0.05) {
      this.cameras.main.shake(140, 0.004 * strength);
    }
  }
}

/**
 * Health-bar fill color: green above half, fading through amber to red as it
 * empties, so a wounded opponent reads at a glance without needing numbers.
 */
function healthTint(frac: number): number {
  return frac > 0.5
    ? Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(HEALTH_COLOR_MID),
        Phaser.Display.Color.ValueToColor(HEALTH_COLOR_FULL),
        100,
        Math.round((frac - 0.5) * 200),
      ).color
    : Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.ValueToColor(HEALTH_COLOR_LOW),
        Phaser.Display.Color.ValueToColor(HEALTH_COLOR_MID),
        100,
        Math.round(frac * 200),
      ).color;
}

/** Atlas frame for a ground item of a given kind. */
function pickupFrame(kind: PickupKind, weapon: WeaponId): string {
  switch (kind) {
    case PickupKind.Grenades:
      return Frames.Grenade;
    case PickupKind.Health:
      return Frames.HealthBox;
    case PickupKind.Ammo:
      return Frames.AmmoBox;
    default:
      return weaponFrame(weapon);
  }
}
