import * as THREE from "three";
import { Level, WALL_H } from "./level";

export const EYE_HEIGHT = 1.62;
const RADIUS = 0.32;
const WALK_SPEED = 2.7;
const SPRINT_SPEED = 4.7;

export class Player {
  pos: THREE.Vector3;
  vel = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  stamina = 1;
  exhausted = false;
  sprinting = false;
  /** C toggles — silent feet, slower, harder for it to notice you */
  sneaking = false;
  flashlightOn = true;
  /** dev cheat: walk through walls, faster */
  noclip = false;
  /** virtual stick input (mobile), each axis -1..1 */
  touchMove = { x: 0, z: 0 };

  /** 0..1 — externally driven (entity proximity) flashlight malfunction */
  flashlightInterference = 0;

  readonly camera: THREE.PerspectiveCamera;
  readonly flashlight: THREE.SpotLight;
  private lightRig = new THREE.Group();
  private lightTarget = new THREE.Object3D();

  /** full third-person-style body, visible when you look down */
  readonly body = new THREE.Group();
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private kneeL!: THREE.Group;
  private kneeR!: THREE.Group;
  private torso!: THREE.Mesh;
  private lensMat!: THREE.MeshStandardMaterial;
  private handTorch!: THREE.Group;

  private keys = new Set<string>();
  private bobPhase = 0;
  private bobAmp = 0;
  private crouch = 0;
  private staminaRegenDelay = 0;
  private flickerTimer = 0;
  private flickerState = 1;
  /** smoothed close-surface dimming factor for the torch (anti-blowout) */
  private torchDim = 1;

  /** set by engine each frame the entity event wants the camera shaken */
  shake = 0;

  onStep: ((sprinting: boolean) => void) | null = null;
  onFlashlightToggle: ((on: boolean) => void) | null = null;

  constructor(private level: Level, aspect: number) {
    this.pos = level.spawn.clone();
    this.camera = new THREE.PerspectiveCamera(72, aspect, 0.05, 90);
    this.camera.rotation.order = "YXZ";

    // Face away from the nearest wall at spawn.
    this.yaw = Math.PI * 0.25;

    // Flashlight rides in a rig that lags the camera — hand-held feel.
    this.flashlight = new THREE.SpotLight(0xfff3d6, 46, 28, 0.4, 0.5, 1.5);
    this.flashlight.position.set(0.18, -0.22, 0.05);
    this.flashlight.castShadow = true;
    this.flashlight.shadow.mapSize.set(1024, 1024);
    this.flashlight.shadow.camera.near = 0.2;
    this.flashlight.shadow.camera.far = 20;
    this.flashlight.shadow.bias = -0.004;
    this.flashlight.shadow.normalBias = 0.02;
    this.lightTarget.position.set(0, 0, -10);
    this.lightRig.add(this.flashlight, this.lightTarget);
    this.flashlight.target = this.lightTarget;

    this.buildBody();
    this.buildHands();
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.camera);
    scene.add(this.lightRig);
    scene.add(this.body);
  }

  /* --------------------------- 3D character --------------------------- */

  /**
   * The player's own body: torso, hips and two articulated legs that walk
   * with the bob cycle. Lives at ground level under the camera — look down
   * and there you are.
   */
  private buildBody() {
    const jacket = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.96 });
    const denim = new THREE.MeshStandardMaterial({ color: 0x232931, roughness: 0.97 });
    const shoe = new THREE.MeshStandardMaterial({ color: 0x16161a, roughness: 0.55 });

    // Torso (capsule) + hips, set back behind the eye line so the chest and
    // striding legs both read when looking down.
    this.torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.4, 6, 14), jacket);
    this.torso.position.set(0, 1.08, 0.17);
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.125, 0.135, 0.18, 14), denim);
    hips.position.set(0, 0.84, 0.17);
    this.body.add(this.torso, hips);

    const makeLeg = (side: 1 | -1) => {
      const leg = new THREE.Group();
      leg.position.set(0.095 * side, 0.82, 0.17);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.062, 0.42, 10), denim);
      thigh.position.y = -0.21;
      const knee = new THREE.Group();
      knee.position.y = -0.42;
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.05, 0.38, 10), denim);
      shin.position.y = -0.19;
      const foot = new THREE.Mesh(new THREE.BoxGeometry(0.095, 0.07, 0.24), shoe);
      foot.position.set(0, -0.385, -0.05);
      knee.add(shin, foot);
      leg.add(thigh, knee);
      this.body.add(leg);
      return { leg, knee };
    };
    ({ leg: this.legL, knee: this.kneeL } = makeLeg(-1));
    ({ leg: this.legR, knee: this.kneeR } = makeLeg(1));

    // Both arms are raised in front (view-model hands) — the body only
    // needs shoulders so the silhouette reads when looking down.
    for (const side of [-1, 1] as const) {
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), jacket);
      shoulder.position.set(0.18 * side, 1.36, 0.17);
      this.body.add(shoulder);
    }

    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.castShadow = false; // would block our own flashlight
        o.receiveShadow = false;
      }
    });
  }

  /**
   * First-person view-model: one pale hand gripping a black torch.
   * Fingers are articulated chains (proximal/middle/distal segments with
   * knuckles) wrapped around the barrel, parented to the lagging light rig
   * so the torch follows the view with hand-held weight.
   */
  private buildHands() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xeee4d4, roughness: 0.62 });
    const black = new THREE.MeshStandardMaterial({ color: 0x101013, roughness: 0.42, metalness: 0.3 });
    const cuffMat = new THREE.MeshStandardMaterial({ color: 0x2c3038, roughness: 0.95 });

    this.handTorch = new THREE.Group();
    this.handTorch.position.set(-0.21, -0.235, -0.35);
    this.handTorch.rotation.set(0.06, 0.26, -0.1); // tilted slightly inward

    // Torch along local -Z…+Z, gripped at its middle.
    const torchBody = new THREE.Mesh(new THREE.CylinderGeometry(0.033, 0.036, 0.27, 16), black);
    torchBody.rotation.x = Math.PI / 2;
    torchBody.position.z = -0.01;
    const torchTail = new THREE.Mesh(new THREE.SphereGeometry(0.033, 12, 10), black);
    torchTail.position.z = 0.125;
    torchTail.scale.z = 0.5;
    const torchHead = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.037, 0.075, 16), black);
    torchHead.rotation.x = Math.PI / 2;
    torchHead.position.z = -0.175;
    this.lensMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      emissive: 0xfff3d6,
      emissiveIntensity: 1.7,
      roughness: 0.2,
    });
    const lens = new THREE.Mesh(new THREE.CircleGeometry(0.04, 14), this.lensMat);
    lens.position.z = -0.214;
    lens.rotation.y = Math.PI;
    // Little red power switch.
    const torchSwitch = new THREE.Mesh(
      new THREE.BoxGeometry(0.013, 0.007, 0.028),
      new THREE.MeshStandardMaterial({
        color: 0x801818, emissive: 0xff2a22, emissiveIntensity: 0.7, roughness: 0.5,
      }),
    );
    torchSwitch.position.set(0, 0.038, -0.075);
    this.handTorch.add(torchBody, torchTail, torchHead, lens, torchSwitch);

    // Back of the hand — the meaty mass on the left side of the barrel,
    // tilted so it bridges the wrist into the finger roots.
    const backHand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 13), skin);
    backHand.scale.set(0.8, 1.12, 1.5);
    backHand.position.set(-0.05, -0.024, 0.022);
    backHand.rotation.z = 0.52;
    const palmHeel = new THREE.Mesh(new THREE.SphereGeometry(0.042, 13, 11), skin);
    palmHeel.scale.set(1.0, 0.8, 1.3);
    palmHeel.position.set(-0.018, -0.062, 0.055);
    this.handTorch.add(backHand, palmHeel);

    // Four fingers — articulated segment chains wrapping the barrel.
    // Each segment is a chord of the grip circle; knuckle spheres at joints.
    const GRIP_R = 0.0505;
    const fingerAt = (zOff: number, startDeg: number, spans: number[], r: number) => {
      const pt = (deg: number) =>
        new THREE.Vector3(
          Math.cos((deg * Math.PI) / 180) * GRIP_R,
          Math.sin((deg * Math.PI) / 180) * GRIP_R,
          zOff,
        );
      let a = startDeg;
      const knuckle = new THREE.Mesh(new THREE.SphereGeometry(r * 1.06, 9, 8), skin);
      knuckle.position.copy(pt(a));
      this.handTorch.add(knuckle);
      for (const span of spans) {
        const b = a - span; // wrap from the left side over the top
        const pa = pt(a), pb = pt(b);
        const dir = pb.clone().sub(pa);
        const seg = new THREE.Mesh(new THREE.CapsuleGeometry(r, dir.length(), 5, 10), skin);
        seg.position.copy(pa).add(pb).multiplyScalar(0.5);
        seg.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
        this.handTorch.add(seg);
        const joint = new THREE.Mesh(new THREE.SphereGeometry(r * 1.02, 9, 8), skin);
        joint.position.copy(pb);
        this.handTorch.add(joint);
        a = b;
      }
    };
    fingerAt(-0.082, 202, [62, 66, 50], 0.0140); // index
    fingerAt(-0.040, 198, [64, 70, 56], 0.0145); // middle
    fingerAt(0.002, 196, [62, 68, 54], 0.0140); // ring
    fingerAt(0.044, 194, [58, 62, 46], 0.0125); // pinky

    // Thumb — base from the palm heel, pad pressed along the barrel top-right.
    const thumbBase = new THREE.Mesh(new THREE.CapsuleGeometry(0.017, 0.045, 5, 10), skin);
    thumbBase.position.set(0.026, -0.028, 0.045);
    thumbBase.rotation.set(0.5, 0, -0.95);
    const thumbPad = new THREE.Mesh(new THREE.CapsuleGeometry(0.0155, 0.05, 5, 10), skin);
    thumbPad.position.set(0.047, 0.008, -0.005);
    thumbPad.rotation.set(1.45, 0.1, -0.3);
    const thumbTip = new THREE.Mesh(new THREE.SphereGeometry(0.0155, 9, 8), skin);
    thumbTip.position.set(0.046, 0.02, -0.038);
    this.handTorch.add(thumbBase, thumbPad, thumbTip);

    // Wrist + forearm running down toward the bottom-left of the screen.
    const foreDir = new THREE.Vector3(-0.26, -0.78, 0.56).normalize();
    const wrist = new THREE.Mesh(new THREE.CylinderGeometry(0.046, 0.052, 0.07, 13), skin);
    wrist.position.copy(foreDir).multiplyScalar(0.085).add(new THREE.Vector3(-0.03, -0.02, 0.02));
    wrist.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foreDir);
    const fore = new THREE.Mesh(new THREE.CapsuleGeometry(0.054, 0.36, 6, 14), skin);
    fore.position.copy(foreDir).multiplyScalar(0.27).add(new THREE.Vector3(-0.03, -0.02, 0.02));
    fore.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foreDir);
    // Jacket cuff where the arm leaves the frame.
    const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.064, 0.07, 0.1, 14), cuffMat);
    cuff.position.copy(foreDir).multiplyScalar(0.42).add(new THREE.Vector3(-0.03, -0.02, 0.02));
    cuff.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), foreDir);
    this.handTorch.add(wrist, fore, cuff);

    // Beam + lens sit at the torch tip (rig space, matching the tilt).
    this.flashlight.position.set(-0.29, -0.245, -0.56);

    this.handTorch.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = false;
    });
    this.lightRig.add(this.handTorch);
  }

  /* ------------------------------ input ------------------------------ */

  keyDown(code: string) {
    this.keys.add(code);
    if (code === "KeyF") this.toggleFlashlight();
    // Sneak is a TOGGLE on C. Not Ctrl: players hold their sneak key no
    // matter what the menu says, and a held Ctrl turns W into Ctrl+W —
    // which closes the tab and JS cannot block it outside fullscreen.
    if (code === "KeyC") this.sneaking = !this.sneaking;
    // Breaking into a run cancels sneak — nobody sprints quietly.
    if (code === "ShiftLeft" || code === "ShiftRight") this.sneaking = false;
  }
  keyUp(code: string) {
    this.keys.delete(code);
  }
  clearKeys() {
    this.keys.clear();
  }

  toggleFlashlight() {
    this.flashlightOn = !this.flashlightOn;
    this.onFlashlightToggle?.(this.flashlightOn);
  }

  /** Almond water: legs come back instantly. */
  restoreStamina() {
    this.stamina = 1;
    this.exhausted = false;
  }

  onMouseDelta(dx: number, dy: number) {
    // Chromium's pointer lock occasionally fires a single garbage event with
    // a huge delta (esp. on Windows + high-poll-rate mice) which snaps the
    // view across the room. Drop those, clamp the rest.
    if (Math.abs(dx) > 600 || Math.abs(dy) > 600) return;
    const cap = 280;
    dx = Math.max(-cap, Math.min(cap, dx));
    dy = Math.max(-cap, Math.min(cap, dy));
    const sens = 0.0021;
    this.yaw -= dx * sens;
    this.pitch -= dy * sens;
    const lim = Math.PI / 2 - 0.06;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  /* ------------------------------ update ------------------------------ */

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
  }

  get speed(): number {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  update(dt: number, time: number) {
    // --- movement intent (keys + virtual stick)
    let ix = 0, iz = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) iz -= 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) iz += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) ix -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) ix += 1;
    const stickMag = Math.hypot(this.touchMove.x, this.touchMove.z);
    if (stickMag > 0.12) {
      ix += this.touchMove.x;
      iz += this.touchMove.z;
    }
    const moving = ix !== 0 || iz !== 0;

    const wantSprint =
      ((this.keys.has("ShiftLeft") || this.keys.has("ShiftRight")) || stickMag > 0.94) &&
      moving && iz < 0 && !this.exhausted && !this.sneaking;
    this.sprinting = wantSprint && this.stamina > 0;

    // --- stamina (~7.7s of sprint, refills in ~7 — generous enough that
    // an alert player can actually outlast a chase)
    if (this.sprinting) {
      this.stamina = Math.max(0, this.stamina - dt * 0.13);
      this.staminaRegenDelay = 0.9;
      if (this.stamina === 0) this.exhausted = true;
    } else {
      this.staminaRegenDelay -= dt;
      if (this.staminaRegenDelay <= 0) {
        this.stamina = Math.min(1, this.stamina + dt * 0.16);
      }
      if (this.exhausted && this.stamina > 0.3) this.exhausted = false;
    }

    // --- velocity (camera-relative, exhausted players limp, sneakers creep)
    let maxSpeed = this.sprinting
      ? SPRINT_SPEED
      : this.exhausted ? WALK_SPEED * 0.7 : WALK_SPEED;
    if (this.sneaking) maxSpeed = WALK_SPEED * 0.48;
    if (this.noclip) maxSpeed *= 2.4;
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = 0, wz = 0;
    if (moving) {
      // FPS basis for yaw: forward = (-sin,-cos), right = (cos,-sin)
      const len = Math.hypot(ix, iz);
      const nx = ix / len, nz = iz / len;
      wx = (cos * nx + sin * nz) * maxSpeed;
      wz = (-sin * nx + cos * nz) * maxSpeed;
    }
    const accel = moving ? 16 : 11;
    this.vel.x += (wx - this.vel.x) * Math.min(1, accel * dt);
    this.vel.z += (wz - this.vel.z) * Math.min(1, accel * dt);

    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    if (!this.noclip) this.level.collide(this.pos, RADIUS);

    // --- head bob
    const speed = this.speed;
    const speedFactor = Math.min(1, speed / SPRINT_SPEED);
    if (speed > 0.3) {
      const prevCycle = Math.floor(this.bobPhase / Math.PI);
      this.bobPhase += dt * (4.4 + speed * 1.55);
      this.bobAmp += (1 - this.bobAmp) * Math.min(1, dt * 6);
      if (Math.floor(this.bobPhase / Math.PI) !== prevCycle && !this.sneaking) {
        this.onStep?.(this.sprinting); // sneaking = silent feet
      }
    } else {
      this.bobAmp *= Math.max(0, 1 - dt * 5);
    }
    const bobY = Math.sin(this.bobPhase * 2) * 0.026 * this.bobAmp * (0.5 + speedFactor);
    const bobX = Math.cos(this.bobPhase) * 0.018 * this.bobAmp * (0.5 + speedFactor);

    // --- idle breathing sway
    const breathe = Math.sin(time * 1.4) * 0.004;

    // --- crouch dip while sneaking
    this.crouch += ((this.sneaking ? 0.17 : 0) - this.crouch) * Math.min(1, dt * 7);

    // --- shake decay
    this.shake = Math.max(0, this.shake - dt * 1.8);
    const shX = (Math.random() - 0.5) * this.shake * 0.05;
    const shY = (Math.random() - 0.5) * this.shake * 0.05;

    this.camera.position.set(
      this.pos.x + bobX * Math.cos(this.yaw) + shX,
      EYE_HEIGHT - this.crouch + bobY + breathe + shY,
      this.pos.z + bobX * -Math.sin(this.yaw),
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0);

    // --- flashlight rig lags the camera (heavy hand feel)
    this.lightRig.position.copy(this.camera.position);
    const targetQ = this.camera.quaternion;
    this.lightRig.quaternion.slerp(targetQ, Math.min(1, dt * 11));

    // --- flashlight flicker driven by entity interference
    this.flickerTimer -= dt;
    if (this.flickerTimer <= 0) {
      if (this.flashlightInterference > 0.05 && Math.random() < this.flashlightInterference) {
        this.flickerState = Math.random() * 0.55;
        this.flickerTimer = 0.03 + Math.random() * 0.09;
      } else {
        this.flickerState = 1;
        this.flickerTimer = 0.05 + Math.random() * 0.1;
      }
    }
    // --- auto-dim against close surfaces: a wall half a meter out catches
    // inverse-square intensity and clips to a pure white disc. March the
    // aim ray to the first wall (and the floor/ceiling planes) and scale
    // the torch so close surfaces stay textured instead of blowing out.
    const DIM_RANGE = 6.2;
    let aimDist = DIM_RANGE;
    {
      const cosP = Math.cos(this.pitch);
      const dx = -Math.sin(this.yaw) * cosP;
      const dz = -Math.cos(this.yaw) * cosP;
      for (let d = 0.25; d < DIM_RANGE; d += 0.22) {
        if (this.level.solidAtWorld(this.pos.x + dx * d, this.pos.z + dz * d)) {
          aimDist = d;
          break;
        }
      }
      const eyeY = EYE_HEIGHT - this.crouch;
      const dirY = Math.sin(this.pitch);
      if (dirY < -0.05) aimDist = Math.min(aimDist, eyeY / -dirY);
      else if (dirY > 0.05) aimDist = Math.min(aimDist, (WALL_H - eyeY) / dirY);
    }
    // (d/range)^1.5 roughly cancels inverse-square inside DIM_RANGE, so the
    // lit spot keeps near-constant apparent brightness up close. Pages and
    // scrawls caught in the beam stay legible instead of vanishing into a
    // white disc — full power only returns at hallway distances.
    const dimTarget = Math.max(0.05, Math.min(1, Math.pow(aimDist / 6, 1.5)));
    this.torchDim += (dimTarget - this.torchDim) * Math.min(1, dt * 9);

    const subtle = 0.96 + Math.sin(time * 47) * 0.012 + Math.sin(time * 13.7) * 0.012;
    this.flashlight.intensity =
      (this.flashlightOn ? 46 : 0) * this.flickerState * subtle * this.torchDim;
    // Skip the whole shadow-map render while the torch is off — it's the
    // single most expensive light and contributes nothing when dark.
    this.flashlight.castShadow = this.flashlightOn;
    const lensOn = this.flashlightOn ? this.flickerState : 0;
    this.lensMat.emissiveIntensity = 1.7 * lensOn;

    // --- torch hand: subtle independent micro-sway
    this.handTorch.position.set(
      -0.21 + Math.sin(time * 1.1) * 0.0035,
      -0.235 + Math.sin(time * 1.7) * 0.005 + bobY * 0.55,
      -0.35,
    );

    // --- animate the 3D body (walk cycle driven by the bob phase)
    this.body.position.set(this.pos.x, 0, this.pos.z);
    this.body.rotation.y = this.yaw;
    const swing = Math.sin(this.bobPhase) * 0.5 * this.bobAmp * (0.45 + speedFactor * 0.55);
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    // Knees bend (backward = local +Z) as each leg recovers forward.
    const bend = 0.85 * this.bobAmp * (0.45 + speedFactor * 0.55);
    this.kneeL.rotation.x = Math.max(0, -Math.cos(this.bobPhase)) * bend;
    this.kneeR.rotation.x = Math.max(0, Math.cos(this.bobPhase)) * bend;
    // Lean: forward when sprinting, sideways into strafes.
    const rightX = Math.cos(this.yaw), rightZ = -Math.sin(this.yaw);
    const lateral = this.vel.x * rightX + this.vel.z * rightZ;
    this.body.rotation.z = THREE.MathUtils.clamp(-lateral * 0.022, -0.08, 0.08);
    this.torso.rotation.x = this.sprinting ? 0.12 * speedFactor : 0;

    // --- sprint FOV kick
    const targetFov = 72 + (this.sprinting ? 6 : 0) * speedFactor;
    if (Math.abs(this.camera.fov - targetFov) > 0.01) {
      this.camera.fov += (targetFov - this.camera.fov) * Math.min(1, dt * 5);
      this.camera.updateProjectionMatrix();
    }
  }
}
