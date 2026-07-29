import * as THREE from "three";
import { mulberry32, Rand, randInt, shuffle } from "./rng";
import {
  DOOR_VARIANTS,
  NOTICE_VARIANTS,
  makeCeilingMaps,
  makeDoorAtlasTexture,
  makeDoorPlaqueTexture,
  makeDoorTexture,
  makeExitSignTexture,
  makeFalseExitSignTexture,
  makeFireCabinetTexture,
  makeFloorMaps,
  makeLightPanelTexture,
  makeMeterPanelTexture,
  makeNoticeAtlasTexture,
  makeSafetySignTexture,
  makeTrimMaps,
  makeVentGrilleTexture,
  makeWallArtTexture,
  makeWallMaps,
} from "./textures";

export const CELL = 3.2; // meters per grid cell — corridor width
export const WALL_H = 2.7; // ceiling height
export const WALL_HALF = 0.12; // partition walls are 24cm thick
const PILLAR_HALF = 0.55;

export const OPEN = 0;
export const SOLID = 1; // out-of-bounds
export const PILLAR = 2;

export interface Fixture {
  index: number;
  pos: THREE.Vector3;
  state: "on" | "flicker" | "off";
  /** 0..1 — how strongly the entity's presence is suppressing this light */
  aura: number;
  phase: number;
  /** batten rotation — tubes run along the corridor they light */
  yaw: number;
  /** HDR panel color — mono-yellow except inside hue anomaly zones */
  base: [number, number, number];
}

export interface PageSpot {
  pos: THREE.Vector3;
  /** outward normal of the wall the page is pinned to */
  normal: THREE.Vector3;
}

interface ExitInfo {
  cell: { x: number; z: number };
  doorPos: THREE.Vector3;
  facing: THREE.Vector3;
  door: THREE.Mesh;
  sign: THREE.Mesh;
  light: THREE.PointLight;
}

/* Minimal indexed quad-mesh builder. */
class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  idx: number[] = [];

  quad(
    a: number[], b: number[], c: number[], d: number[],
    n: number[],
    uvs: [number, number][],
  ) {
    const base = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    for (let i = 0; i < 4; i++) this.nor.push(...n);
    for (const [u, v] of uvs) this.uv.push(u, v);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /**
   * Axis-aligned box from center + half extents. UVs are world-scaled by
   * `uvScale` so a tiling wood/plaster map runs continuously across it.
   */
  box(
    cx: number, cy: number, cz: number,
    hx: number, hy: number, hz: number,
    uvScale = 1,
  ) {
    const x0 = cx - hx, x1 = cx + hx;
    const y0 = cy - hy, y1 = cy + hy;
    const z0 = cz - hz, z1 = cz + hz;
    const s = uvScale;
    // +X / -X
    this.quad(
      [x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0],
      [[z1 * s, y0 * s], [z0 * s, y0 * s], [z0 * s, y1 * s], [z1 * s, y1 * s]],
    );
    this.quad(
      [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0],
      [[z0 * s, y0 * s], [z1 * s, y0 * s], [z1 * s, y1 * s], [z0 * s, y1 * s]],
    );
    // +Z / -Z
    this.quad(
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1],
      [[x0 * s, y0 * s], [x1 * s, y0 * s], [x1 * s, y1 * s], [x0 * s, y1 * s]],
    );
    this.quad(
      [x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1],
      [[x1 * s, y0 * s], [x0 * s, y0 * s], [x0 * s, y1 * s], [x1 * s, y1 * s]],
    );
    // +Y / -Y
    this.quad(
      [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0], [0, 1, 0],
      [[x0 * s, z1 * s], [x1 * s, z1 * s], [x1 * s, z0 * s], [x0 * s, z0 * s]],
    );
    this.quad(
      [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0],
      [[x0 * s, z0 * s], [x1 * s, z0 * s], [x1 * s, z1 * s], [x0 * s, z1 * s]],
    );
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute("normal", new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute("uv", new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.idx);
    return g;
  }
}

/**
 * Authentic Level 0: one huge open floor "randomly segmented" by thin
 * partition walls (recursive division with door gaps), so EVERY room is
 * enterable. Pillar halls, dark zones and a sealed border complete it.
 */
export class Level {
  readonly size = 48;
  grid: Uint8Array; // OPEN / PILLAR per cell
  /** wallV[x*size+z]: wall on the WEST edge of cell (x,z); x in 0..size */
  wallV: Uint8Array;
  /** wallH[x + z*size... see idx]: wall on the NORTH edge of cell (x,z); z in 0..size */
  wallH: Uint8Array;

  fixtures: Fixture[] = [];
  pageSpots: PageSpot[] = [];
  /** wall scrawls left by whoever was here before — pos + outward normal */
  artSpots: PageSpot[] = [];
  /** almond water bottles on the floor — exploration rewards */
  waterSpots: THREE.Vector3[] = [];
  /** red ceiling EXIT signs that point at nothing */
  falseExits: { pos: THREE.Vector3; yaw: number }[] = [];
  /**
   * Flat doors set into the partitions. `pos` sits on the wall face at floor
   * level, `normal` points out of the wall into the room you see it from.
   * None of them open. That is the point.
   */
  doorSpots: { pos: THREE.Vector3; normal: THREE.Vector3; variant: number }[] = [];
  /** hose cabinets, meter boxes, extinguishers and taped-up notices */
  fittingSpots: {
    pos: THREE.Vector3;
    normal: THREE.Vector3;
    kind: "hose" | "meter" | "extinguisher" | "notice";
    variant: number;
  }[] = [];
  spawn = new THREE.Vector3();
  spawnCell = { x: 0, z: 0 };
  entitySpawnCell = { x: 0, z: 0 };
  exit!: ExitInfo;
  group = new THREE.Group();

  private rng: Rand;
  private panelMesh!: THREE.InstancedMesh;
  private distFromSpawn!: Int32Array;
  /** cells already carrying a page or a scrawl — apartment doors keep clear */
  private decalCells = new Set<number>();
  /** sampled wall faces left over after the doors — fittings hang on these */
  private freeFaces: { x: number; z: number; nx: number; nz: number }[] = [];

  constructor(public seed: number) {
    this.rng = mulberry32(seed);
    this.grid = new Uint8Array(this.size * this.size).fill(OPEN);
    this.wallV = new Uint8Array((this.size + 1) * this.size);
    this.wallH = new Uint8Array(this.size * (this.size + 1));
    this.generate();
  }

  /* ------------------------- grid helpers ------------------------- */

  cell(x: number, z: number): number {
    if (x < 0 || z < 0 || x >= this.size || z >= this.size) return SOLID;
    return this.grid[z * this.size + x];
  }

  isBlocked(x: number, z: number): boolean {
    return this.cell(x, z) !== OPEN;
  }

  private vIdx(x: number, z: number) {
    return x * this.size + z;
  }
  private hIdx(x: number, z: number) {
    return z * this.size + x;
  }

  hasWallV(x: number, z: number): boolean {
    if (x < 0 || x > this.size || z < 0 || z >= this.size) return true;
    return this.wallV[this.vIdx(x, z)] === 1;
  }
  hasWallH(x: number, z: number): boolean {
    if (z < 0 || z > this.size || x < 0 || x >= this.size) return true;
    return this.wallH[this.hIdx(x, z)] === 1;
  }

  /** Can an agent step from cell (x,z) one cell in direction (dx,dz)? */
  canMove(x: number, z: number, dx: number, dz: number): boolean {
    const nx = x + dx, nz = z + dz;
    if (this.isBlocked(nx, nz)) return false;
    if (dx === 1) return !this.hasWallV(x + 1, z);
    if (dx === -1) return !this.hasWallV(x, z);
    if (dz === 1) return !this.hasWallH(x, z + 1);
    if (dz === -1) return !this.hasWallH(x, z);
    return true;
  }

  worldX(cx: number): number {
    return (cx - this.size / 2) * CELL + CELL / 2;
  }
  worldZ(cz: number): number {
    return (cz - this.size / 2) * CELL + CELL / 2;
  }
  cellOf(x: number, z: number): { x: number; z: number } {
    return {
      x: Math.floor(x / CELL + this.size / 2),
      z: Math.floor(z / CELL + this.size / 2),
    };
  }

  /**
   * Cell-to-cell visibility: march the segment between cell centers and
   * test every partition crossing (+ pillar cells) along the way.
   */
  lineOfSight(ax: number, az: number, bx: number, bz: number): boolean {
    if (this.isBlocked(bx, bz) && !(ax === bx && az === bz)) {
      // target inside a pillar/out of bounds — treat its center as opaque
      return false;
    }
    const x0 = this.worldX(ax), z0 = this.worldZ(az);
    const x1 = this.worldX(bx), z1 = this.worldZ(bz);
    const dist = Math.hypot(x1 - x0, z1 - z0);
    if (dist < 0.01) return true;
    const steps = Math.ceil(dist / 0.5);
    let cx = ax, cz = az;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const px = x0 + (x1 - x0) * t;
      const pz = z0 + (z1 - z0) * t;
      const c = this.cellOf(px, pz);
      while (cx !== c.x) {
        const sx = Math.sign(c.x - cx);
        if (sx > 0 ? this.hasWallV(cx + 1, cz) : this.hasWallV(cx, cz)) return false;
        cx += sx;
        if (this.cell(cx, cz) === PILLAR) return false;
      }
      while (cz !== c.z) {
        const sz = Math.sign(c.z - cz);
        if (sz > 0 ? this.hasWallH(cx, cz + 1) : this.hasWallH(cx, cz)) return false;
        cz += sz;
        if (this.cell(cx, cz) === PILLAR) return false;
      }
    }
    return true;
  }

  /* --------------------------- generation --------------------------- */

  private generate() {
    const S = this.size;
    const rng = this.rng;

    // 1) Sealed border.
    for (let z = 0; z < S; z++) {
      this.wallV[this.vIdx(0, z)] = 1;
      this.wallV[this.vIdx(S, z)] = 1;
    }
    for (let x = 0; x < S; x++) {
      this.wallH[this.hIdx(x, 0)] = 1;
      this.wallH[this.hIdx(x, S)] = 1;
    }

    // 2) "Randomly segmented empty rooms": recursive division with gaps.
    const divide = (x0: number, z0: number, x1: number, z1: number, depth: number) => {
      const w = x1 - x0 + 1;
      const h = z1 - z0 + 1;
      if (w < 3 && h < 3) return;
      // Sometimes leave a larger hall un-divided.
      if (w * h <= 24 && rng() < 0.16 && depth > 2) return;

      const vertical = w === h ? rng() < 0.5 : w > h;
      if (vertical && w >= 3) {
        const sx = randInt(rng, x0 + 1, x1); // wall on west edge of column sx
        for (let z = z0; z <= z1; z++) this.wallV[this.vIdx(sx, z)] = 1;
        // 1-2 door gaps, each 1-2 cells wide
        const gaps = 1 + (h > 5 && rng() < 0.55 ? 1 : 0);
        for (let g = 0; g < gaps; g++) {
          const gz = randInt(rng, z0, z1);
          this.wallV[this.vIdx(sx, gz)] = 0;
          if (rng() < 0.45 && gz + 1 <= z1) this.wallV[this.vIdx(sx, gz + 1)] = 0;
        }
        divide(x0, z0, sx - 1, z1, depth + 1);
        divide(sx, z0, x1, z1, depth + 1);
      } else if (h >= 3) {
        const sz = randInt(rng, z0 + 1, z1);
        for (let x = x0; x <= x1; x++) this.wallH[this.hIdx(x, sz)] = 1;
        const gaps = 1 + (w > 5 && rng() < 0.55 ? 1 : 0);
        for (let g = 0; g < gaps; g++) {
          const gx = randInt(rng, x0, x1);
          this.wallH[this.hIdx(gx, sz)] = 0;
          if (rng() < 0.45 && gx + 1 <= x1) this.wallH[this.hIdx(gx + 1, sz)] = 0;
        }
        divide(x0, z0, x1, sz - 1, depth + 1);
        divide(x0, sz, x1, z1, depth + 1);
      }
    };
    divide(0, 0, S - 1, S - 1, 0);

    // 3) Extra openings so rooms loop into each other (no dead-end farms).
    for (let x = 1; x < S; x++) {
      for (let z = 0; z < S; z++) {
        if (this.wallV[this.vIdx(x, z)] === 1 && rng() < 0.06) this.wallV[this.vIdx(x, z)] = 0;
      }
    }
    for (let z = 1; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (this.wallH[this.hIdx(x, z)] === 1 && rng() < 0.06) this.wallH[this.hIdx(x, z)] = 0;
      }
    }

    // 4) Pillar grids inside large open areas (classic pillar halls).
    for (let i = 0; i < 8; i++) {
      const cx = randInt(rng, 4, S - 5);
      const cz = randInt(rng, 4, S - 5);
      for (let z = cz - 3; z <= cz + 3; z++) {
        for (let x = cx - 3; x <= cx + 3; x++) {
          if (x % 2 !== 0 || z % 2 !== 0 || rng() > 0.7) continue;
          // pillars only in open space, never inside a doorway or wall line
          const clear =
            !this.hasWallV(x, z) && !this.hasWallV(x + 1, z) &&
            !this.hasWallH(x, z) && !this.hasWallH(x, z + 1);
          if (clear) this.grid[z * S + x] = PILLAR;
        }
      }
    }

    // 5) Spawn near the center on an open cell.
    const c = Math.floor(S / 2);
    outer: for (let radius = 0; radius < S; radius++) {
      for (let z = c - radius; z <= c + radius; z++) {
        for (let x = c - radius; x <= c + radius; x++) {
          if (this.cell(x, z) === OPEN) {
            this.spawnCell = { x, z };
            break outer;
          }
        }
      }
    }
    this.spawn.set(this.worldX(this.spawnCell.x), 0, this.worldZ(this.spawnCell.z));

    // 6) BFS distance field from spawn (wall-aware).
    this.distFromSpawn = new Int32Array(S * S).fill(-1);
    const queue: number[] = [this.spawnCell.z * S + this.spawnCell.x];
    this.distFromSpawn[queue[0]] = 0;
    let qi = 0;
    while (qi < queue.length) {
      const cur = queue[qi++];
      const cx = cur % S, cz = Math.floor(cur / S);
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (!this.canMove(cx, cz, dx, dz)) continue;
        const ni = (cz + dz) * S + (cx + dx);
        if (this.distFromSpawn[ni] === -1) {
          this.distFromSpawn[ni] = this.distFromSpawn[cur] + 1;
          queue.push(ni);
        }
      }
    }

    const reachable: { x: number; z: number; d: number }[] = [];
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        const d = this.distFromSpawn[z * S + x];
        if (d > 0) reachable.push({ x, z, d });
      }
    }
    reachable.sort((a, b) => a.d - b.d);

    // 7) Exit: farthest reachable cell on the border ring.
    let exitCell = reachable[reachable.length - 1];
    for (let i = reachable.length - 1; i >= 0; i--) {
      const { x, z } = reachable[i];
      if (x === 0 || z === 0 || x === S - 1 || z === S - 1) {
        exitCell = reachable[i];
        break;
      }
    }

    // 8) Eight pages across distance bands, pinned to partition walls.
    const bands = 8;
    const chosen: { x: number; z: number }[] = [];
    const placePage = (cand: { x: number; z: number }): boolean => {
      const wall = this.adjacentWall(cand.x, cand.z);
      if (!wall) return false;
      chosen.push(cand);
      this.decalCells.add(cand.z * S + cand.x);
      const inset = CELL / 2 - WALL_HALF - 0.03;
      const lateral = (this.rng() - 0.5) * 2.2;
      this.pageSpots.push({
        pos: new THREE.Vector3(
          this.worldX(cand.x) - wall.x * inset + wall.z * lateral,
          1.35 + this.rng() * 0.4,
          this.worldZ(cand.z) - wall.z * inset + wall.x * lateral,
        ),
        normal: new THREE.Vector3(wall.x, 0, wall.z),
      });
      return true;
    };
    // Band 0 is the starter page: 2-6 BFS steps from spawn (~8-24m walk),
    // so players stumble onto one early and learn what they're hunting.
    // Selecting by walk distance, not array fraction — cell count grows
    // quadratically, so even "2%" of cells lands 30m+ out.
    // GUARANTEED: if no near cell touches a wall (plaza spawns), widen the
    // ring until one does — every run must hand the player that first hope.
    for (let maxD = 6; chosen.length === 0 && maxD <= 30; maxD += 4) {
      const pool = shuffle(
        rng,
        reachable.filter(
          (c) => c.d >= 2 && c.d <= maxD && this.adjacentWall(c.x, c.z) !== null,
        ),
      );
      for (const cand of pool) if (placePage(cand)) break;
    }
    for (let b = 1; b < bands; b++) {
      const lo = Math.floor(reachable.length * (0.15 + (b / bands) * 0.8));
      const hi = Math.floor(reachable.length * (0.15 + ((b + 1) / bands) * 0.8)) - 1;
      for (let attempt = 0; attempt < 80; attempt++) {
        const cand = reachable[randInt(rng, lo, Math.max(lo, hi))];
        if (chosen.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 4)) continue;
        if (placePage(cand)) break;
      }
    }
    let safety = 0;
    while (this.pageSpots.length < bands && safety++ < 600) {
      const cand = reachable[randInt(rng, Math.floor(reachable.length * 0.1), reachable.length - 1)];
      if (chosen.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 3)) continue;
      placePage(cand);
    }

    // 8.5) Wall scrawls — every wall-adjacent cell is a candidate; shuffle
    // and take spaced ones. Kept off page cells so they never mask a page.
    const artCandidates = shuffle(
      rng,
      reachable.filter((c) => this.adjacentWall(c.x, c.z) !== null),
    );
    const artCells: { x: number; z: number }[] = [];
    for (const cand of artCandidates) {
      if (this.artSpots.length >= 14) break;
      if (chosen.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 2)) continue;
      if (artCells.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 3)) continue;
      const wall = this.adjacentWall(cand.x, cand.z)!;
      artCells.push(cand);
      this.decalCells.add(cand.z * S + cand.x);
      const inset = CELL / 2 - WALL_HALF - 0.015;
      const lateral = (this.rng() - 0.5) * 2.0;
      this.artSpots.push({
        pos: new THREE.Vector3(
          this.worldX(cand.x) - wall.x * inset + wall.z * lateral,
          1.05 + this.rng() * 0.75,
          this.worldZ(cand.z) - wall.z * inset + wall.x * lateral,
        ),
        normal: new THREE.Vector3(wall.x, 0, wall.z),
      });
    }

    // 8.7) Almond water — four bottles, mid-to-deep maze, spaced apart.
    // Something to stumble onto that makes wandering worth it.
    const waterCandidates = shuffle(
      rng,
      reachable.slice(Math.floor(reachable.length * 0.18)),
    );
    const waterCells: { x: number; z: number }[] = [];
    for (const cand of waterCandidates) {
      if (this.waterSpots.length >= 4) break;
      if (chosen.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 3)) continue;
      if (waterCells.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 10)) continue;
      waterCells.push(cand);
      const wall = this.adjacentWall(cand.x, cand.z);
      // tucked near a wall when there is one — reads "left behind", not "loot drop"
      const inset = CELL / 2 - WALL_HALF - 0.4;
      const px = wall
        ? this.worldX(cand.x) - wall.x * inset + wall.z * (this.rng() - 0.5) * 1.6
        : this.worldX(cand.x) + (this.rng() - 0.5) * 1.4;
      const pz = wall
        ? this.worldZ(cand.z) - wall.z * inset + wall.x * (this.rng() - 0.5) * 1.6
        : this.worldZ(cand.z) + (this.rng() - 0.5) * 1.4;
      this.waterSpots.push(new THREE.Vector3(px, 0, pz));
    }

    // 8.8) False EXIT signs — red, ceiling-hung, pointing nowhere. They
    // exist to be walked toward.
    const signCandidates = shuffle(
      rng,
      reachable.slice(Math.floor(reachable.length * 0.25)),
    );
    const signCells: { x: number; z: number }[] = [];
    for (const cand of signCandidates) {
      if (this.falseExits.length >= 6) break;
      if (signCells.some((p) => Math.abs(p.x - cand.x) + Math.abs(p.z - cand.z) < 8)) continue;
      signCells.push(cand);
      this.falseExits.push({
        pos: new THREE.Vector3(this.worldX(cand.x), WALL_H - 0.55, this.worldZ(cand.z)),
        yaw: randInt(rng, 0, 3) * (Math.PI / 2),
      });
    }

    // 9) Entity spawns far from the player.
    const farPool = reachable.slice(Math.floor(reachable.length * 0.7));
    const e = farPool[randInt(rng, 0, farPool.length - 1)];
    this.entitySpawnCell = { x: e.x, z: e.z };

    // 10) Ceiling battens: a regular lattice through the open rooms, plus a
    // guaranteed run down every one-cell corridor — a corridor whose lattice
    // parity happened to miss it would otherwise be pitch black end to end.
    const darkZones: { x: number; z: number; r: number }[] = [];
    for (let i = 0; i < 6; i++) {
      const zc = reachable[randInt(rng, Math.floor(reachable.length * 0.3), reachable.length - 1)];
      darkZones.push({ x: zc.x, z: zc.z, r: randInt(rng, 2, 4) });
    }
    let fi = 0;
    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (this.cell(x, z) !== OPEN) continue;
        // A batten runs the length of its corridor: walls north+south mean
        // the run is east-west, so the tube lies along X.
        const eastWest = this.hasWallH(x, z) && this.hasWallH(x, z + 1);
        const northSouth = this.hasWallV(x, z) && this.hasWallV(x + 1, z);
        const lattice = x % 2 === 1 && z % 2 === 1;
        const corridorSlot = eastWest
          ? x % 2 === 1
          : northSouth
            ? z % 2 === 1
            : false;
        if (!lattice && !corridorSlot &&
            !(x % 2 === 0 && z % 2 === 0 && rng() < 0.07)) continue;
        if (rng() < 0.1) continue; // randomly missing
        const inDark = darkZones.some(
          (zn) => (zn.x - x) * (zn.x - x) + (zn.z - z) * (zn.z - z) <= zn.r * zn.r,
        );
        // Base flicker is rare — page beacons (below) also flicker, and the
        // signal only reads if random flicker doesn't drown it out.
        const state: Fixture["state"] = inDark
          ? "off"
          : rng() < 0.045
            ? "flicker"
            : "on";
        this.fixtures.push({
          index: fi++,
          pos: new THREE.Vector3(this.worldX(x), WALL_H - 0.02, this.worldZ(z)),
          state,
          aura: 0,
          phase: rng() * 100,
          yaw: northSouth && !eastWest ? Math.PI / 2 : 0,
          base: [1.95, 1.72, 1.24],
        });
      }
    }

    let nearest: Fixture | null = null;
    let best = Infinity;
    for (const f of this.fixtures) {
      const d = f.pos.distanceToSquared(this.spawn);
      if (d < best) { best = d; nearest = f; }
    }
    if (nearest) nearest.state = "on";

    // 10.3) Hue anomalies: two or three deep pockets where the fluorescents
    // burn the wrong color — a sick red, a pale hospital green. The rest of
    // Level 0 stays canonically mono-yellow.
    const RED: [number, number, number] = [1.95, 0.4, 0.3];
    const GREEN: [number, number, number] = [1.0, 1.8, 0.75];
    const deepFixtures = this.fixtures.filter(
      (f) => f.pos.distanceToSquared(this.spawn) > 625, // >25m out
    );
    const hueCenters: THREE.Vector3[] = [];
    for (let i = 0; i < 3 && deepFixtures.length > 0; i++) {
      for (let attempt = 0; attempt < 30; attempt++) {
        const c = deepFixtures[randInt(rng, 0, deepFixtures.length - 1)];
        if (hueCenters.some((h) => h.distanceToSquared(c.pos) < 400)) continue;
        hueCenters.push(c.pos);
        const color = rng() < 0.55 ? RED : GREEN;
        const r = 5 + rng() * 3.5;
        for (const f of this.fixtures) {
          if (f.pos.distanceToSquared(c.pos) < r * r) f.base = color;
        }
        break;
      }
    }

    // 10.5) The fixture nearest each page sputters: "follow the dying
    // lights" becomes a learnable rule that quietly guides the hunt.
    for (const spot of this.pageSpots) {
      let bf: Fixture | null = null;
      let bd = Infinity;
      for (const f of this.fixtures) {
        const dx = f.pos.x - spot.pos.x;
        const dz = f.pos.z - spot.pos.z;
        const d = dx * dx + dz * dz;
        if (d < bd) { bd = d; bf = f; }
      }
      if (bf) bf.state = "flicker";
    }

    this.computeExit(exitCell);
    this.placeApartmentDoors();
  }

  /**
   * Line the partitions with flats. Every wall face bordering a room is a
   * candidate; roughly a third get a door, at most two per cell so a small
   * room doesn't turn into a showroom. Pages and scrawls own their cell —
   * doors stay off those so nothing overlaps a pickup.
   */
  private placeApartmentDoors() {
    const S = this.size;
    const rng = this.rng;
    const inset = CELL / 2 - WALL_HALF; // distance from cell center to wall face
    const ex = this.exit.cell;

    for (let z = 0; z < S; z++) {
      for (let x = 0; x < S; x++) {
        if (this.cell(x, z) !== OPEN) continue;
        if (this.decalCells.has(z * S + x)) continue;
        if (Math.abs(x - ex.x) + Math.abs(z - ex.z) <= 1) continue; // the way out stands alone

        // normals point out of the wall, into this cell
        const faces: { has: boolean; n: [number, number] }[] = [
          { has: this.hasWallV(x, z), n: [1, 0] },
          { has: this.hasWallV(x + 1, z), n: [-1, 0] },
          { has: this.hasWallH(x, z), n: [0, 1] },
          { has: this.hasWallH(x, z + 1), n: [0, -1] },
        ];
        let placed = 0;
        for (const f of faces) {
          if (!f.has) continue;
          if (placed >= 2 || rng() > 0.4) {
            // Left bare — remember a sample of these for the fittings pass.
            if (rng() < 0.12) {
              this.freeFaces.push({ x, z, nx: f.n[0], nz: f.n[1] });
            }
            continue;
          }
          placed++;
          const [nx, nz] = f.n;
          // slight jitter along the wall — nothing in this building is square
          const lateral = (rng() - 0.5) * 0.3;
          this.doorSpots.push({
            pos: new THREE.Vector3(
              this.worldX(x) - nx * inset - nz * lateral,
              0,
              this.worldZ(z) - nz * inset + nx * lateral,
            ),
            normal: new THREE.Vector3(nx, 0, nz),
            variant: randInt(rng, 0, DOOR_VARIANTS - 1),
          });
        }
      }
    }
    this.placeFittings();
  }

  /**
   * Hang the building's hardware on the bare wall faces: hose cabinets,
   * locked meter boxes, extinguishers standing in a corner, and the
   * residents' association's endless typed notices. Each kind is spread out
   * so you never round a corner into a wall of extinguishers.
   */
  private placeFittings() {
    const rng = this.rng;
    const inset = CELL / 2 - WALL_HALF;
    const pool = shuffle(rng, this.freeFaces.slice());
    const taken: { x: number; z: number; kind: string }[] = [];

    const wanted: [typeof this.fittingSpots[number]["kind"], number, number][] = [
      // kind, how many, how far apart (cells) from another of its kind
      ["hose", 12, 9],
      ["meter", 18, 7],
      ["extinguisher", 24, 6],
      ["notice", 34, 4],
    ];

    for (const [kind, count, spacing] of wanted) {
      let placed = 0;
      for (const f of pool) {
        if (placed >= count) break;
        if (taken.some(
          (t) => (t.kind === kind || Math.abs(t.x - f.x) + Math.abs(t.z - f.z) < 2) &&
                 Math.abs(t.x - f.x) + Math.abs(t.z - f.z) < spacing,
        )) continue;
        taken.push({ x: f.x, z: f.z, kind });
        placed++;
        const lateral = (rng() - 0.5) * 0.7;
        this.fittingSpots.push({
          pos: new THREE.Vector3(
            this.worldX(f.x) - f.nx * inset + f.nz * lateral,
            0,
            this.worldZ(f.z) - f.nz * inset - f.nx * lateral,
          ),
          normal: new THREE.Vector3(f.nx, 0, f.nz),
          kind,
          variant: randInt(rng, 0, NOTICE_VARIANTS - 1),
        });
      }
    }
  }

  /** Returns the normal (pointing INTO the cell) of a wall on this cell's edge. */
  private adjacentWall(x: number, z: number): { x: number; z: number } | null {
    if (this.cell(x, z) !== OPEN) return null;
    const candidates: { x: number; z: number }[] = [];
    if (this.hasWallV(x, z)) candidates.push({ x: 1, z: 0 }); // west wall faces +X
    if (this.hasWallV(x + 1, z)) candidates.push({ x: -1, z: 0 }); // east wall faces -X
    if (this.hasWallH(x, z)) candidates.push({ x: 0, z: 1 }); // north wall faces +Z
    if (this.hasWallH(x, z + 1)) candidates.push({ x: 0, z: -1 }); // south wall faces -Z
    if (candidates.length === 0) return null;
    return shuffle(this.rng, candidates)[0];
  }

  private computeExit(exitCell: { x: number; z: number }) {
    const S = this.size;
    // Face the door toward the nearest border wall.
    let facing = { x: 0, z: 1 };
    if (exitCell.x === 0) facing = { x: -1, z: 0 };
    else if (exitCell.x === S - 1) facing = { x: 1, z: 0 };
    else if (exitCell.z === 0) facing = { x: 0, z: -1 };
    else facing = { x: 0, z: 1 };

    const inset = CELL / 2 - WALL_HALF - 0.05;
    const wallX = this.worldX(exitCell.x) + facing.x * inset;
    const wallZ = this.worldZ(exitCell.z) + facing.z * inset;
    this.exit = {
      cell: exitCell,
      doorPos: new THREE.Vector3(wallX, 1.1, wallZ),
      facing: new THREE.Vector3(-facing.x, 0, -facing.z),
    } as ExitInfo;
  }

  /* ----------------------------- meshes ----------------------------- */

  build(scene: THREE.Scene) {
    const seed = this.seed;
    const wall = makeWallMaps(seed);
    const floor = makeFloorMaps(seed);
    const ceiling = makeCeilingMaps(seed);

    const wallMat = new THREE.MeshStandardMaterial({
      map: wall.map,
      normalMap: wall.normalMap,
      roughnessMap: wall.roughnessMap,
      normalScale: new THREE.Vector2(0.8, 0.8),
    });
    // Polished terrazzo: a touch of metalness sharpens the specular streak
    // the ceiling tubes smear down the corridor.
    const floorMat = new THREE.MeshStandardMaterial({
      map: floor.map,
      normalMap: floor.normalMap,
      roughnessMap: floor.roughnessMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      metalness: 0.12,
    });
    const ceilMat = new THREE.MeshStandardMaterial({
      map: ceiling.map,
      normalMap: ceiling.normalMap,
      roughnessMap: ceiling.roughnessMap,
      normalScale: new THREE.Vector2(0.5, 0.5),
    });

    const S = this.size;
    const min = this.worldX(0) - CELL / 2;
    const max = this.worldX(S - 1) + CELL / 2;

    // One giant floor + ceiling slab (the whole level is a single space).
    const floors = new GeoBuilder();
    floors.quad(
      [min, 0, min], [min, 0, max], [max, 0, max], [max, 0, min],
      [0, 1, 0],
      [[min / 2, min / 2], [min / 2, max / 2], [max / 2, max / 2], [max / 2, min / 2]],
    );
    const ceils = new GeoBuilder();
    ceils.quad(
      [min, WALL_H, min], [max, WALL_H, min], [max, WALL_H, max], [min, WALL_H, max],
      [0, -1, 0],
      // 4.6m repeat — deliberately off the 4m cell grid so the tiling never
      // lines up with the corridors you sight down.
      [[min / 4.6, min / 4.6], [max / 4.6, min / 4.6], [max / 4.6, max / 4.6], [min / 4.6, max / 4.6]],
    );

    const walls = new GeoBuilder();
    const T = WALL_HALF;

    // Vertical (north-south running) partitions on cell west/east edges.
    for (let x = 0; x <= S; x++) {
      for (let z = 0; z < S; z++) {
        if (!this.hasWallV(x, z)) continue;
        const wx = this.worldX(x) - CELL / 2; // edge plane
        const z0 = this.worldZ(z) - CELL / 2 - T;
        const z1 = this.worldZ(z) + CELL / 2 + T;
        const x0 = wx - T, x1 = wx + T;
        // west face (-X), east face (+X)
        walls.quad(
          [x0, 0, z0], [x0, 0, z1], [x0, WALL_H, z1], [x0, WALL_H, z0],
          [-1, 0, 0],
          [[z0 / CELL, 0], [z1 / CELL, 0], [z1 / CELL, 1], [z0 / CELL, 1]],
        );
        walls.quad(
          [x1, 0, z1], [x1, 0, z0], [x1, WALL_H, z0], [x1, WALL_H, z1],
          [1, 0, 0],
          [[z1 / CELL, 0], [z0 / CELL, 0], [z0 / CELL, 1], [z1 / CELL, 1]],
        );
        // end caps (only where no collinear continuation — doorway jambs)
        if (!this.hasWallV(x, z - 1)) {
          walls.quad(
            [x1, 0, z0], [x0, 0, z0], [x0, WALL_H, z0], [x1, WALL_H, z0],
            [0, 0, -1],
            [[x1 / CELL, 0], [x0 / CELL, 0], [x0 / CELL, 1], [x1 / CELL, 1]],
          );
        }
        if (!this.hasWallV(x, z + 1)) {
          walls.quad(
            [x0, 0, z1], [x1, 0, z1], [x1, WALL_H, z1], [x0, WALL_H, z1],
            [0, 0, 1],
            [[x0 / CELL, 0], [x1 / CELL, 0], [x1 / CELL, 1], [x0 / CELL, 1]],
          );
        }
      }
    }
    // Horizontal (east-west running) partitions on cell north/south edges.
    for (let z = 0; z <= S; z++) {
      for (let x = 0; x < S; x++) {
        if (!this.hasWallH(x, z)) continue;
        const wz = this.worldZ(z) - CELL / 2;
        const x0 = this.worldX(x) - CELL / 2 - T;
        const x1 = this.worldX(x) + CELL / 2 + T;
        const z0 = wz - T, z1 = wz + T;
        walls.quad(
          [x1, 0, z0], [x0, 0, z0], [x0, WALL_H, z0], [x1, WALL_H, z0],
          [0, 0, -1],
          [[x1 / CELL, 0], [x0 / CELL, 0], [x0 / CELL, 1], [x1 / CELL, 1]],
        );
        walls.quad(
          [x0, 0, z1], [x1, 0, z1], [x1, WALL_H, z1], [x0, WALL_H, z1],
          [0, 0, 1],
          [[x0 / CELL, 0], [x1 / CELL, 0], [x1 / CELL, 1], [x0 / CELL, 1]],
        );
        if (!this.hasWallH(x - 1, z)) {
          walls.quad(
            [x0, 0, z0], [x0, 0, z1], [x0, WALL_H, z1], [x0, WALL_H, z0],
            [-1, 0, 0],
            [[z0 / CELL, 0], [z1 / CELL, 0], [z1 / CELL, 1], [z0 / CELL, 1]],
          );
        }
        if (!this.hasWallH(x + 1, z)) {
          walls.quad(
            [x1, 0, z1], [x1, 0, z0], [x1, WALL_H, z0], [x1, WALL_H, z1],
            [1, 0, 0],
            [[z1 / CELL, 0], [z0 / CELL, 0], [z0 / CELL, 1], [z1 / CELL, 1]],
          );
        }
      }
    }

    // Pillars.
    for (let cz = 0; cz < S; cz++) {
      for (let cx = 0; cx < S; cx++) {
        if (this.cell(cx, cz) !== PILLAR) continue;
        const px0 = this.worldX(cx) - PILLAR_HALF;
        const px1 = this.worldX(cx) + PILLAR_HALF;
        const pz0 = this.worldZ(cz) - PILLAR_HALF;
        const pz1 = this.worldZ(cz) + PILLAR_HALF;
        walls.quad(
          [px0, 0, pz0], [px0, 0, pz1], [px0, WALL_H, pz1], [px0, WALL_H, pz0],
          [-1, 0, 0],
          [[pz0 / CELL, 0], [pz1 / CELL, 0], [pz1 / CELL, 1], [pz0 / CELL, 1]],
        );
        walls.quad(
          [px1, 0, pz1], [px1, 0, pz0], [px1, WALL_H, pz0], [px1, WALL_H, pz1],
          [1, 0, 0],
          [[pz1 / CELL, 0], [pz0 / CELL, 0], [pz0 / CELL, 1], [pz1 / CELL, 1]],
        );
        walls.quad(
          [px1, 0, pz0], [px0, 0, pz0], [px0, WALL_H, pz0], [px1, WALL_H, pz0],
          [0, 0, -1],
          [[px1 / CELL, 0], [px0 / CELL, 0], [px0 / CELL, 1], [px1 / CELL, 1]],
        );
        walls.quad(
          [px0, 0, pz1], [px1, 0, pz1], [px1, WALL_H, pz1], [px0, WALL_H, pz1],
          [0, 0, 1],
          [[px0 / CELL, 0], [px1 / CELL, 0], [px1 / CELL, 1], [px0 / CELL, 1]],
        );
      }
    }

    const floorMesh = new THREE.Mesh(floors.build(), floorMat);
    floorMesh.receiveShadow = true;
    const ceilMesh = new THREE.Mesh(ceils.build(), ceilMat);
    ceilMesh.receiveShadow = true;
    const wallMesh = new THREE.Mesh(walls.build(), wallMat);
    wallMesh.castShadow = true;
    wallMesh.receiveShadow = true;
    this.group.add(floorMesh, ceilMesh, wallMesh);

    this.buildFixtures();
    const notices = new GeoBuilder();
    this.buildApartmentDoors(notices);
    this.buildFittings(notices);
    this.buildWallArt();
    this.buildFalseExits();
    this.buildExit();

    scene.add(this.group);
  }

  /**
   * The flats. Every door in the building is one merged slab mesh plus one
   * merged architrave mesh, so the whole corridor costs two draw calls;
   * handles and letter plates ride along as instanced meshes.
   */
  private buildApartmentDoors(notices: GeoBuilder) {
    if (this.doorSpots.length === 0) return;
    const n = this.doorSpots.length;

    const HW = 0.5; // door half width
    const DH = 2.06; // door height
    const FB = 0.1; // architrave board width
    const FT = 0.028; // architrave half thickness — how far it stands proud
    const EPS = 0.008; // slab sits just off the plaster

    const slabs = new GeoBuilder();
    const frames = new GeoBuilder();
    const brass = new GeoBuilder();
    const vents = new GeoBuilder();
    const dummy = new THREE.Object3D();

    const plaqueMesh = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.085, 0.108),
      new THREE.MeshStandardMaterial({
        map: makeDoorPlaqueTexture(this.seed),
        roughness: 0.72,
      }),
      n,
    );

    this.doorSpots.forEach((spot, i) => {
      const { x: nx, z: nz } = spot.normal;
      // Screen-right along the wall when you stand facing the door.
      const tx = nz, tz = -nx;
      const at = (lat: number, y: number, out: number): number[] => [
        spot.pos.x + tx * lat + nx * out,
        y,
        spot.pos.z + tz * lat + nz * out,
      ];

      const u0 = spot.variant / DOOR_VARIANTS;
      const u1 = (spot.variant + 1) / DOOR_VARIANTS;
      slabs.quad(
        at(-HW, 0, EPS), at(HW, 0, EPS), at(HW, DH, EPS), at(-HW, DH, EPS),
        [nx, 0, nz],
        [[u0, 0], [u1, 0], [u1, 1], [u0, 1]],
      );

      // Architrave: two jambs and a lintel, standing proud of the wall.
      const half = (alongT: number, alongN: number) => ({
        hx: Math.abs(tx) * alongT + Math.abs(nx) * alongN,
        hz: Math.abs(tz) * alongT + Math.abs(nz) * alongN,
      });
      const jamb = half(FB / 2, FT);
      for (const side of [-1, 1]) {
        const c = at(side * (HW + FB / 2), 0, FT);
        frames.box(c[0], (DH + FB) / 2, c[2], jamb.hx, (DH + FB) / 2, jamb.hz, 2);
      }
      const lint = half(HW + FB, FT);
      const lc = at(0, 0, FT);
      frames.box(lc[0], DH + FB / 2, lc[2], lint.hx, FB / 2, lint.hz, 2);

      // Lever handle: a stub through the escutcheon and a bar turned back
      // toward the middle of the door, the way every one of these sits.
      const side = spot.variant % 2 === 0 ? 1 : -1;
      const stubT = half(0.022, 0.028);
      const sc = at(side * 0.32, 0, EPS + 0.028);
      brass.box(sc[0], 1.02, sc[2], stubT.hx, 0.022, stubT.hz, 4);
      const barT = half(0.058, 0.011);
      const bc = at(side * 0.32 - side * 0.052, 0, EPS + 0.067);
      brass.box(bc[0], 1.0, bc[2], barT.hx, 0.013, barT.hz, 4);

      // Letter plate, screwed to the plaster beside the frame.
      const pp = at(side * (HW + FB + 0.13), 0, 0.005);
      dummy.position.set(pp[0], 1.62, pp[2]);
      dummy.rotation.set(0, Math.atan2(nx, nz), 0, "YXZ");
      dummy.updateMatrix();
      plaqueMesh.setMatrixAt(i, dummy.matrix);

      // Some flats vent their hallway over the door.
      if (this.rng() < 0.32) {
        const vw = 0.19, vy0 = DH + FB + 0.06, vh = 0.11;
        vents.quad(
          at(-vw, vy0, EPS), at(vw, vy0, EPS),
          at(vw, vy0 + vh, EPS), at(-vw, vy0 + vh, EPS),
          [nx, 0, nz],
          [[0, 0], [1, 0], [1, 1], [0, 1]],
        );
      }
      // …and someone tapes a notice to one door in eight.
      if (this.rng() < 0.13) {
        const v = randInt(this.rng, 0, NOTICE_VARIANTS - 1);
        const nu0 = v / NOTICE_VARIANTS, nu1 = (v + 1) / NOTICE_VARIANTS;
        const nw = 0.075, ny = 1.42, nh = 0.21;
        const lat = -side * 0.12;
        notices.quad(
          at(lat - nw, ny, EPS + 0.004), at(lat + nw, ny, EPS + 0.004),
          at(lat + nw, ny + nh, EPS + 0.004), at(lat - nw, ny + nh, EPS + 0.004),
          [nx, 0, nz],
          [[nu0, 0], [nu1, 0], [nu1, 1], [nu0, 1]],
        );
      }
    });

    plaqueMesh.instanceMatrix.needsUpdate = true;

    const slabMesh = new THREE.Mesh(
      slabs.build(),
      new THREE.MeshStandardMaterial({
        map: makeDoorAtlasTexture(this.seed),
        roughness: 0.58, // varnish, long dulled
        metalness: 0.05,
      }),
    );
    slabMesh.receiveShadow = true;

    const trim = makeTrimMaps(this.seed);
    const frameMesh = new THREE.Mesh(
      frames.build(),
      new THREE.MeshStandardMaterial({
        map: trim.map,
        normalMap: trim.normalMap,
        roughnessMap: trim.roughnessMap,
        normalScale: new THREE.Vector2(0.4, 0.4),
      }),
    );
    frameMesh.castShadow = true;
    frameMesh.receiveShadow = true;

    const brassMesh = new THREE.Mesh(
      brass.build(),
      new THREE.MeshStandardMaterial({ color: 0x9c7f3c, roughness: 0.38, metalness: 0.8 }),
    );

    this.group.add(slabMesh, frameMesh, brassMesh, plaqueMesh);

    if (vents.idx.length > 0) {
      this.group.add(
        new THREE.Mesh(
          vents.build(),
          new THREE.MeshStandardMaterial({
            map: makeVentGrilleTexture(),
            roughness: 0.7,
            metalness: 0.2,
          }),
        ),
      );
    }
  }

  /**
   * Fire hose cabinets, meter boxes, extinguishers and the notices taped to
   * the plaster. Bodies are instanced boxes; every printed face is a quad
   * with its own small texture. The notices (walls and doors alike) merge
   * into the single geometry handed in from build().
   */
  private buildFittings(notices: GeoBuilder) {
    const dummy = new THREE.Object3D();
    const byKind = (k: string) => this.fittingSpots.filter((f) => f.kind === k);
    const hoses = byKind("hose");
    const meters = byKind("meter");
    const exts = byKind("extinguisher");

    const steel = (color: number, rough = 0.55, metal = 0.35) =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
    const printed = (map: THREE.CanvasTexture) =>
      new THREE.MeshStandardMaterial({ map, roughness: 0.6, metalness: 0.15 });

    /** Places one instanced part on a wall face. */
    const place = (
      mesh: THREE.InstancedMesh,
      i: number,
      spot: (typeof this.fittingSpots)[number],
      y: number,
      out: number,
    ) => {
      dummy.position.set(
        spot.pos.x + spot.normal.x * out,
        y,
        spot.pos.z + spot.normal.z * out,
      );
      dummy.rotation.set(0, Math.atan2(spot.normal.x, spot.normal.z), 0, "YXZ");
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      mesh.instanceMatrix.needsUpdate = true;
    };

    if (hoses.length > 0) {
      const body = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.64, 0.6, 0.17), steel(0x9c1f18, 0.5, 0.3), hoses.length,
      );
      const face = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.58, 0.54), printed(makeFireCabinetTexture(this.seed)), hoses.length,
      );
      body.castShadow = true;
      hoses.forEach((s, i) => {
        place(body, i, s, 1.32, 0.085);
        place(face, i, s, 1.32, 0.172);
      });
      this.group.add(body, face);
    }

    if (meters.length > 0) {
      const body = new THREE.InstancedMesh(
        new THREE.BoxGeometry(0.36, 0.46, 0.12), steel(0xa6a49c, 0.6, 0.45), meters.length,
      );
      const face = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.32, 0.42), printed(makeMeterPanelTexture(this.seed)), meters.length,
      );
      body.castShadow = true;
      meters.forEach((s, i) => {
        place(body, i, s, 1.52, 0.06);
        place(face, i, s, 1.52, 0.122);
      });
      this.group.add(body, face);
    }

    if (exts.length > 0) {
      // The bottle stands off the wall on its little bracket, sign above it.
      const bottle = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.088, 0.088, 0.54, 12), steel(0xa81d14, 0.45, 0.35), exts.length,
      );
      const neck = new THREE.InstancedMesh(
        new THREE.CylinderGeometry(0.03, 0.058, 0.17, 10), steel(0x1c1c1a, 0.6, 0.5), exts.length,
      );
      const sign = new THREE.InstancedMesh(
        new THREE.PlaneGeometry(0.15, 0.2), printed(makeSafetySignTexture()), exts.length,
      );
      bottle.castShadow = true;
      exts.forEach((s, i) => {
        place(bottle, i, s, 0.29, 0.2);
        place(neck, i, s, 0.63, 0.2);
        place(sign, i, s, 1.38, 0.006);
      });
      this.group.add(bottle, neck, sign);
    }

    // Notices on the plaster, at the height a hand tapes them.
    for (const s of this.fittingSpots) {
      if (s.kind !== "notice") continue;
      const { x: nx, z: nz } = s.normal;
      const tx = nz, tz = -nx;
      const at = (lat: number, y: number, out: number): number[] => [
        s.pos.x + tx * lat + nx * out,
        y,
        s.pos.z + tz * lat + nz * out,
      ];
      const u0 = s.variant / NOTICE_VARIANTS, u1 = (s.variant + 1) / NOTICE_VARIANTS;
      const w = 0.085, y0 = 1.35, h = 0.24;
      notices.quad(
        at(-w, y0, 0.006), at(w, y0, 0.006), at(w, y0 + h, 0.006), at(-w, y0 + h, 0.006),
        [nx, 0, nz],
        [[u0, 0], [u1, 0], [u1, 1], [u0, 1]],
      );
    }

    if (notices.idx.length > 0) {
      this.group.add(
        new THREE.Mesh(
          notices.build(),
          new THREE.MeshStandardMaterial({
            map: makeNoticeAtlasTexture(this.seed),
            roughness: 0.9,
          }),
        ),
      );
    }
  }

  /** Ink drawings from previous visitors, decaled onto partition walls. */
  private buildWallArt() {
    this.artSpots.forEach((spot, i) => {
      const size = 0.85 + this.rng() * 0.55;
      const mat = new THREE.MeshStandardMaterial({
        map: makeWallArtTexture(this.seed + 631 + i * 149),
        transparent: true,
        depthWrite: false, // decal — the wall behind it owns the depth
        roughness: 0.96,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), mat);
      mesh.position.copy(spot.pos);
      mesh.lookAt(spot.pos.clone().add(spot.normal));
      mesh.rotateZ((this.rng() - 0.5) * 0.24);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    });
  }

  private buildFixtures() {
    const n = this.fixtures.length;

    // Surface-mounted fluorescent battens, screwed straight to the slab —
    // no suspended grid in a building like this.
    const panelGeo = new THREE.PlaneGeometry(1.22, 0.115);
    panelGeo.rotateX(Math.PI / 2); // face down
    const panelMat = new THREE.MeshBasicMaterial({ map: makeLightPanelTexture() });
    this.panelMesh = new THREE.InstancedMesh(panelGeo, panelMat, n);

    const frameGeo = new THREE.BoxGeometry(1.3, 0.075, 0.17);
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xbfb9a6, roughness: 0.75 });
    const frameMesh = new THREE.InstancedMesh(frameGeo, frameMat, n);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const one = new THREE.Vector3(1, 1, 1);
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    for (const f of this.fixtures) {
      q.setFromEuler(e.set(0, f.yaw, 0));
      // diffuser hangs just clear of the housing's underside
      m.compose(p.set(f.pos.x, f.pos.y - 0.079, f.pos.z), q, one);
      this.panelMesh.setMatrixAt(f.index, m);
      m.compose(p.set(f.pos.x, f.pos.y - 0.04, f.pos.z), q, one);
      frameMesh.setMatrixAt(f.index, m);
      if (f.state === "off") col.setRGB(0.012, 0.012, 0.01);
      else col.setRGB(f.base[0], f.base[1], f.base[2]); // HDR — feeds bloom
      this.panelMesh.setColorAt(f.index, col);
    }
    this.panelMesh.instanceMatrix.needsUpdate = true;
    if (this.panelMesh.instanceColor) this.panelMesh.instanceColor.needsUpdate = true;
    this.group.add(this.panelMesh, frameMesh);
  }

  setFixtureColor(index: number, r: number, g: number, b: number) {
    const col = new THREE.Color(r, g, b);
    this.panelMesh.setColorAt(index, col);
    if (this.panelMesh.instanceColor) this.panelMesh.instanceColor.needsUpdate = true;
  }

  /** Red EXIT signs hanging mid-corridor. None of them are telling the truth. */
  private buildFalseExits() {
    const housingMat = new THREE.MeshStandardMaterial({ color: 0x1a0b0a, roughness: 0.85, metalness: 0.3 });
    const rodMat = new THREE.MeshStandardMaterial({ color: 0x222220, roughness: 0.8, metalness: 0.5 });
    const housingGeo = new THREE.BoxGeometry(0.66, 0.26, 0.055);
    const rodGeo = new THREE.CylinderGeometry(0.012, 0.012, 0.32);
    const faceGeo = new THREE.PlaneGeometry(0.6, 0.22);

    this.falseExits.forEach((fe, i) => {
      const g = new THREE.Group();
      g.position.copy(fe.pos);
      g.rotation.y = fe.yaw;

      const faceMat = new THREE.MeshBasicMaterial({
        map: makeFalseExitSignTexture(this.seed + i, this.rng() < 0.5 ? -1 : 1),
        // mildly HDR — enough for a sick red bloom halo in the fog
        color: new THREE.Color(1.35, 1.35, 1.35),
      });

      const housing = new THREE.Mesh(housingGeo, housingMat);
      const front = new THREE.Mesh(faceGeo, faceMat);
      front.position.z = 0.029;
      const back = new THREE.Mesh(faceGeo, faceMat);
      back.position.z = -0.029;
      back.rotation.y = Math.PI;
      const rod = new THREE.Mesh(rodGeo, rodMat);
      rod.position.y = 0.28;

      g.add(housing, front, back, rod);
      g.traverse((o) => {
        o.matrixAutoUpdate = false;
        o.updateMatrix();
      });
      g.updateMatrixWorld(true);
      this.group.add(g);
    });
  }

  private buildExit() {
    const facing = this.exit.facing;
    const angle = Math.atan2(facing.x, facing.z);

    const doorGroup = new THREE.Group();
    doorGroup.position.copy(this.exit.doorPos);
    doorGroup.rotation.y = angle;

    const doorMat = new THREE.MeshStandardMaterial({
      map: makeDoorTexture(this.seed),
      roughness: 0.55,
      metalness: 0.35,
    });
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.15, 2.2, 0.09), doorMat);
    door.castShadow = true;
    doorGroup.add(door);

    const frameMat = new THREE.MeshStandardMaterial({ color: 0x2c2e2a, roughness: 0.7, metalness: 0.4 });
    const sideGeo = new THREE.BoxGeometry(0.09, 2.32, 0.14);
    const left = new THREE.Mesh(sideGeo, frameMat);
    left.position.set(-0.64, 0.05, 0);
    const right = new THREE.Mesh(sideGeo, frameMat);
    right.position.set(0.64, 0.05, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.1, 0.14), frameMat);
    top.position.set(0, 1.18, 0);
    doorGroup.add(left, right, top);

    const bar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x8a8d86, roughness: 0.35, metalness: 0.8 }),
    );
    bar.rotation.z = Math.PI / 2;
    bar.position.set(0, -0.08, 0.09);
    doorGroup.add(bar);

    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.2),
      new THREE.MeshBasicMaterial({
        map: makeExitSignTexture(),
        color: new THREE.Color(1.6, 1.6, 1.6),
      }),
    );
    sign.position.set(0, 1.45, 0.12);
    doorGroup.add(sign);

    const light = new THREE.PointLight(0x39ff63, 2.2, 7, 2);
    light.position.set(0, 1.35, 0.45);
    doorGroup.add(light);

    this.exit.door = door;
    this.exit.sign = sign;
    this.exit.light = light;
    this.group.add(doorGroup);
  }

  /* --------------------------- collision --------------------------- */

  /**
   * Push a circle (player/entity footprint) out of partitions and pillars.
   * Mutates and returns `p`.
   */
  collide(p: THREE.Vector3, radius: number): THREE.Vector3 {
    const c = this.cellOf(p.x, p.z);
    const T = WALL_HALF;

    const resolveBox = (minX: number, maxX: number, minZ: number, maxZ: number) => {
      const nx = Math.max(minX, Math.min(p.x, maxX));
      const nz = Math.max(minZ, Math.min(p.z, maxZ));
      const ddx = p.x - nx;
      const ddz = p.z - nz;
      const distSq = ddx * ddx + ddz * ddz;
      if (distSq < radius * radius) {
        if (distSq > 1e-9) {
          const dist = Math.sqrt(distSq);
          p.x = nx + (ddx / dist) * radius;
          p.z = nz + (ddz / dist) * radius;
        } else {
          const pushL = p.x - minX, pushR = maxX - p.x;
          const pushB = p.z - minZ, pushF = maxZ - p.z;
          const m = Math.min(pushL, pushR, pushB, pushF);
          if (m === pushL) p.x = minX - radius;
          else if (m === pushR) p.x = maxX + radius;
          else if (m === pushB) p.z = minZ - radius;
          else p.z = maxZ + radius;
        }
      }
    };

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.x + dx, cz = c.z + dz;

        // pillar in this cell
        if (this.cell(cx, cz) === PILLAR) {
          resolveBox(
            this.worldX(cx) - PILLAR_HALF, this.worldX(cx) + PILLAR_HALF,
            this.worldZ(cz) - PILLAR_HALF, this.worldZ(cz) + PILLAR_HALF,
          );
        }
        if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) continue;

        // west edge wall of (cx,cz)
        if (this.hasWallV(cx, cz)) {
          const wx = this.worldX(cx) - CELL / 2;
          resolveBox(
            wx - T, wx + T,
            this.worldZ(cz) - CELL / 2 - T, this.worldZ(cz) + CELL / 2 + T,
          );
        }
        // east edge wall (west wall of cx+1)
        if (this.hasWallV(cx + 1, cz)) {
          const wx = this.worldX(cx) + CELL / 2;
          resolveBox(
            wx - T, wx + T,
            this.worldZ(cz) - CELL / 2 - T, this.worldZ(cz) + CELL / 2 + T,
          );
        }
        // north edge wall of (cx,cz)
        if (this.hasWallH(cx, cz)) {
          const wz = this.worldZ(cz) - CELL / 2;
          resolveBox(
            this.worldX(cx) - CELL / 2 - T, this.worldX(cx) + CELL / 2 + T,
            wz - T, wz + T,
          );
        }
        // south edge wall (north wall of cz+1)
        if (this.hasWallH(cx, cz + 1)) {
          const wz = this.worldZ(cz) + CELL / 2;
          resolveBox(
            this.worldX(cx) - CELL / 2 - T, this.worldX(cx) + CELL / 2 + T,
            wz - T, wz + T,
          );
        }
      }
    }
    return p;
  }

  /** Is this world-space point inside a partition wall or pillar? (XZ) */
  solidAtWorld(px: number, pz: number): boolean {
    const c = this.cellOf(px, pz);
    const kind = this.cell(c.x, c.z);
    if (kind === SOLID) return true;
    if (kind === PILLAR &&
        Math.abs(px - this.worldX(c.x)) <= PILLAR_HALF &&
        Math.abs(pz - this.worldZ(c.z)) <= PILLAR_HALF) return true;
    const T = WALL_HALF;
    if (this.hasWallV(c.x, c.z) && px - (this.worldX(c.x) - CELL / 2) <= T) return true;
    if (this.hasWallV(c.x + 1, c.z) && (this.worldX(c.x) + CELL / 2) - px <= T) return true;
    if (this.hasWallH(c.x, c.z) && pz - (this.worldZ(c.z) - CELL / 2) <= T) return true;
    if (this.hasWallH(c.x, c.z + 1) && (this.worldZ(c.z) + CELL / 2) - pz <= T) return true;
    return false;
  }

  /** Random reachable open cell at least `minDistFromSpawn` walking cells out. */
  randomOpenCell(rng: Rand, minDistFromSpawn = 0): { x: number; z: number } {
    const S = this.size;
    for (let i = 0; i < 400; i++) {
      const x = randInt(rng, 0, S - 1);
      const z = randInt(rng, 0, S - 1);
      const d = this.distFromSpawn[z * S + x];
      if (this.cell(x, z) === OPEN && d >= minDistFromSpawn) return { x, z };
    }
    return this.spawnCell;
  }
}
