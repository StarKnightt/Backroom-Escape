/**
 * OG image generator — poses a real in-game shot (long corridor, torch on,
 * the entity frozen mid-hall), captures the canvas at 1200x630, then
 * composites the title/tagline in-page using the loaded typewriter font.
 * Output: app/opengraph-image.png (+ preview copy in scripts/shots/).
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const W = 1200, H = 630;
mkdirSync("scripts/shots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--mute-audio", "--enable-unsafe-swiftshader", `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
});
await page.click("button");
await new Promise((r) => setTimeout(r, 1200));

// Pose: find the longest straight unblocked corridor run, stand at one end,
// park the frozen entity ~2/3 down it staring back.
await page.evaluate(() => {
  const e = window.__backrooms;
  const lvl = e.level;
  let best = null;
  for (let z = 1; z < lvl.size - 1; z++) {
    let run = 0;
    for (let x = 1; x < lvl.size; x++) {
      if (!lvl.isBlocked(x, z)) {
        run++;
        if (!best || run > best.len) best = { len: run, xEnd: x, z };
      } else run = 0;
    }
  }
  const x0 = best.xEnd - best.len + 1;
  e.player.pos.set(lvl.worldX(x0), 0, lvl.worldZ(best.z));
  e.player.yaw = -Math.PI / 2; // face +x down the run
  e.player.pitch = 0;
  e.player.vel.set(0, 0, 0);

  e.entity.activate();
  // ~4 cells out: deep enough to loom, close enough for the torch to catch it
  const ex = x0 + Math.min(best.len - 2, 4);
  e.entity.pos.set(lvl.worldX(ex), 0, lvl.worldZ(best.z));
});
// A few unfrozen frames so the entity's mesh syncs to the posed position,
// then freeze it mid-stride and aim its body+head straight at the camera.
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => {
  const e = window.__backrooms;
  e.cheats.freeze = true;
  const dx = e.player.pos.x - e.entity.pos.x;
  const dz = e.player.pos.z - e.entity.pos.z;
  const heading = Math.atan2(dx, dz);
  e.entity.heading = heading;
  e.entity.root.rotation.y = heading;
  e.entity.headGroup.rotation.y = 0; // stare dead ahead
});
// Hide every DOM overlay (HUD, banner, toast) — pure render only.
await page.addStyleTag({
  content: `[class*="pointer-events-none"] { display: none !important; }`,
});
await new Promise((r) => setTimeout(r, 900));

// Raw render of the canvas only (no DOM HUD).
const canvasBox = await page.evaluate(() => {
  const r = document.querySelector("canvas").getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
});
const shot = await page.screenshot({ clip: canvasBox, encoding: "base64" });

// Composite text in-page — the Special Elite webfont lives there.
const finalB64 = await page.evaluate(async (b64, W, H) => {
  const img = new Image();
  await new Promise((res) => { img.onload = res; img.src = `data:image/png;base64,${b64}`; });
  const fam = getComputedStyle(document.querySelector(".font-elite")).fontFamily;
  await document.fonts.load(`90px ${fam.split(",")[0]}`);

  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  x.drawImage(img, 0, 0, W, H);

  // bottom + top gradients so the type reads on any frame
  let g = x.createLinearGradient(0, H * 0.42, 0, H);
  g.addColorStop(0, "rgba(5,4,2,0)");
  g.addColorStop(1, "rgba(5,4,2,0.88)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  g = x.createLinearGradient(0, 0, 0, H * 0.2);
  g.addColorStop(0, "rgba(5,4,2,0.55)");
  g.addColorStop(1, "rgba(5,4,2,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H * 0.2);

  // scanlines + grain, matching the menu vibe
  x.fillStyle = "rgba(0,0,0,0.10)";
  for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
  for (let i = 0; i < 9000; i++) {
    x.fillStyle = Math.random() < 0.5
      ? `rgba(0,0,0,${0.04 + Math.random() * 0.05})`
      : `rgba(255,240,190,${0.015 + Math.random() * 0.03})`;
    x.fillRect(Math.random() * W, Math.random() * H, 1, 1);
  }

  x.textAlign = "center";
  x.letterSpacing = "10px";
  x.fillStyle = "rgba(255,228,160,0.55)";
  x.font = `20px ${fam}`;
  x.fillText("L E V E L  0", W / 2, H - 178);

  x.letterSpacing = "18px";
  x.fillStyle = "#f7ecca";
  x.shadowColor = "rgba(255,220,140,0.55)";
  x.shadowBlur = 38;
  x.font = `92px ${fam}`;
  x.fillText("BACKROOMS", W / 2, H - 92);
  x.shadowBlur = 0;

  x.letterSpacing = "5px";
  x.fillStyle = "rgba(255,235,180,0.72)";
  x.font = `22px ${fam}`;
  x.fillText("find the pages. find the door. don't let it find you.", W / 2, H - 42);

  x.letterSpacing = "3px";
  x.fillStyle = "rgba(255,235,180,0.4)";
  x.font = `16px ${fam}`;
  x.fillText("PLAY FREE IN YOUR BROWSER", W / 2, H - 14);

  // vignette
  const vig = x.createRadialGradient(W / 2, H / 2, H * 0.36, W / 2, H / 2, H * 0.95);
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.42)");
  x.fillStyle = vig;
  x.fillRect(0, 0, W, H);

  return c.toDataURL("image/png").split(",")[1];
}, shot, W, H);

await browser.close();
const buf = Buffer.from(finalB64, "base64");
writeFileSync("app/opengraph-image.png", buf);
writeFileSync("scripts/shots/og-preview.png", buf);
console.log(`OG IMAGE WRITTEN: app/opengraph-image.png (${(buf.length / 1024).toFixed(0)} KB)`);
