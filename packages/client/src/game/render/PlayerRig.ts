import Phaser from 'phaser';
import type { WeaponId } from '@aerocade/shared';
import { ATLAS, Frames, RIG_SCALE, weaponFrame } from './textures.js';

/**
 * An articulated soldier assembled from procedural atlas frames: helmeted
 * head, vested torso, pack, two legs with a speed-driven run cycle, and an arm
 * that holds the active weapon and tracks the aim angle. Its appearance is
 * locked by docs/character.md — check that doc before touching layout or art.
 *
 * The rig is pure presentation — it consumes interpolated positions plus a
 * few sim facts (velocity, grounded) and keeps only cosmetic state of its own
 * (run phase). One rig per player slot, built once and pooled by the scene.
 *
 * Every part samples the shared atlas so all eight rigs batch into a single
 * draw call (docs/performance.md). Arm and gun are positioned with explicit
 * math rather than a nested container, keeping the display list flat.
 *
 * The uniform is olive and untinted. Player color rides on two small parts —
 * a shoulder insignia and a helmet pad — because tint multiplies and an olive
 * base under a saturated team color just goes muddy. Each is glued to its
 * parent part through that part's rotation, so they track head aim and torso
 * lean instead of sliding off.
 *
 * Facing is handled by mirroring the root container (scaleX = -1). Inside a
 * mirrored container a rotation r appears as PI - r on screen (y-down), so
 * the arm uses localAim = PI - aim when facing left.
 */

// Local-space layout in screen pixels (container origin = collision center;
// the box is 27×53 px at 32 px/m — head crown ≈ -26, boot soles ≈ +26).
// Proportions are the reference's, as fractions of the 52 px standing height:
// head block 16 px (31%), torso 18 px, hip-to-sole 20 px (38%).
const HEAD_Y = -17;
const TORSO_Y = -3;
const HIP_Y = 7.2;
const HIP_SPREAD = 3.5;
const SHOULDER_X = 1;
const SHOULDER_Y = -7;
// Team-color parts, as offsets from their parent part's pivot. The helmet pad
// sits exactly over the dark side pad drawn into the head frame; the insignia
// sits high and slightly back, on the shoulder rather than the chest, and clear
// of the arm's sweep.
const HELMET_PAD_DX = -3.25;
const HELMET_PAD_DY = -3.65;
const INSIGNIA_DX = -2;
const INSIGNIA_DY = -5.5;
/** Distance from shoulder to the grip, along the aim direction. */
const GRIP_REACH = 8;

// Animation tuning (cosmetic only).
const RUN_CYCLE_RATE = 1.35; // run-phase radians per meter moved
const LEG_SWING = 0.62;
const LEG_IDLE_SPLAY = 0.07;
const AIR_LEG_FRONT = 0.42;
const AIR_LEG_BACK = -0.22;
const TORSO_LEAN_PER_MS = 0.014;
const TORSO_LEAN_MAX = 0.1;
const HEAD_TRACK_FRAC = 0.22;
const HEAD_TRACK_MAX = 0.28;
const RUN_BOB_PX = 0.9;
const POSE_EASE = 0.25; // per-frame blend toward the target pose

export class PlayerRig {
  readonly container: Phaser.GameObjects.Container;
  private readonly head: Phaser.GameObjects.Sprite;
  private readonly torso: Phaser.GameObjects.Sprite;
  private readonly legBack: Phaser.GameObjects.Sprite;
  private readonly legFront: Phaser.GameObjects.Sprite;
  private readonly pack: Phaser.GameObjects.Sprite;
  private readonly arm: Phaser.GameObjects.Sprite;
  private readonly gun: Phaser.GameObjects.Sprite;
  private readonly insignia: Phaser.GameObjects.Sprite;
  private readonly helmetPad: Phaser.GameObjects.Sprite;

  private runPhase = 0;
  private legBackPose = 0;
  private legFrontPose = 0;
  private currentWeapon: WeaponId | -1 = -1;

  constructor(scene: Phaser.Scene, tint: number) {
    const make = (frame: string): Phaser.GameObjects.Sprite =>
      scene.make.sprite({ key: ATLAS, frame }, false).setScale(RIG_SCALE);

    // Draw order (back to front): back leg, pack, torso, insignia, front leg,
    // head, helmet pad, arm, gun.
    this.legBack = make(Frames.Leg).setOrigin(0.5, 0.06);
    this.pack = make(Frames.Jetpack).setOrigin(0.5, 0.5);
    this.torso = make(Frames.Torso).setOrigin(0.5, 0.5);
    this.insignia = make(Frames.Insignia).setOrigin(0.5, 0.5);
    this.legFront = make(Frames.Leg).setOrigin(0.5, 0.06);
    this.head = make(Frames.Head).setOrigin(0.5, 0.62);
    this.helmetPad = make(Frames.HelmetPad).setOrigin(0.5, 0.5);
    this.arm = make(Frames.Arm).setOrigin(0.08, 0.5);
    this.gun = make(Frames.Rocket).setOrigin(0.18, 0.6);

    this.container = scene.add.container(0, 0, [
      this.legBack,
      this.pack,
      this.torso,
      this.insignia,
      this.legFront,
      this.head,
      this.helmetPad,
      this.arm,
      this.gun,
    ]);
    this.container.setDepth(5).setVisible(false);

    // The uniform stays olive; only the insignia and helmet pad take the
    // player's color (docs/character.md).
    this.insignia.setTint(tint);
    this.helmetPad.setTint(tint);

    this.legBack.setPosition(-HIP_SPREAD, HIP_Y);
    this.legFront.setPosition(HIP_SPREAD, HIP_Y);
  }

  setVisible(visible: boolean): void {
    this.container.setVisible(visible);
  }

  setAlpha(alpha: number): void {
    this.container.setAlpha(alpha);
  }

  /** Swap the held weapon frame when the active slot changes. */
  setActiveWeapon(id: WeaponId): void {
    if (id === this.currentWeapon) return;
    this.currentWeapon = id;
    this.gun.setFrame(weaponFrame(id));
  }

  update(
    dtSeconds: number,
    x: number,
    y: number,
    aim: number,
    velXMetersPerSec: number,
    grounded: boolean,
  ): void {
    const facingLeft = Math.abs(aim) > Math.PI / 2;
    this.container.setPosition(x, y);
    this.container.setScale(facingLeft ? -1 : 1, 1);

    // Mirrored containers show rotation r as PI - r, so pre-mirror the aim.
    const localAim = facingLeft ? Math.PI - aim : aim;

    // velX in facing-local space: positive = moving the way we look.
    const localVel = facingLeft ? -velXMetersPerSec : velXMetersPerSec;
    const speed = Math.abs(velXMetersPerSec);
    const running = grounded && speed > 0.5;

    let targetBack: number;
    let targetFront: number;
    if (running) {
      // Backpedaling plays the cycle in reverse automatically via localVel.
      this.runPhase += localVel * dtSeconds * RUN_CYCLE_RATE * Math.PI;
      const swing = Math.sin(this.runPhase) * LEG_SWING;
      targetBack = swing;
      targetFront = -swing;
    } else if (grounded) {
      this.runPhase = 0;
      targetBack = -LEG_IDLE_SPLAY;
      targetFront = LEG_IDLE_SPLAY;
    } else {
      // Airborne: trailing jetpack pose.
      this.runPhase = 0;
      targetBack = AIR_LEG_BACK;
      targetFront = AIR_LEG_FRONT;
    }
    this.legBackPose += (targetBack - this.legBackPose) * POSE_EASE;
    this.legFrontPose += (targetFront - this.legFrontPose) * POSE_EASE;
    this.legBack.setRotation(this.legBackPose);
    this.legFront.setRotation(this.legFrontPose);

    // Torso leans into horizontal motion; upper body rides the run bob.
    const torsoRot = Phaser.Math.Clamp(
      localVel * TORSO_LEAN_PER_MS,
      -TORSO_LEAN_MAX,
      TORSO_LEAN_MAX,
    );
    this.torso.setRotation(torsoRot);
    const bob = running ? Math.abs(Math.sin(this.runPhase)) * -RUN_BOB_PX : 0;
    this.torso.setY(TORSO_Y + bob);
    this.pack.setPosition(-9, -5 + bob);

    const headRot = Phaser.Math.Clamp(localAim * HEAD_TRACK_FRAC, -HEAD_TRACK_MAX, HEAD_TRACK_MAX);
    this.head.setY(HEAD_Y + bob);
    this.head.setRotation(headRot);

    // Team-color parts orbit their parent's pivot so they stay glued through
    // torso lean and head tracking rather than sliding off the uniform.
    const torsoCos = Math.cos(torsoRot);
    const torsoSin = Math.sin(torsoRot);
    this.insignia
      .setPosition(
        INSIGNIA_DX * torsoCos - INSIGNIA_DY * torsoSin,
        TORSO_Y + bob + INSIGNIA_DX * torsoSin + INSIGNIA_DY * torsoCos,
      )
      .setRotation(torsoRot);
    const headCos = Math.cos(headRot);
    const headSin = Math.sin(headRot);
    this.helmetPad
      .setPosition(
        HELMET_PAD_DX * headCos - HELMET_PAD_DY * headSin,
        HEAD_Y + bob + HELMET_PAD_DX * headSin + HELMET_PAD_DY * headCos,
      )
      .setRotation(headRot);

    // Arm pivots at the shoulder; the gun rides at the end of the reach.
    const shoulderY = SHOULDER_Y + bob;
    this.arm.setPosition(SHOULDER_X, shoulderY).setRotation(localAim);
    this.gun
      .setPosition(
        SHOULDER_X + Math.cos(localAim) * GRIP_REACH,
        shoulderY + Math.sin(localAim) * GRIP_REACH,
      )
      .setRotation(localAim);

    this.legBack.setY(HIP_Y + bob * 0.3);
    this.legFront.setY(HIP_Y + bob * 0.3);
  }

  destroy(): void {
    this.container.destroy(true);
  }
}
