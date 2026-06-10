import * as THREE from "three";
import { Level } from "./level";
import { makeEntityMaps } from "./textures";
import { mulberry32, Rand, randRange } from "./rng";

export type EntityState = "dormant" | "roam" | "stalk" | "chase" | "search";

export interface EntityContext {
  playerPos: THREE.Vector3;
  playerHead: THREE.Vector3;
  camDir: THREE.Vector3;
  playerSpeed: number;
  playerSprinting: boolean;
  playerSneaking: boolean;
  flashlightOn: boolean;
  time: number;
}

const ROAM_SPEED = 1.3;
const STALK_SPEED = 2.15;
// A hair SLOWER than the player's sprint (4.7): a chase you react to is
// survivable, a chase you fumble still kills. It used to outrun sprint,
// which made every scream a death sentence.
const CHASE_SPEED = 4.55;
const SEARCH_SPEED = 2.4;
const KILL_DIST = 1.3;

/**
 * The Wanderer. A too-tall, too-thin silhouette that owns the dark.
 * Procedurally modeled and animated — no rigs, just hierarchy + math.
 */
export class Entity {
  state: EntityState = "dormant";
  pos = new THREE.Vector3();
  root = new THREE.Group();
  frozen = false;

  onScreech: (() => void) | null = null;
  onKill: (() => void) | null = null;
  onStep: (() => void) | null = null;

  private rng: Rand;
  private heading = 0;
  // scratch vectors — keep the per-frame path allocation-free
  private vToPlayer = new THREE.Vector3();
  private vHead = new THREE.Vector3();
  private path: { x: number; z: number }[] = [];
  private repathTimer = 0;
  private waypoint: { x: number; z: number } | null = null;
  private lastKnownPlayer = new THREE.Vector3();
  private losLostTime = 0;
  private observedTime = 0;
  private searchTimer = 0;
  private farFromPlayerTime = 0;
  private walkPhase = 0;
  private twitchT = 0;
  private twitchVec = new THREE.Vector3();
  private twitchTimer = 1;

  // body parts for procedural animation
  private hips!: THREE.Group;
  private legL!: THREE.Group;
  private legR!: THREE.Group;
  private kneeL!: THREE.Group;
  private kneeR!: THREE.Group;
  private armL!: THREE.Group;
  private armR!: THREE.Group;
  private elbowL!: THREE.Group;
  private elbowR!: THREE.Group;
  private fingersL: THREE.Group[] = [];
  private fingersR: THREE.Group[] = [];
  private headGroup!: THREE.Group;
  private torso!: THREE.Mesh;

  constructor(private level: Level, seed: number) {
    this.rng = mulberry32(seed ^ 0xbeef);
    this.buildBody(seed);
    this.root.visible = false;
  }

  /* ----------------------------- body ----------------------------- */

  private buildBody(seed: number) {
    const maps = makeEntityMaps(seed);
    const skin = new THREE.MeshStandardMaterial({
      map: maps.map,
      normalMap: maps.normalMap,
      roughnessMap: maps.roughnessMap,
      normalScale: new THREE.Vector2(1.3, 1.3),
      color: 0x9a9a9a,
    });

    const HIP_Y = 1.32;

    this.hips = new THREE.Group();
    this.hips.position.y = HIP_Y;
    this.root.add(this.hips);

    // Legs — two segments with knees, pivoting at the hip.
    // Local +Z is the entity's forward.
    const makeLeg = (side: 1 | -1) => {
      const leg = new THREE.Group();
      leg.position.set(0.09 * side, 0, 0);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.045, 0.72, 7), skin);
      thigh.position.y = -0.36;
      const knee = new THREE.Group();
      knee.position.y = -0.72;
      const kneeCap = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), skin);
      const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 0.66, 7), skin);
      shin.position.y = -0.33;
      const foot = new THREE.Mesh(new THREE.SphereGeometry(0.055, 6, 5), skin);
      foot.scale.set(0.8, 0.45, 2.1);
      foot.position.set(0, -0.65, 0.07);
      knee.add(kneeCap, shin, foot);
      leg.add(thigh, knee);
      this.hips.add(leg);
      return { leg, knee };
    };
    ({ leg: this.legL, knee: this.kneeL } = makeLeg(-1));
    ({ leg: this.legR, knee: this.kneeR } = makeLeg(1));

    // Torso — gaunt two-piece spine, slightly hunched.
    const pelvis = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.09, 0.24, 8), skin);
    pelvis.position.y = 0.1;
    this.hips.add(pelvis);
    const torsoGeo = new THREE.CylinderGeometry(0.135, 0.095, 0.72, 8);
    torsoGeo.translate(0, 0.36, 0);
    this.torso = new THREE.Mesh(torsoGeo, skin);
    this.torso.position.y = 0.16;
    this.torso.rotation.x = 0.1;
    this.hips.add(this.torso);
    // Sunken-rib ridges across the chest.
    for (let i = 0; i < 3; i++) {
      const rib = new THREE.Mesh(new THREE.TorusGeometry(0.115 - i * 0.008, 0.008, 5, 10, Math.PI), skin);
      rib.rotation.x = Math.PI / 2 + 0.12;
      rib.rotation.z = Math.PI;
      rib.position.set(0, 0.42 - i * 0.07, 0.035);
      this.torso.add(rib);
    }

    // Arms — upper + forearm + skeletal hands with too-long fingers.
    const SHOULDER_Y = 0.68;
    const makeArm = (side: 1 | -1) => {
      const arm = new THREE.Group();
      arm.position.set(0.2 * side, SHOULDER_Y, 0);
      const shoulder = new THREE.Mesh(new THREE.SphereGeometry(0.058, 6, 5), skin);
      const upper = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.028, 0.62, 6), skin);
      upper.position.y = -0.31;
      const elbow = new THREE.Group();
      elbow.position.y = -0.62;
      const elbowCap = new THREE.Mesh(new THREE.SphereGeometry(0.034, 6, 5), skin);
      const fore = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.03, 0.56, 6), skin);
      fore.position.y = -0.28;
      const palm = new THREE.Mesh(new THREE.SphereGeometry(0.042, 6, 5), skin);
      palm.scale.set(0.85, 1.5, 0.6);
      palm.position.y = -0.58;
      const fingers: THREE.Group[] = [];
      for (let i = 0; i < 4; i++) {
        const f = new THREE.Group();
        f.position.set((i - 1.5) * 0.02 * side, -0.63, 0.005);
        f.rotation.z = (i - 1.5) * 0.1 * side;
        const seg = new THREE.Mesh(new THREE.CapsuleGeometry(0.0075, 0.17, 3, 5), skin);
        seg.position.y = -0.085;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.009, 5, 4), skin);
        tip.position.y = -0.18;
        f.add(seg, tip);
        fingers.push(f);
        elbow.add(f);
      }
      elbow.add(elbowCap, fore, palm);
      arm.add(shoulder, upper, elbow);
      this.torso.add(arm);
      return { arm, elbow, fingers };
    };
    const L = makeArm(-1);
    const R = makeArm(1);
    this.armL = L.arm; this.elbowL = L.elbow; this.fingersL = L.fingers;
    this.armR = R.arm; this.elbowR = R.elbow; this.fingersR = R.fingers;

    // Neck + gaunt lathed skull: narrow jaw, pinched cheeks, bulbous cranium.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.038, 0.05, 0.18, 7), skin);
    neck.position.set(0, 0.78, 0.01);
    this.torso.add(neck);

    this.headGroup = new THREE.Group();
    this.headGroup.position.set(0, 0.88, 0.02);
    const profile: THREE.Vector2[] = [
      new THREE.Vector2(0.001, 0),     // chin tip
      new THREE.Vector2(0.042, 0.018), // narrow jaw
      new THREE.Vector2(0.058, 0.07),
      new THREE.Vector2(0.066, 0.13),  // pinched cheeks
      new THREE.Vector2(0.094, 0.2),   // cheekbone
      new THREE.Vector2(0.112, 0.27),
      new THREE.Vector2(0.119, 0.34),  // swollen cranium
      new THREE.Vector2(0.096, 0.41),
      new THREE.Vector2(0.05, 0.45),
      new THREE.Vector2(0.001, 0.465), // crown
    ];
    const headGeo = new THREE.LatheGeometry(profile, 14);
    headGeo.scale(0.94, 1, 0.88);
    const head = new THREE.Mesh(headGeo, skin);
    head.position.y = -0.06;
    this.headGroup.add(head);

    const eyeMat = new THREE.MeshStandardMaterial({
      color: 0x050505,
      emissive: 0x6b1010,
      emissiveIntensity: 0.55,
      roughness: 0.1,
    });
    const eyeGeo = new THREE.SphereGeometry(0.015, 6, 6);
    const eyeL = new THREE.Mesh(eyeGeo, eyeMat);
    eyeL.position.set(-0.04, 0.16, 0.078);
    const eyeR = new THREE.Mesh(eyeGeo.clone(), eyeMat);
    eyeR.position.set(0.04, 0.16, 0.078);
    this.headGroup.add(eyeL, eyeR);
    this.torso.add(this.headGroup);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        o.castShadow = true;
      }
    });
  }

  addTo(scene: THREE.Scene) {
    scene.add(this.root);
  }

  get headWorldPos(): THREE.Vector3 {
    return this.headGroup.getWorldPosition(this.vHead);
  }

  /* ----------------------------- AI ----------------------------- */

  activate() {
    if (this.state !== "dormant") return;
    const c = this.level.entitySpawnCell;
    this.teleportToCell(c.x, c.z);
    this.setState("roam");
  }

  private teleportToCell(cx: number, cz: number) {
    this.pos.set(this.level.worldX(cx), 0, this.level.worldZ(cz));
    this.path = [];
    this.waypoint = null;
    this.root.visible = true;
  }

  private setState(s: EntityState) {
    if (s === this.state) return;
    const prev = this.state;
    this.state = s;
    this.path = [];
    this.repathTimer = 0;
    if (s === "chase" && prev !== "chase") {
      this.onScreech?.();
    }
    if (s === "search") this.searchTimer = 7;
  }

  /** Straight-line visibility between entity and player (grid based). */
  private hasLOS(target: THREE.Vector3): boolean {
    const a = this.level.cellOf(this.pos.x, this.pos.z);
    const b = this.level.cellOf(target.x, target.z);
    return this.level.lineOfSight(a.x, a.z, b.x, b.z);
  }

  update(dt: number, ctx: EntityContext): void {
    if (this.state === "dormant") return;

    const toPlayer = this.vToPlayer.subVectors(ctx.playerPos, this.pos);
    const dist = toPlayer.length();
    const los = this.hasLOS(ctx.playerPos);

    // Is the player looking at me? (LOS + within view cone + lit)
    // player->entity dot camDir, computed without allocating:
    const facingDot = dist > 1e-6
      ? -(ctx.camDir.x * toPlayer.x + ctx.camDir.y * toPlayer.y + ctx.camDir.z * toPlayer.z) / dist
      : 1;
    const observed =
      los && dist < 24 && facingDot > 0.82 && (ctx.flashlightOn || dist < 7);

    if (los) {
      this.lastKnownPlayer.copy(ctx.playerPos);
      this.losLostTime = 0;
    } else {
      this.losLostTime += dt;
    }

    // ---------- state transitions ----------
    switch (this.state) {
      case "roam": {
        this.frozen = false;
        // Sneaking players are much harder to notice.
        const noticeRange = ctx.playerSneaking ? 11 : 22;
        if (dist < noticeRange && (los || ctx.playerSprinting)) this.setState("stalk");
        // Horror director: if the player has been "safe" too long, close in.
        this.farFromPlayerTime = dist > 50 ? this.farFromPlayerTime + dt : 0;
        if (this.farFromPlayerTime > 30 && !los) {
          this.farFromPlayerTime = 0;
          this.relocateNear(ctx.playerPos, 6, 9);
        }
        break;
      }
      case "stalk": {
        this.frozen = observed && dist > 4.5;
        if (this.frozen) {
          this.observedTime += dt;
          if (this.observedTime > 3) {
            this.frozen = false;
            this.observedTime = 0;
            this.setState("chase"); // it knows that you know
          }
        } else {
          this.observedTime = Math.max(0, this.observedTime - dt * 0.5);
        }
        if (dist < (ctx.playerSneaking ? 5.5 : 8) && los && !this.frozen) this.setState("chase");
        if (dist > 36) this.setState("roam");
        break;
      }
      case "chase": {
        this.frozen = false;
        // Breaking line of sight is rewarded sooner — duck around a corner
        // and hold your nerve and it loses the thread.
        if (this.losLostTime > 3.5 && dist > 11) this.setState("search");
        break;
      }
      case "search": {
        this.frozen = false;
        this.searchTimer -= dt;
        if (los && dist < 20) this.setState("chase");
        else if (this.searchTimer <= 0) this.setState("roam");
        break;
      }
    }

    // ---------- kill check ----------
    if (dist < KILL_DIST) {
      this.onKill?.();
      return;
    }

    // ---------- pathing ----------
    const speed = this.frozen
      ? 0
      : this.state === "chase"
        ? CHASE_SPEED
        : this.state === "stalk"
          ? STALK_SPEED
          : this.state === "search"
            ? SEARCH_SPEED
            : ROAM_SPEED;

    this.repathTimer -= dt;
    if (this.repathTimer <= 0 && !this.frozen) {
      this.repathTimer = this.state === "chase" ? 0.35 : 0.8;
      this.computePath(ctx);
    }

    // Close-range chase with clear LOS: steer straight at them, no grid wobble.
    const directSteer = !this.frozen && this.state === "chase" && los && dist < 7;

    if (directSteer) {
      const dir = toPlayer.normalize();
      this.heading = Math.atan2(dir.x, dir.z);
      this.pos.x += dir.x * speed * dt;
      this.pos.z += dir.z * speed * dt;
      this.level.collide(this.pos, 0.38);
    } else if (!this.frozen && this.path.length > 0) {
      const wp = this.path[0];
      const wx = this.level.worldX(wp.x);
      const wz = this.level.worldZ(wp.z);
      const dx = wx - this.pos.x;
      const dz = wz - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6) {
        this.path.shift();
      } else {
        const targetHeading = Math.atan2(dx, dz);
        let diff = targetHeading - this.heading;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        const turnRate = this.state === "chase" ? 9 : 5;
        this.heading += diff * Math.min(1, dt * turnRate);

        this.pos.x += Math.sin(this.heading) * speed * dt;
        this.pos.z += Math.cos(this.heading) * speed * dt;
        this.level.collide(this.pos, 0.38);
      }
    }

    this.animate(dt, ctx, speed, dist);
  }

  private relocateNear(playerPos: THREE.Vector3, minCells: number, maxCells: number) {
    const pc = this.level.cellOf(playerPos.x, playerPos.z);
    for (let i = 0; i < 60; i++) {
      const ang = this.rng() * Math.PI * 2;
      const r = randRange(this.rng, minCells, maxCells);
      const cx = Math.round(pc.x + Math.cos(ang) * r);
      const cz = Math.round(pc.z + Math.sin(ang) * r);
      if (!this.level.isBlocked(cx, cz) && !this.level.lineOfSight(cx, cz, pc.x, pc.z)) {
        this.teleportToCell(cx, cz);
        return;
      }
    }
  }

  private computePath(ctx: EntityContext) {
    const from = this.level.cellOf(this.pos.x, this.pos.z);
    let target: { x: number; z: number };

    if (this.state === "chase" || this.state === "stalk") {
      target = this.level.cellOf(ctx.playerPos.x, ctx.playerPos.z);
    } else if (this.state === "search") {
      const lk = this.level.cellOf(this.lastKnownPlayer.x, this.lastKnownPlayer.z);
      if (!this.waypoint || (from.x === this.waypoint.x && from.z === this.waypoint.z)) {
        this.waypoint = {
          x: lk.x + Math.round(randRange(this.rng, -3, 3)),
          z: lk.z + Math.round(randRange(this.rng, -3, 3)),
        };
        if (this.level.isBlocked(this.waypoint.x, this.waypoint.z)) this.waypoint = lk;
      }
      target = this.waypoint;
    } else {
      if (!this.waypoint || (from.x === this.waypoint.x && from.z === this.waypoint.z)) {
        this.waypoint = this.level.randomOpenCell(this.rng, 8);
      }
      target = this.waypoint;
    }

    const path = this.aStar(from, target);
    if (path) this.path = path;
  }

  private aStar(
    from: { x: number; z: number },
    to: { x: number; z: number },
  ): { x: number; z: number }[] | null {
    if (this.level.isBlocked(to.x, to.z)) return null;
    const S = this.level.size;
    const key = (x: number, z: number) => z * S + x;
    const open = new Map<number, number>(); // key -> f
    const g = new Map<number, number>();
    const came = new Map<number, number>();
    const startK = key(from.x, from.z);
    const goalK = key(to.x, to.z);
    g.set(startK, 0);
    open.set(startK, Math.abs(to.x - from.x) + Math.abs(to.z - from.z));

    let iterations = 0;
    while (open.size > 0 && iterations++ < 2500) {
      // lowest f
      let curK = -1, curF = Infinity;
      for (const [k, f] of open) {
        if (f < curF) { curF = f; curK = k; }
      }
      if (curK === goalK) {
        const cells: { x: number; z: number }[] = [];
        let k = curK;
        while (k !== startK) {
          cells.push({ x: k % S, z: Math.floor(k / S) });
          k = came.get(k)!;
        }
        cells.reverse();
        return this.smoothPath(cells);
      }
      open.delete(curK);
      const cx = curK % S, cz = Math.floor(curK / S);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.level.canMove(cx, cz, dx, dz)) continue;
        const nx = cx + dx, nz = cz + dz;
        const nk = key(nx, nz);
        const ng = g.get(curK)! + 1;
        if (ng < (g.get(nk) ?? Infinity)) {
          g.set(nk, ng);
          came.set(nk, curK);
          open.set(nk, ng + Math.abs(to.x - nx) + Math.abs(to.z - nz));
        }
      }
    }
    return null;
  }

  /** Skip intermediate waypoints that have direct grid LOS — fewer zigzags. */
  private smoothPath(cells: { x: number; z: number }[]): { x: number; z: number }[] {
    if (cells.length <= 2) return cells;
    const out: { x: number; z: number }[] = [];
    let anchor = this.level.cellOf(this.pos.x, this.pos.z);
    let i = 0;
    while (i < cells.length) {
      let j = Math.min(i + 6, cells.length - 1);
      while (j > i && !this.level.lineOfSight(anchor.x, anchor.z, cells[j].x, cells[j].z)) {
        j--;
      }
      out.push(cells[j]);
      anchor = cells[j];
      i = j + 1;
    }
    return out;
  }

  /* ----------------------------- animation ----------------------------- */

  private animate(dt: number, ctx: EntityContext, speed: number, dist: number) {
    this.root.position.copy(this.pos);
    this.root.rotation.y = this.heading;

    // Walk cycle.
    if (speed > 0.01) {
      const prevCycle = Math.floor(this.walkPhase / Math.PI);
      this.walkPhase += dt * (2.1 + speed * 1.9);
      if (Math.floor(this.walkPhase / Math.PI) !== prevCycle) this.onStep?.();
    }
    const amp = this.frozen ? 0 : Math.min(0.95, 0.22 + speed * 0.16);
    const swing = Math.sin(this.walkPhase) * amp;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;

    // Knees flex while each leg recovers forward — a stilted, high gait.
    const flex = 0.14 + (this.state === "chase" ? 0.1 : 0);
    this.kneeL.rotation.x = -(flex + Math.max(0, Math.cos(this.walkPhase)) * 0.85 * amp);
    this.kneeR.rotation.x = -(flex + Math.max(0, -Math.cos(this.walkPhase)) * 0.85 * amp);

    // Arms: dangle counter-swing; raise and reach when closing in.
    const reach = this.state === "chase" && dist < 5 ? 1 : 0;
    const armSwing = Math.sin(this.walkPhase) * amp * 0.45;
    const k = Math.min(1, dt * 6);
    this.armL.rotation.x += ((-armSwing + reach * 1.5) - this.armL.rotation.x) * k;
    this.armR.rotation.x += ((armSwing + reach * 1.5) - this.armR.rotation.x) * k;
    // Elbows hang loosely bent; the reach snaps them straight.
    const elbowTarget = 0.22 - reach * 0.16;
    this.elbowL.rotation.x += (elbowTarget - this.elbowL.rotation.x) * k;
    this.elbowR.rotation.x += (elbowTarget - this.elbowR.rotation.x) * k;
    // Fingers: slack curl normally; splayed and trembling for the grab.
    for (let i = 0; i < 4; i++) {
      const idleCurl = 0.5 + Math.sin(ctx.time * 2.2 + i * 1.3) * 0.06;
      const grabCurl = 0.08 + Math.sin(ctx.time * 21 + i * 2.1) * 0.1;
      const target = idleCurl + (grabCurl - idleCurl) * reach;
      this.fingersL[i].rotation.x += (target - this.fingersL[i].rotation.x) * k;
      this.fingersR[i].rotation.x += (target - this.fingersR[i].rotation.x) * k;
    }

    // Body bob + low predatory crouch during chase.
    this.hips.position.y = 1.32 + (this.frozen ? 0 : Math.abs(Math.sin(this.walkPhase)) * 0.05)
      - (this.state === "chase" ? 0.07 : 0);
    this.torso.rotation.x = 0.1 + (this.state === "chase" ? 0.22 : 0);

    // Head tracks the player whenever it's aware of them.
    const aware = this.state !== "roam" || dist < 18;
    if (aware) {
      const headPos = this.headWorldPos;
      const target = ctx.playerHead;
      const dx = target.x - headPos.x;
      const dy = target.y - headPos.y;
      const dz = target.z - headPos.z;
      const horiz = Math.hypot(dx, dz);
      // world direction -> head-local yaw (body already faces `heading`)
      let yaw = Math.atan2(dx, dz) - this.heading;
      while (yaw > Math.PI) yaw -= Math.PI * 2;
      while (yaw < -Math.PI) yaw += Math.PI * 2;
      yaw = Math.max(-1.25, Math.min(1.25, yaw));
      const pitch = Math.max(-0.7, Math.min(0.7, Math.atan2(-dy, horiz)));
      const rate = this.frozen ? 22 : 7;
      this.headGroup.rotation.y += (yaw - this.headGroup.rotation.y) * Math.min(1, dt * rate);
      this.headGroup.rotation.x += (pitch - this.headGroup.rotation.x) * Math.min(1, dt * rate);
    } else {
      // Slow, wrong-looking scan of the room.
      this.headGroup.rotation.y = Math.sin(ctx.time * 0.45) * 0.9;
      this.headGroup.rotation.x = Math.sin(ctx.time * 0.3) * 0.15;
    }

    // Twitch — sudden violent jitter, the uncanny signature move.
    this.twitchTimer -= dt;
    if (this.twitchTimer <= 0) {
      this.twitchTimer = this.frozen
        ? randRange(this.rng, 2.5, 6)
        : randRange(this.rng, 0.7, 3.2);
      this.twitchT = 1;
      this.twitchVec.set(
        (this.rng() - 0.5) * 1.6,
        (this.rng() - 0.5) * 2.2,
        (this.rng() - 0.5) * 1.2,
      );
    }
    if (this.twitchT > 0) {
      this.twitchT = Math.max(0, this.twitchT - dt * 9);
      const t = this.twitchT;
      this.headGroup.rotation.x += this.twitchVec.x * t * 0.35;
      this.headGroup.rotation.y += this.twitchVec.y * t * 0.35;
      this.headGroup.rotation.z = this.twitchVec.z * t * 0.3;
      this.torso.rotation.z = this.twitchVec.z * t * 0.12;
    } else {
      this.headGroup.rotation.z *= 1 - Math.min(1, dt * 10);
      this.torso.rotation.z *= 1 - Math.min(1, dt * 10);
    }
  }
}
