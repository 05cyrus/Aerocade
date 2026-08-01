import Phaser from 'phaser';
import {
  Buttons,
  MAX_PLAYERS,
  MAX_PROJECTILES,
  ProjectileKind,
  SimEventType,
  TUNING,
  isSolid,
  type SimWorld,
} from '@aerocade/shared';
import { generateTextures, PLAYER_COLORS, PX_PER_M, TextureKeys } from './textures.js';
import type { RenderInterpolator } from './RenderInterpolator.js';

/** Target visible area in meters; zoom adapts the viewport to show this much. */
const VIEW_WIDTH_M = 26;
const VIEW_HEIGHT_M = 15.5;
/** Camera looks ahead toward the aim point by this fraction of the distance. */
const AIM_LOOKAHEAD = 0.12;
const MAX_TRACERS = 32;
const MAX_RINGS = 8;

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

  private playerBodies: Phaser.GameObjects.Sprite[] = [];
  private playerBarrels: Phaser.GameObjects.Sprite[] = [];
  private projectileSprites = new Map<number, Phaser.GameObjects.Sprite>();
  private cameraTarget!: Phaser.GameObjects.Rectangle;
  private overlay!: Phaser.GameObjects.Graphics;
  private explosionEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private jetEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;
  private deathEmitter!: Phaser.GameObjects.Particles.ParticleEmitter;

  private readonly tracers: Tracer[] = [];
  private readonly rings: Ring[] = [];

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
    const map = this.world.map;
    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        if (isSolid(map, tx, ty)) {
          this.add.image(tx * PX_PER_M, ty * PX_PER_M, TextureKeys.Tile).setOrigin(0, 0);
        }
      }
    }
  }

  private buildPlayers(): void {
    for (let i = 0; i < MAX_PLAYERS; i++) {
      const body = this.add
        .sprite(0, 0, TextureKeys.Player)
        .setTint(PLAYER_COLORS[i % PLAYER_COLORS.length])
        .setVisible(false);
      const barrel = this.add
        .sprite(0, 0, TextureKeys.Barrel)
        .setOrigin(0.1, 0.5)
        .setVisible(false);
      this.playerBodies.push(body);
      this.playerBarrels.push(barrel);
    }
  }

  private buildEffects(): void {
    this.explosionEmitter = this.add.particles(0, 0, TextureKeys.Spark, {
      speed: { min: 60, max: 340 },
      lifespan: { min: 250, max: 550 },
      scale: { start: 1.2, end: 0 },
      tint: [0xffa03c, 0xffe0a0, 0xff4d5e],
      emitting: false,
    });
    this.jetEmitter = this.add.particles(0, 0, TextureKeys.Spark, {
      speed: { min: 30, max: 80 },
      lifespan: { min: 120, max: 260 },
      scale: { start: 0.45, end: 0 },
      alpha: { start: 0.8, end: 0 },
      tint: [0x3cd6ff, 0xffe0a0],
      angle: { min: 80, max: 100 }, // downward plume
      emitting: false,
    });
    this.deathEmitter = this.add.particles(0, 0, TextureKeys.Spark, {
      speed: { min: 50, max: 220 },
      lifespan: { min: 300, max: 700 },
      scale: { start: 0.9, end: 0 },
      tint: [0xff4d5e, 0xdbe6ff],
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
    const zoom = Math.max(w / (VIEW_WIDTH_M * PX_PER_M), h / (VIEW_HEIGHT_M * PX_PER_M));
    this.cameras.main.setZoom(zoom);
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

  renderFrame(interp: RenderInterpolator, alpha: number, deltaMs: number): void {
    const world = this.world;
    const p = world.players;

    for (let i = 0; i < MAX_PLAYERS; i++) {
      const body = this.playerBodies[i];
      const barrel = this.playerBarrels[i];
      if (body === undefined || barrel === undefined) continue;
      if (interp.playerVisible[i] !== 1) {
        body.setVisible(false);
        barrel.setVisible(false);
        continue;
      }
      const x = interp.playerX(i, alpha) * PX_PER_M;
      const y = interp.playerY(i, alpha) * PX_PER_M;
      const aim = interp.playerAim(i, alpha);
      const facingLeft = Math.abs(aim) > Math.PI / 2;

      body.setPosition(x, y).setVisible(true).setFlipX(facingLeft);
      barrel
        .setPosition(x, y - 4)
        .setRotation(aim)
        .setFlipY(facingLeft)
        .setVisible(true);

      // Spawn protection shimmer.
      body.setAlpha((p.protect[i] ?? 0) > 0 ? 0.55 + 0.3 * Math.sin(this.time.now / 60) : 1);

      // Jet plume while thrusting with fuel.
      const cmd = world.inputs[i];
      if (cmd !== undefined && (cmd.buttons & Buttons.Thrust) !== 0 && (p.fuel[i] ?? 0) > 0) {
        this.jetEmitter.emitParticleAt(x, y + (TUNING.player.height / 2) * PX_PER_M - 4, 1);
      }
    }

    this.renderProjectiles(interp, alpha);
    this.renderOverlay(deltaMs);
    this.moveCamera(interp, alpha);
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
      const texture = isGrenade ? TextureKeys.Grenade : TextureKeys.Rocket;
      if (sprite === undefined) {
        sprite = this.add.sprite(0, 0, texture);
        this.projectileSprites.set(i, sprite);
      } else if (sprite.texture.key !== texture) {
        sprite.setTexture(texture);
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

  private moveCamera(interp: RenderInterpolator, alpha: number): void {
    const i = this.localPlayer;
    const x = interp.playerX(i, alpha) * PX_PER_M;
    const y = interp.playerY(i, alpha) * PX_PER_M;
    const pointer = this.input.activePointer;
    pointer.updateWorldPoint(this.cameras.main);
    const lookX = (pointer.worldX - x) * AIM_LOOKAHEAD;
    const lookY = (pointer.worldY - y) * AIM_LOOKAHEAD;
    this.cameraTarget.setPosition(x + lookX, y + lookY);
  }

  // ---------- sim event visuals ----------

  /** Called once per sim tick with that tick's events. */
  applyEvents(world: SimWorld): void {
    world.events.forEach((ev) => {
      switch (ev.type) {
        case SimEventType.Shot: {
          const aim = world.players.aim[ev.a] ?? 0;
          const mx = (ev.x + Math.cos(aim) * 0.75) * PX_PER_M;
          const my = (ev.y + Math.sin(aim) * 0.75) * PX_PER_M;
          const flash = this.add.image(mx, my, TextureKeys.Muzzle).setDepth(9);
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
          break;
        }
        case SimEventType.GrenadeBounce: {
          this.explosionEmitter.explode(2, ev.x * PX_PER_M, ev.y * PX_PER_M);
          break;
        }
        default:
          break;
      }
    });
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
