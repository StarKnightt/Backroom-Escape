import * as THREE from "three";
import { Level } from "./level";
import { Player } from "./player";
import { Entity } from "./entity";
import { GameAudio } from "./audio";
import { GameFX } from "./fx";
import { Items, TOTAL_PAGES } from "./items";
import { randRange } from "./rng";

export type GameState = "idle" | "playing" | "paused" | "dying" | "dead" | "won";

export interface HudState {
  pages: number;
  totalPages: number;
  stamina: number;
  prompt: string | null;
  objective: string;
  flashlight: boolean;
  sneaking: boolean;
  /** compact list of active cheats, e.g. "GOD · NOCLIP" — null when none */
  cheats: string | null;
}

export interface EngineCallbacks {
  onState: (state: GameState) => void;
  onHud: (hud: HudState) => void;
  onPageText: (lines: string[]) => void;
  onStats: (stats: { pages: number; seconds: number }) => void;
  onToast: (msg: string) => void;
}

const POOL_SIZE = 12;
const UP = new THREE.Vector3(0, 1, 0);
/** keys the browser must not act on while playing (Ctrl+S, space scroll…) */
const GAME_KEYS = new Set([
  "KeyW", "KeyA", "KeyS", "KeyD",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  "ShiftLeft", "ShiftRight", "ControlLeft", "ControlRight",
  "KeyE", "KeyF", "KeyC", "Space",
]);

export class Engine {
  state: GameState = "idle";

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private level: Level;
  private player: Player;
  private entity: Entity;
  private items: Items;
  private audio = new GameAudio();
  private fx: GameFX;

  private clock = new THREE.Clock();
  private elapsed = 0;
  private raf = 0;

  private fear = 0;
  private fearSpike = 0;
  private glitch = 0;
  private beatPhase = 0;
  private deathT = 0;
  private startedAt = 0;

  private lightPool: THREE.PointLight[] = [];
  private fixtureMult: Float32Array;
  private fixtureBurst = new Map<number, number>();
  /** dead fixtures temporarily sputtering alive — index -> seconds left */
  private fixtureFlare = new Map<number, number>();
  private nextAmbientEvent = 18;
  private hudTimer = 0;
  private lastPrompt: string | null = null;

  /** dev cheats — unlocked by typing "redrum" while playing */
  readonly cheats = { unlocked: false, god: false, noclip: false, fullbright: false, freeze: false };
  private cheatBuffer = "";
  /** one-time "sneak is C, not Ctrl" toast for muscle-memory players */
  private ctrlHintShown = false;
  private brightLight: THREE.AmbientLight | null = null;

  // pointer-lock bookkeeping (Chromium enforces a ~1.25s relock cooldown)
  private unlockAt = -10000;
  private pendingLock: ReturnType<typeof setTimeout> | null = null;
  /** true once a pointer lock has ever engaged — arms the in-game watchdog */
  private hasLockedOnce = false;
  private lockLossT = 0;
  /** ignore mousemove until this time — lock engagement fires garbage deltas */
  private lockGraceUntil = 0;
  /** primary input is touch (phone/tablet) — no pointer lock on these */
  readonly touchPrimary =
    typeof window !== "undefined" &&
    window.matchMedia?.("(pointer: coarse)").matches === true;

  // scratch vectors — the hot loop must not allocate (GC pauses = stutter)
  private vCamDir = new THREE.Vector3();
  private vA = new THREE.Vector3();
  private vB = new THREE.Vector3();
  private nearestLitSq = Infinity;

  private disposed = false;
  private detachInput: (() => void) | null = null;

  constructor(
    private container: HTMLElement,
    private canvas: HTMLCanvasElement,
    private callbacks: EngineCallbacks,
    seed = (Date.now() ^ (Math.random() * 0xffffff)) >>> 0,
  ) {
    const width = container.clientWidth;
    const height = container.clientHeight;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(width, height, false);
    // Render at the device's native pixel ratio (capped — phones report 3+).
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;

    const fogColor = new THREE.Color(0x141106);
    this.scene.background = fogColor;
    this.scene.fog = new THREE.FogExp2(fogColor, 0.036);

    // The mono-yellow wash: ceiling glow above, carpet bounce below.
    // Level 0 is BRIGHT — the horror is the emptiness, not the dark.
    this.scene.add(new THREE.AmbientLight(0x3a3420, 0.85));
    this.scene.add(new THREE.HemisphereLight(0xfff0c2, 0x4a3f24, 0.5));

    this.level = new Level(seed);
    this.level.build(this.scene);
    this.fixtureMult = new Float32Array(this.level.fixtures.length).fill(-1);

    this.player = new Player(this.level, width / height);
    this.player.addTo(this.scene);
    this.player.onStep = (sprinting) => this.audio.playerStep(sprinting);

    this.entity = new Entity(this.level, seed);
    this.entity.addTo(this.scene);
    this.entity.onScreech = () => this.onScreech();
    this.entity.onStep = () => this.onEntityStep();
    this.entity.onKill = () => this.beginDeath();

    this.items = new Items(this.level, seed, this.scene);

    for (let i = 0; i < POOL_SIZE; i++) {
      const l = new THREE.PointLight(0xffeebb, 0, 13, 1.8);
      this.lightPool.push(l);
      this.scene.add(l);
    }

    this.fx = new GameFX(this.renderer, this.scene, this.player.camera, width, height);

    this.attachInput();
    this.loop();
  }

  /* ----------------------------- lifecycle ----------------------------- */

  start() {
    if (this.state !== "idle") return;
    this.audio.init();
    void this.audio.resume();
    this.setState("playing");
    this.startedAt = this.elapsed;
    if (this.touchPrimary) this.enterTouchFullscreen();
    else this.lockPointer();
    this.pushHud(true);
  }

  resume() {
    if (this.state !== "paused") return;
    if (this.touchPrimary) {
      // No pointer lock on touch devices — resume directly (and re-grab
      // fullscreen, the back gesture / Esc may have dropped it).
      this.enterTouchFullscreen();
      void this.audio.resume();
      this.setState("playing");
      return;
    }
    // The state flips to "playing" once the pointer lock actually engages
    // (see onLockChange) — flipping early would fight the relock cooldown.
    this.lockPointer();
  }

  /**
   * Phones only: browser chrome eats ~25% of a small landscape screen, so
   * go fullscreen on the start/resume tap (a user gesture, as required).
   * Desktop deliberately stays in-tab. iPhone Safari has no Fullscreen API
   * at all — there the manifest's display:fullscreen (add to home screen)
   * is the only route, so a rejection here is silently ignored.
   */
  private enterTouchFullscreen() {
    if (document.fullscreenElement) return;
    try {
      const p = document.documentElement.requestFullscreen?.({ navigationUI: "hide" });
      void p
        ?.then(() => {
          // Pin landscape while fullscreen (Android; needs fullscreen first).
          const o = screen.orientation as ScreenOrientation & {
            lock?: (o: string) => Promise<void>;
          };
          return o.lock?.("landscape");
        })
        .catch(() => {});
    } catch {
      // older WebKit throws synchronously — nothing to do
    }
  }

  /** External pause (pause button on touch UI / rotate-to-portrait). */
  pause() {
    if (this.state !== "playing") return;
    this.player.clearKeys();
    this.player.touchMove.x = 0;
    this.player.touchMove.z = 0;
    void this.audio.suspend();
    this.setState("paused");
  }

  private setState(s: GameState) {
    if (this.state === s) return;
    this.state = s;
    this.callbacks.onState(s);
  }

  /**
   * Cooldown-aware pointer lock. Chromium rejects requestPointerLock for
   * ~1.25s after an unlock; firing into that window silently fails and the
   * game feels like "the mouse stopped working". Queue the request instead.
   */
  private lockPointer() {
    if (this.pendingLock !== null) {
      clearTimeout(this.pendingLock);
      this.pendingLock = null;
    }
    const wait = 1350 - (performance.now() - this.unlockAt);
    if (wait > 0) {
      this.pendingLock = setTimeout(() => {
        this.pendingLock = null;
        if (!this.disposed && document.pointerLockElement !== this.canvas) {
          this.doLock();
        }
      }, wait);
    } else {
      this.doLock();
    }
  }

  private doLock() {
    const el = this.canvas as HTMLCanvasElement & {
      requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
    };
    try {
      const res = el.requestPointerLock({ unadjustedMovement: true });
      if (res && typeof (res as Promise<void>).catch === "function") {
        (res as Promise<void>).catch(() => el.requestPointerLock());
      }
    } catch {
      el.requestPointerLock();
    }
  }

  private attachInput() {
    const onMouseMove = (e: MouseEvent) => {
      if (this.state === "playing" && document.pointerLockElement === this.canvas) {
        // Chromium fires bogus movement deltas right as the lock engages
        // (cursor recenter leaks in) — would snap the view across the room.
        if (performance.now() < this.lockGraceUntil) return;
        this.player.onMouseDelta(e.movementX, e.movementY);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (this.state !== "playing") return;
      // Keep game keys away from the browser (Ctrl+S dialog, space scroll…).
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      // OS key repeat fires keydown over and over while a key is held —
      // without this, every toggle (sneak, torch) strobes on/off. Movement
      // is held-key-set based, so repeats carry no information at all.
      if (e.repeat) return;
      // Old habit guard: Ctrl is NOT sneak. A held Ctrl makes W close the
      // tab (Ctrl+W is browser-reserved, unblockable outside fullscreen).
      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        if (!this.ctrlHintShown) {
          this.ctrlHintShown = true;
          this.toast("SNEAK IS ON [C] — DON'T HOLD CTRL, CTRL+W CLOSES THE TAB");
        }
        return;
      }
      this.player.keyDown(e.code);
      if (e.code === "KeyE") this.tryInteract();
      if (e.code === "KeyF") this.audio.click();
      this.handleCheatKeys(e);
    };
    const onCanvasClick = () => {
      // Safety net: relock if the browser dropped the lock without pausing us.
      if (this.state === "playing" && !this.touchPrimary &&
          document.pointerLockElement !== this.canvas) {
        this.lockPointer();
      }
    };
    const onBlur = () => {
      // Focus stolen (alt-tab, OS popup, click outside a windowed game) —
      // pause so keys don't stick and the run isn't lost blind.
      if (this.state === "playing" && !this.touchPrimary) this.pause();
    };
    const onKeyUp = (e: KeyboardEvent) => this.player.keyUp(e.code);
    const onLockChange = () => {
      if (document.pointerLockElement === this.canvas) {
        this.hasLockedOnce = true;
        this.lockGraceUntil = performance.now() + 200;
        // Lock (re)acquired — if we were waiting in the pause menu, resume.
        if (this.state === "paused") {
          void this.audio.resume();
          this.setState("playing");
        }
      } else {
        this.unlockAt = performance.now();
        if (this.state === "playing") {
          this.player.clearKeys();
          void this.audio.suspend();
          this.setState("paused");
        }
      }
    };
    const onResize = () => {
      const w = this.container.clientWidth;
      const h = this.container.clientHeight;
      this.player.camera.aspect = w / h;
      this.player.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h, false);
      this.fx.setSize(w, h, this.renderer.getPixelRatio());
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("pointerlockchange", onLockChange);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    this.canvas.addEventListener("click", onCanvasClick);

    this.detachInput = () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("pointerlockchange", onLockChange);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      this.canvas.removeEventListener("click", onCanvasClick);
    };
  }

  /* --------------------------- touch controls --------------------------- */
  // Driven by the React touch overlay (joystick / look pad / buttons).

  setTouchMove(x: number, z: number) {
    this.player.touchMove.x = x;
    this.player.touchMove.z = z;
  }

  touchLook(dx: number, dy: number) {
    if (this.state === "playing") this.player.onMouseDelta(dx, dy);
  }

  touchInteract() {
    if (this.state === "playing") this.tryInteract();
  }

  touchTorch() {
    if (this.state !== "playing") return;
    this.player.toggleFlashlight();
    this.audio.click();
  }

  setSneak(on: boolean) {
    this.player.sneaking = on;
  }

  /* ------------------------------ cheats ------------------------------ */

  /**
   * Developer cheats. Type "redrum" during a run to unlock, then:
   * G god · N noclip · B fullbright · X freeze entity · P all pages · T to exit
   */
  private handleCheatKeys(e: KeyboardEvent) {
    if (/^[a-z]$/i.test(e.key)) {
      this.cheatBuffer = (this.cheatBuffer + e.key.toLowerCase()).slice(-10);
      if (!this.cheats.unlocked && this.cheatBuffer.endsWith("redrum")) {
        this.cheats.unlocked = true;
        this.toast("CHEATS UNLOCKED — [G]OD [N]OCLIP [B]RIGHT [X]FREEZE [P]AGES [T]ELEPORT");
        return;
      }
    }
    if (!this.cheats.unlocked) return;

    switch (e.code) {
      case "KeyG":
        this.cheats.god = !this.cheats.god;
        this.toast(`GOD MODE ${this.cheats.god ? "ON" : "OFF"}`);
        break;
      case "KeyN":
        this.cheats.noclip = !this.cheats.noclip;
        this.player.noclip = this.cheats.noclip;
        this.toast(`NOCLIP ${this.cheats.noclip ? "ON — through the walls" : "OFF"}`);
        break;
      case "KeyB":
        this.cheats.fullbright = !this.cheats.fullbright;
        if (this.cheats.fullbright && !this.brightLight) {
          this.brightLight = new THREE.AmbientLight(0xfff4d8, 2.4);
          this.scene.add(this.brightLight);
        } else if (!this.cheats.fullbright && this.brightLight) {
          this.scene.remove(this.brightLight);
          this.brightLight = null;
        }
        this.toast(`FULLBRIGHT ${this.cheats.fullbright ? "ON" : "OFF"}`);
        break;
      case "KeyX":
        this.cheats.freeze = !this.cheats.freeze;
        this.toast(`ENTITY ${this.cheats.freeze ? "FROZEN" : "RELEASED"}`);
        break;
      case "KeyP": {
        let grabbed = 0;
        this.items.pages.forEach((p, i) => {
          if (!p.collected) {
            this.items.collectPage(i);
            grabbed++;
          }
        });
        if (grabbed > 0 && this.entity.state === "dormant") this.entity.activate();
        this.toast(`PAGES GRANTED (+${grabbed}) — find the door`);
        this.pushHud(true);
        break;
      }
      case "KeyT": {
        const exit = this.level.exit;
        this.player.pos.set(
          exit.doorPos.x + exit.facing.x * 1.6,
          0,
          exit.doorPos.z + exit.facing.z * 1.6,
        );
        this.player.vel.set(0, 0, 0);
        this.player.yaw = Math.atan2(-exit.facing.x, -exit.facing.z) + Math.PI;
        this.toast("TELEPORTED TO THE EXIT DOOR");
        break;
      }
    }
  }

  private toast(msg: string) {
    this.callbacks.onToast(msg);
  }

  /* ----------------------------- gameplay ----------------------------- */

  private tryInteract() {
    const camDir = this.player.camera.getWorldDirection(this.vCamDir);
    const hit = this.items.findInteractable(this.player.camera.position, camDir);
    if (!hit) return;

    if (hit.type === "page") {
      const lines = this.items.collectPage(hit.index);
      this.audio.pageStinger();
      this.callbacks.onPageText(lines);
      this.fearSpike = Math.min(1, this.fearSpike + 0.22);
      if (this.items.collected === 1) this.entity.activate();
      this.pushHud(true);
    } else if (hit.type === "water") {
      this.items.drinkWater(hit.index);
      this.player.restoreStamina();
      // the lore is true: it calms you down
      this.fearSpike = Math.max(0, this.fearSpike - 0.5);
      this.fear = Math.max(0, this.fear - 0.3);
      this.audio.drink();
      this.toast("STAMINA RESTORED — YOUR HEART SLOWS");
      this.pushHud(true);
    } else if (hit.type === "door" && this.items.allCollected && !this.items.exitOpen) {
      this.items.openExit();
      this.audio.zap();
      this.fearSpike = Math.min(1, this.fearSpike + 0.15);
      this.pushHud(true);
    }
  }

  private onScreech() {
    this.audio.screech();
    this.fearSpike = 1;
    this.glitch = Math.min(1, this.glitch + 0.8);
    this.player.shake = 1;
  }

  private onEntityStep() {
    const toEntity = this.vA.subVectors(this.entity.pos, this.player.pos);
    const dist = toEntity.length();
    toEntity.normalize();
    const camDir = this.player.camera.getWorldDirection(this.vCamDir);
    const right = this.vB.crossVectors(camDir, UP).normalize();
    this.audio.entityStep(dist, toEntity.dot(right));
  }

  private beginDeath() {
    if (this.state !== "playing") return;
    if (this.cheats.god) return; // it reaches for you and passes through
    this.setState("dying");
    this.deathT = 0;
    this.audio.death();
    this.glitch = 1;
    this.player.clearKeys();
  }

  /* ------------------------------- loop ------------------------------- */

  private loop = () => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.loop);

    const dt = Math.min(0.05, this.clock.getDelta());
    this.elapsed += dt;
    const t = this.elapsed;

    if (this.state === "playing") {
      // Watchdog: the pointer lock died without an event (browser quirk) —
      // the cursor would drift free over the close button while the game
      // runs. Pause within half a second so it's obvious and recoverable.
      if (!this.touchPrimary && this.hasLockedOnce &&
          document.pointerLockElement !== this.canvas) {
        this.lockLossT += dt;
        if (this.lockLossT > 0.5) {
          this.lockLossT = 0;
          this.pause();
        }
      } else {
        this.lockLossT = 0;
      }

      this.player.update(dt, t);

      // Auto-wake the entity even if the player stalls.
      if (this.entity.state === "dormant" && t - this.startedAt > 45) {
        this.entity.activate();
      }

      const camDir = this.player.camera.getWorldDirection(this.vCamDir);
      if (!this.cheats.freeze) {
        this.entity.update(dt, {
          playerPos: this.player.pos,
          playerHead: this.player.camera.position,
          camDir,
          playerSpeed: this.player.speed,
          playerSprinting: this.player.sprinting,
          playerSneaking: this.player.sneaking,
          flashlightOn: this.player.flashlightOn,
          time: t,
        });
      }

      this.items.update(dt, t);
      this.updateInteractionPrompt(camDir);

      // Walking into the light beyond the open door = escape.
      const doorDx = this.player.pos.x - this.level.exit.doorPos.x;
      const doorDz = this.player.pos.z - this.level.exit.doorPos.z;
      if (this.items.exitOpen && Math.hypot(doorDx, doorDz) < 1.05) {
        this.setState("won");
        this.audio.win();
        this.callbacks.onStats({
          pages: this.items.collected,
          seconds: Math.floor(t - this.startedAt),
        });
        document.exitPointerLock();
      }
    } else if (this.state === "dying") {
      this.updateDeath(dt);
    }

    this.updateFixtures(t, dt);
    this.updateFearAndAudio(dt);

    this.fx.update(t, this.fear, this.glitch, this.beat, this.deathT);
    this.fx.render();

    this.hudTimer -= dt;
    if (this.hudTimer <= 0 && (this.state === "playing" || this.state === "dying")) {
      this.hudTimer = 0.12;
      this.pushHud();
    }
  };

  private updateDeath(dt: number) {
    this.deathT = Math.min(1, this.deathT + dt * 0.55);
    // Camera wrenched around to face it.
    const head = this.entity.headWorldPos;
    const cam = this.player.camera;
    const target = this.vA.subVectors(head, cam.position);
    const yaw = Math.atan2(-target.x, -target.z);
    const pitch = Math.atan2(target.y, Math.hypot(target.x, target.z));
    const k = Math.min(1, dt * 7);
    cam.rotation.y += (yaw - cam.rotation.y) * k;
    cam.rotation.x += (pitch - cam.rotation.x) * k;
    cam.position.y += (1.1 - cam.position.y) * dt * 0.7; // dragged down
    this.player.shake = 0.7;

    if (this.deathT >= 1) {
      this.setState("dead");
      this.callbacks.onStats({
        pages: this.items.collected,
        seconds: Math.floor(this.elapsed - this.startedAt),
      });
      document.exitPointerLock();
    }
  }

  private updateInteractionPrompt(camDir: THREE.Vector3) {
    const hit = this.items.findInteractable(this.player.camera.position, camDir);
    const prompt = hit
      ? hit.type !== "door" || this.items.allCollected
        ? `[E] ${hit.label}`
        : hit.label
      : null;
    if (prompt !== this.lastPrompt) {
      this.lastPrompt = prompt;
      this.pushHud(true);
    }
  }

  /* --------------------------- light orchestra --------------------------- */

  private updateFixtures(t: number, dt: number) {
    const fixtures = this.level.fixtures;
    const playerPos = this.player.pos;
    const entityActive = this.entity.state !== "dormant";

    // Random ambient events. Two flavors:
    //  - choke: a nearby light strangles for a few seconds (scare)
    //  - flare: a DEAD light down some corridor sputters alive, then dies
    //    again (lure — something to walk toward)
    this.nextAmbientEvent -= dt;
    if (this.nextAmbientEvent <= 0 && this.state === "playing") {
      this.nextAmbientEvent = randRange(Math.random, 16, 38);
      if (this.entity.state !== "chase") {
        const wantFlare = Math.random() < 0.45;
        const dead = wantFlare
          ? fixtures.filter((f) => {
              if (f.state !== "off") return false;
              const d = f.pos.distanceToSquared(playerPos);
              return d > 100 && d < 484; // 10-22m: visible, not adjacent
            })
          : [];
        if (dead.length > 0) {
          const f = dead[Math.floor(Math.random() * dead.length)];
          this.fixtureFlare.set(f.index, 4.5 + Math.random() * 3);
          this.audio.buzz();
        } else {
          const near = fixtures.filter(
            (f) => f.state === "on" && f.pos.distanceToSquared(playerPos) < 169,
          );
          if (near.length > 0) {
            const f = near[Math.floor(Math.random() * near.length)];
            this.fixtureBurst.set(f.index, 2.5 + Math.random() * 2);
            this.audio.zap();
            this.fearSpike = Math.min(1, this.fearSpike + 0.12);
          }
        }
      }
    }

    const candidates: { f: (typeof fixtures)[number]; d: number; mult: number }[] = [];
    this.nearestLitSq = Infinity;

    for (const f of fixtures) {
      const dSq = f.pos.distanceToSquared(playerPos);
      if (f.state !== "off" && dSq < this.nearestLitSq) this.nearestLitSq = dSq;
      if (dSq > 676) continue; // beyond fog (26m) — irrelevant this frame

      let mult: number;
      switch (f.state) {
        case "off":
          mult = 0.006;
          break;
        case "flicker": {
          const n = Math.sin(t * 13 + f.phase * 7) + Math.sin(t * 31 + f.phase);
          mult = n > 0.4 ? 1 : n > -0.6 ? 0.45 : 0.05;
          break;
        }
        default:
          mult = 0.97 + Math.sin(t * 40 + f.phase) * 0.03;
      }

      // Flare events: a dead panel arcs back to life, stuttering.
      const flare = this.fixtureFlare.get(f.index);
      if (flare !== undefined) {
        if (flare <= 0) this.fixtureFlare.delete(f.index);
        else {
          this.fixtureFlare.set(f.index, flare - dt);
          // bangs on like a real tube, stutters, then sputters out
          const n = Math.sin(t * 19 + f.phase) + Math.sin(t * 47 + f.phase * 3);
          const dieOff = Math.min(1, flare * 1.2);
          mult = Math.max(mult, (n > -0.3 ? 0.9 : 0.12) * dieOff);
        }
      }

      // Burst events override.
      const burst = this.fixtureBurst.get(f.index);
      if (burst !== undefined) {
        if (burst <= 0) this.fixtureBurst.delete(f.index);
        else {
          this.fixtureBurst.set(f.index, burst - dt);
          mult *= Math.random() < 0.45 ? 0.08 : 0.7;
        }
      }

      // The entity smothers light around it.
      if (entityActive) {
        const dEntSq = f.pos.distanceToSquared(this.entity.pos);
        if (dEntSq < 64) {
          const aura = 1 - Math.sqrt(dEntSq) / 8;
          f.aura += (aura - f.aura) * Math.min(1, dt * 6);
        } else {
          f.aura += (0 - f.aura) * Math.min(1, dt * 3);
        }
        if (f.aura > 0.01) {
          const strangle = Math.random() < f.aura * 0.7 ? 0.06 : 1 - f.aura * 0.75;
          mult *= strangle;
        }
      }

      // Update instanced panel color only when it changed noticeably.
      if (Math.abs(mult - this.fixtureMult[f.index]) > 0.025) {
        this.fixtureMult[f.index] = mult;
        this.level.setFixtureColor(
          f.index,
          f.base[0] * mult,
          f.base[1] * mult,
          f.base[2] * mult,
        );
      }

      if (mult > 0.04 && (f.state !== "off" || this.fixtureFlare.has(f.index)))
        candidates.push({ f, d: dSq, mult });
    }

    // Assign the real point lights to the nearest glowing fixtures.
    candidates.sort((a, b) => a.d - b.d);
    for (let i = 0; i < POOL_SIZE; i++) {
      const light = this.lightPool[i];
      const c = candidates[i];
      if (c) {
        light.position.set(c.f.pos.x, c.f.pos.y - 0.18, c.f.pos.z);
        light.intensity = 10.5 * c.mult;
        // light color tracks the panel so anomaly zones wash the room
        light.color.setRGB(c.f.base[0] * 0.53, c.f.base[1] * 0.53, c.f.base[2] * 0.54);
      } else {
        light.intensity = 0;
      }
    }

    // Entity interference with the flashlight.
    if (entityActive) {
      const d = this.entity.pos.distanceTo(playerPos);
      this.player.flashlightInterference = d < 9 ? (1 - d / 9) * 0.85 : 0;
    }
  }

  /* ----------------------------- fear/audio ----------------------------- */

  private get beat(): number {
    return Math.pow(Math.max(0, Math.sin(this.beatPhase)), 6);
  }

  private updateFearAndAudio(dt: number) {
    const playerPos = this.player.pos;

    // Darkness factor — nearest live light, computed in the fixture pass.
    const nearestLit = Math.sqrt(this.nearestLitSq);
    let dark = Math.min(1, Math.max(0, (nearestLit - 5) / 13));
    if (this.player.flashlightOn) dark = Math.min(dark, 0.55);

    // Entity factor.
    const eDist = this.entity.state === "dormant"
      ? Infinity
      : this.entity.pos.distanceTo(playerPos);
    let entityFear = 0;
    switch (this.entity.state) {
      case "roam": entityFear = Math.max(0, 1 - eDist / 40) * 0.3; break;
      case "stalk": entityFear = 0.4 + Math.max(0, 1 - eDist / 30) * 0.3; break;
      case "search": entityFear = 0.45; break;
      case "chase": entityFear = 0.95; break;
    }
    if (eDist < 8) entityFear = Math.max(entityFear, 0.8);

    this.fearSpike = Math.max(0, this.fearSpike - dt * 0.25);
    const target = Math.min(1, dark * 0.35 + entityFear + this.fearSpike * 0.5);
    const rate = target > this.fear ? 1.6 : 0.13;
    this.fear += (target - this.fear) * Math.min(1, dt * rate);

    this.glitch = Math.max(0, this.glitch - dt * 2.2);
    if (eDist < 10) this.glitch = Math.max(this.glitch, (1 - eDist / 10) * 0.25);

    this.beatPhase += dt * Math.PI * 2 * (0.95 + this.fear * 1.25);

    if (this.audio.ready) {
      const camDir = this.player.camera.getWorldDirection(this.vCamDir);
      const toEntity = this.vA.subVectors(this.entity.pos, playerPos).normalize();
      const right = this.vB.crossVectors(camDir, UP).normalize();
      this.audio.setParams({
        fear: this.fear,
        humProximity: Math.max(0, 1 - nearestLit / 11),
        entityDist: eDist,
        entityPan: isFinite(eDist) ? toEntity.dot(right) : 0,
        chasing: this.entity.state === "chase",
      });
      this.audio.update(dt);
    }
  }

  /* ------------------------------- HUD ------------------------------- */

  private pushHud(force = false) {
    void force;
    const active: string[] = [];
    if (this.cheats.god) active.push("GOD");
    if (this.cheats.noclip) active.push("NOCLIP");
    if (this.cheats.fullbright) active.push("BRIGHT");
    if (this.cheats.freeze) active.push("FROZEN");
    this.callbacks.onHud({
      pages: this.items.collected,
      totalPages: TOTAL_PAGES,
      stamina: this.player.stamina,
      prompt: this.lastPrompt,
      objective: !this.items.allCollected
        ? `COLLECT THE PAGES — ${this.items.collected}/${TOTAL_PAGES}`
        : this.items.exitOpen
          ? "GET OUT"
          : "FIND THE EXIT DOOR",
      flashlight: this.player.flashlightOn,
      sneaking: this.player.sneaking,
      cheats: active.length > 0 ? active.join(" · ") : null,
    });
  }

  /* ----------------------------- teardown ----------------------------- */

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.pendingLock !== null) clearTimeout(this.pendingLock);
    this.detachInput?.();
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
    this.audio.dispose();
    this.fx.dispose();
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.geometry?.dispose();
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of mats) {
          for (const key of Object.keys(m)) {
            const v = (m as unknown as Record<string, unknown>)[key];
            if (v instanceof THREE.Texture) v.dispose();
          }
          m.dispose();
        }
      }
    });
    this.renderer.dispose();
  }
}
