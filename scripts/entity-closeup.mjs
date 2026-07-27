/**
 * Design-review smoke test: freezes the entity dead ahead of a stationary
 * player (no walk cycle, no AI, no idle sway — a clean static pose), then
 * orbits the camera around it for a full turntable + a face close-up.
 * Not a pass/fail check — this is for eyeballing the model to make it scarier.
 */
import puppeteer from "puppeteer-core";
import { mkdirSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync("scripts/shots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--mute-audio", "--enable-unsafe-swiftshader", "--window-size=1280,720"],
  defaultViewport: { width: 1280, height: 720 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});

await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 30000 });
await page.click("button");
await new Promise((r) => setTimeout(r, 900));

// fullbright so the model reads clearly — not just whatever the flashlight hits
await page.keyboard.type("redrum", { delay: 60 });
await new Promise((r) => setTimeout(r, 200));
await page.keyboard.down("KeyB");
await new Promise((r) => setTimeout(r, 60));
await page.keyboard.up("KeyB");
// let the "FULLBRIGHT ON" toast clear (3.2s auto-fade) so it's not sitting
// over the model in every shot
await new Promise((r) => setTimeout(r, 3400));

// place the entity ~2.2m dead ahead of the player, facing us
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const ent = e.entity;
  p.pitch = 0;
  const f = p.forward;
  ent.activate();
  ent.pos.set(p.pos.x + f.x * 2.2, 0, p.pos.z + f.z * 2.2);
  ent.heading = Math.atan2(-f.x, -f.z); // faces back toward the player
  ent.root.visible = true;
  ent.setState("roam");
  p.clearKeys();
  p.vel.set(0, 0, 0);
  // the flashlight's hotspot blows out highlights at 1-2m — fullbright
  // ambient already lights the scene evenly, so kill it for clean shots
  if (p.flashlightOn) p.toggleFlashlight();
});
// let one real frame run so root.position/rotation sync to what we just set
await new Promise((r) => setTimeout(r, 80));
// *then* freeze — locks the pose exactly where it is, no further AI/animation
await page.evaluate(() => {
  window.__backrooms.cheats.freeze = true;
});
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({ path: "scripts/shots/e1-front.png" });
console.log("FRONT (both frozen): OK");

// turntable — same frozen pose, camera orbits around it
const orbit = [
  { name: "e2-left3q", deg: 45 },
  { name: "e3-leftside", deg: 90 },
  { name: "e4-back3q", deg: 135 },
  { name: "e5-behind", deg: 180 },
  { name: "e6-right3q", deg: -135 },
  { name: "e7-rightside", deg: -90 },
];
for (const { name, deg } of orbit) {
  await page.evaluate((degrees) => {
    const e = window.__backrooms;
    const ent = e.entity;
    const p = e.player;
    const rad = (degrees * Math.PI) / 180;
    const R = 2.4;
    const ex = ent.pos.x, ez = ent.pos.z;
    const ox = ex + Math.sin(rad) * R;
    const oz = ez + Math.cos(rad) * R;
    p.pos.set(ox, 0, oz);
    const dx = ex - ox, dz = ez - oz;
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = 0;
  }, deg);
  await new Promise((r) => setTimeout(r, 200));
  await page.screenshot({ path: `scripts/shots/${name}.png` });
  console.log(`${name}: OK`);
}

// close-up on the face/head — the part that has to actually read as scary.
// The entity is very tall (its head is up near the 3m ceiling), so this
// needs real pitch, not just a horizontal step-in.
await page.evaluate(() => {
  const e = window.__backrooms;
  const ent = e.entity;
  const p = e.player;
  const head = ent.headWorldPos;
  const dx = head.x - ent.pos.x, dz = head.z - ent.pos.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len, nz = dz / len;
  const DIST = 1.6; // back off enough that "up" isn't a near-vertical look
  p.pos.set(head.x + nx * DIST, 0, head.z + nz * DIST);
  const tdx = head.x - p.pos.x, tdz = head.z - p.pos.z;
  p.yaw = Math.atan2(-tdx, -tdz);
  const eyeY = 1.62; // Player.EYE_HEIGHT
  p.pitch = Math.atan2(head.y - eyeY, Math.hypot(tdx, tdz));
});
await new Promise((r) => setTimeout(r, 200));
await page.screenshot({ path: "scripts/shots/e8-face-closeup.png" });
console.log("FACE CLOSEUP: OK");

console.log("=== ISSUES (" + errors.length + ") ===");
for (const e of errors.slice(0, 20)) console.log(e);
await browser.close();
