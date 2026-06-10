import * as THREE from "three";
import { Level } from "./level";
import { makePageTexture, makeWaterLabelTexture, PAGE_TEXTS } from "./textures";

export const TOTAL_PAGES = 8;

export type Interactable =
  | { type: "page"; index: number; label: string }
  | { type: "water"; index: number; label: string }
  | { type: "door"; label: string };

interface Page {
  mesh: THREE.Mesh;
  collected: boolean;
  basePos: THREE.Vector3;
  phase: number;
}

interface WaterBottle {
  group: THREE.Group;
  labelMat: THREE.MeshStandardMaterial;
  taken: boolean;
  phase: number;
}

export class Items {
  pages: Page[] = [];
  waters: WaterBottle[] = [];
  collected = 0;
  exitOpen = false;

  private doorSwing = 0;
  private beyondLight!: THREE.PointLight;
  private beyondGlow!: THREE.Mesh;
  private vTo = new THREE.Vector3(); // scratch — called every frame

  constructor(private level: Level, seed: number, scene: THREE.Scene) {
    const geo = new THREE.PlaneGeometry(0.21, 0.28);
    this.level.pageSpots.slice(0, TOTAL_PAGES).forEach((spot, i) => {
      const tex = makePageTexture(seed, i);
      const mat = new THREE.MeshStandardMaterial({
        map: tex,
        emissive: 0xfff4cc,
        emissiveMap: tex,
        emissiveIntensity: 0.2, // catches the eye in darkness (pulsed in update)
        roughness: 0.92,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(spot.pos);
      mesh.lookAt(spot.pos.clone().add(spot.normal));
      mesh.rotateZ((Math.random() - 0.5) * 0.3);
      scene.add(mesh);
      this.pages.push({
        mesh,
        collected: false,
        basePos: spot.pos.clone(),
        phase: Math.random() * 10,
      });
    });

    // Almond water — a glass bottle someone abandoned. Full stamina + calm.
    const bodyGeo = new THREE.CylinderGeometry(0.046, 0.05, 0.21, 12);
    const liquidGeo = new THREE.CylinderGeometry(0.04, 0.044, 0.15, 12);
    const labelGeo = new THREE.CylinderGeometry(0.0485, 0.0505, 0.085, 12, 1, true);
    const capGeo = new THREE.CylinderGeometry(0.021, 0.021, 0.026, 10);
    // Dusty glass, not showroom glass — a sharp spec lobe under the torch
    // turns the whole bottle into a white stripe.
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x6e7f76,
      transparent: true,
      opacity: 0.3,
      roughness: 0.42,
      metalness: 0,
    });
    const liquidMat = new THREE.MeshStandardMaterial({
      color: 0x8f8266,
      transparent: true,
      opacity: 0.9,
      roughness: 0.55,
    });
    const capMat = new THREE.MeshStandardMaterial({ color: 0xb09040, roughness: 0.45, metalness: 0.6 });
    this.level.waterSpots.forEach((spot, i) => {
      const labelTex = makeWaterLabelTexture(seed + i);
      const labelMat = new THREE.MeshStandardMaterial({
        map: labelTex,
        emissive: 0xfff4cc,
        emissiveMap: labelTex,
        emissiveIntensity: 0.03, // same trick as pages — pulsed in update
        roughness: 0.85,
      });
      const g = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, glassMat);
      body.position.y = 0.105;
      const liquid = new THREE.Mesh(liquidGeo, liquidMat);
      liquid.position.y = 0.082;
      const label = new THREE.Mesh(labelGeo, labelMat);
      label.position.y = 0.1;
      const cap = new THREE.Mesh(capGeo, capMat);
      cap.position.y = 0.223;
      g.add(body, liquid, label, cap);
      g.position.copy(spot);
      g.scale.setScalar(1.32); // reads from a few meters without squinting
      g.rotation.y = Math.random() * Math.PI * 2;
      scene.add(g);
      this.waters.push({ group: g, labelMat, taken: false, phase: Math.random() * 10 });
    });

    // The white unknown waiting behind the exit door.
    const facing = this.level.exit.facing;
    const behind = this.level.exit.doorPos.clone().addScaledVector(facing, -0.6);
    this.beyondGlow = new THREE.Mesh(
      new THREE.PlaneGeometry(2.2, 3),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(1.7, 1.7, 1.55) }),
    );
    this.beyondGlow.position.set(behind.x, 1.4, behind.z);
    this.beyondGlow.lookAt(
      this.level.exit.doorPos.clone().addScaledVector(facing, 2),
    );
    this.beyondGlow.visible = false;
    scene.add(this.beyondGlow);

    this.beyondLight = new THREE.PointLight(0xfff8e8, 0, 9, 1.6);
    this.beyondLight.position.set(
      this.level.exit.doorPos.x + facing.x,
      1.6,
      this.level.exit.doorPos.z + facing.z,
    );
    scene.add(this.beyondLight);
  }

  get allCollected(): boolean {
    return this.collected >= Math.min(TOTAL_PAGES, this.pages.length);
  }

  /** Cheap cone test — what the player could grab right now. */
  findInteractable(camPos: THREE.Vector3, camDir: THREE.Vector3): Interactable | null {
    for (let i = 0; i < this.pages.length; i++) {
      const p = this.pages[i];
      if (p.collected) continue;
      const to = this.vTo.subVectors(p.mesh.position, camPos);
      const d = to.length();
      if (d < 2.6 && to.normalize().dot(camDir) > 0.8) {
        return { type: "page", index: i, label: "TAKE PAGE" };
      }
    }
    for (let i = 0; i < this.waters.length; i++) {
      const w = this.waters[i];
      if (w.taken) continue;
      const to = this.vTo.subVectors(w.group.position, camPos);
      const d = to.length();
      if (d < 2.4 && to.normalize().dot(camDir) > 0.78) {
        return { type: "water", index: i, label: "DRINK ALMOND WATER" };
      }
    }
    const toDoor = this.vTo.subVectors(this.level.exit.doorPos, camPos);
    const dd = toDoor.length();
    if (dd < 3 && toDoor.normalize().dot(camDir) > 0.7) {
      return this.allCollected
        ? { type: "door", label: this.exitOpen ? "ESCAPE" : "PUSH THE DOOR" }
        : { type: "door", label: `LOCKED — ${this.collected}/${TOTAL_PAGES} PAGES` };
    }
    return null;
  }

  collectPage(index: number): string[] {
    const p = this.pages[index];
    p.collected = true;
    p.mesh.visible = false;
    this.collected++;
    if (this.allCollected) {
      // The exit wakes up.
      this.level.exit.light.intensity = 6;
      (this.level.exit.sign.material as THREE.MeshBasicMaterial).color.setRGB(3.2, 3.2, 3.2);
    }
    return PAGE_TEXTS[index % PAGE_TEXTS.length];
  }

  drinkWater(index: number) {
    const w = this.waters[index];
    w.taken = true;
    w.group.visible = false;
  }

  openExit() {
    if (this.exitOpen) return;
    this.exitOpen = true;
    this.beyondGlow.visible = true;
    this.beyondLight.intensity = 9;
  }

  update(dt: number, time: number) {
    // Pages breathe on the wall — paper in a draft that shouldn't exist.
    // The glow pulses so a page at the edge of the torch cone reads as
    // "thing", not "wall stain". Players kept walking straight past them.
    for (const p of this.pages) {
      if (p.collected) continue;
      p.mesh.rotation.z += Math.sin(time * 1.7 + p.phase) * 0.0009;
      p.mesh.position.y = p.basePos.y + Math.sin(time * 2.3 + p.phase) * 0.0035;
      (p.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.18 + (Math.sin(time * 2.1 + p.phase) + 1) * 0.08;
    }
    for (const w of this.waters) {
      if (w.taken) continue;
      w.labelMat.emissiveIntensity = 0.02 + (Math.sin(time * 1.8 + w.phase) + 1) * 0.02;
    }

    // Door swings open once the player pushes it.
    if (this.exitOpen && this.doorSwing < 1) {
      this.doorSwing = Math.min(1, this.doorSwing + dt * 0.8);
      const ease = 1 - Math.pow(1 - this.doorSwing, 3);
      this.level.exit.door.rotation.y = -ease * 1.9;
      this.level.exit.door.position.x = -Math.sin(ease * 1.9) * 0.55;
      this.level.exit.door.position.z = -(1 - Math.cos(ease * 1.9)) * 0.55;
    }

    // Pulse the exit light once everything is collected.
    if (this.allCollected && !this.exitOpen) {
      this.level.exit.light.intensity = 5 + Math.sin(time * 3.2) * 2.4;
    }
  }
}
