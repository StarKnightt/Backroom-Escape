/**
 * CrazyGames cover generator — stages the same corridor + frozen-entity shot
 * as the OG image, then captures and composites it at the three required
 * cover sizes (landscape 1920x1080, portrait 800x1200, square 800x800).
 * Output: scripts/shots/cover-*.png
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync("scripts/shots", { recursive: true });

// Per-format text layout: font sizes and bottom-anchored offsets.
const SIZES = [
  { name: "cover-1920x1080", w: 1920, h: 1080, level: 30, title: 148, tag: 32, padTitle: 150, padTag: 74, padLevel: 286 },
  { name: "cover-800x1200", w: 800, h: 1200, level: 22, title: 84, tag: 20, padTitle: 130, padTag: 70, padLevel: 210 },
  { name: "cover-800x800", w: 800, h: 800, level: 20, title: 76, tag: 18, padTitle: 110, padTag: 56, padLevel: 182 },
];

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--mute-audio", "--enable-unsafe-swiftshader", "--window-size=1920,1080"],
  defaultViewport: { width: 1920, height: 1080 },
});
const page = await browser.newPage();
page.on("error", (e) => console.log("[PAGE CRASHED]", e.message));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
const log = (m) => console.log(`[step] ${m}`);
await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 60000 });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 60000 });
await page.click("button");
await new Promise((r) => setTimeout(r, 1200));

// Pose: longest straight corridor, entity parked down it staring back.
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
  // Saved so each capture can re-pose — headless Chromium leaks phantom
  // mousemove deltas over time, which would slowly rotate the camera.
  window.__pose = { x: lvl.worldX(x0), z: lvl.worldZ(best.z) };
  e.player.pos.set(window.__pose.x, 0, window.__pose.z);
  e.player.yaw = -Math.PI / 2;
  e.player.pitch = 0;
  e.player.vel.set(0, 0, 0);

  e.entity.activate();
  const ex = x0 + Math.min(best.len - 2, 4);
  e.entity.pos.set(lvl.worldX(ex), 0, lvl.worldZ(best.z));
});
await new Promise((r) => setTimeout(r, 150));
await page.evaluate(() => {
  const e = window.__backrooms;
  e.cheats.freeze = true;
  const dx = e.player.pos.x - e.entity.pos.x;
  const dz = e.player.pos.z - e.entity.pos.z;
  const heading = Math.atan2(dx, dz);
  e.entity.heading = heading;
  e.entity.root.rotation.y = heading;
  e.entity.headGroup.rotation.y = 0;
});
await page.addStyleTag({
  content: `[class*="pointer-events-none"] { display: none !important; }`,
});

for (const s of SIZES) {
  log(`${s.name}: setViewport`);
  await page.setViewport({ width: s.w, height: s.h });
  await new Promise((r) => setTimeout(r, 800)); // settle resize
  // Re-pose at the last moment: phantom headless mousemoves drift the camera
  // during any wait, so leave only a couple frames between pose and shot.
  await page.evaluate(() => {
    const e = window.__backrooms;
    e.player.pos.set(window.__pose.x, 0, window.__pose.z);
    e.player.yaw = -Math.PI / 2;
    e.player.pitch = 0;
    e.player.vel.set(0, 0, 0);
  });
  await new Promise((r) => setTimeout(r, 150));

  log(`${s.name}: canvasBox`);
  const canvasBox = await page.evaluate(() => {
    const r = document.querySelector("canvas").getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  log(`${s.name}: screenshot ${JSON.stringify(canvasBox)}`);
  const shot = await page.screenshot({ clip: canvasBox, encoding: "base64" });

  // At 1920x1080 the base64 PNG is too large for a single CDP message —
  // stream it into the page (and back out) in chunks.
  const CHUNK = 800_000;
  log(`${s.name}: push shot (${(shot.length / 1e6).toFixed(1)} MB b64)`);
  await page.evaluate(() => { window.__shotB64 = ""; });
  for (let i = 0; i < shot.length; i += CHUNK) {
    await page.evaluate((p) => { window.__shotB64 += p; }, shot.slice(i, i + CHUNK));
  }
  log(`${s.name}: composite`);

  const outLen = await page.evaluate(async (s) => {
    const b64 = window.__shotB64;
    const { w: W, h: H } = s;
    const img = new Image();
    await new Promise((res) => { img.onload = res; img.src = `data:image/png;base64,${b64}`; });
    const fam = getComputedStyle(document.querySelector(".font-elite")).fontFamily;
    // The menu already rendered with this font, so it's loaded; fonts.load()
    // rejects with NetworkError on next/font/local family names — don't call it.
    try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]); } catch {}

    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.drawImage(img, 0, 0, W, H);

    let g = x.createLinearGradient(0, H * 0.45, 0, H);
    g.addColorStop(0, "rgba(5,4,2,0)");
    g.addColorStop(1, "rgba(5,4,2,0.9)");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H);
    g = x.createLinearGradient(0, 0, 0, H * 0.16);
    g.addColorStop(0, "rgba(5,4,2,0.5)");
    g.addColorStop(1, "rgba(5,4,2,0)");
    x.fillStyle = g;
    x.fillRect(0, 0, W, H * 0.16);

    x.fillStyle = "rgba(0,0,0,0.10)";
    for (let y = 0; y < H; y += 3) x.fillRect(0, y, W, 1);
    const grains = (W * H) / 80;
    for (let i = 0; i < grains; i++) {
      x.fillStyle = Math.random() < 0.5
        ? `rgba(0,0,0,${0.04 + Math.random() * 0.05})`
        : `rgba(255,240,190,${0.015 + Math.random() * 0.03})`;
      x.fillRect(Math.random() * W, Math.random() * H, 1, 1);
    }

    x.textAlign = "center";
    x.letterSpacing = `${Math.round(s.level / 2)}px`;
    x.fillStyle = "rgba(255,228,160,0.55)";
    x.font = `${s.level}px ${fam}`;
    x.fillText("L E V E L  0", W / 2, H - s.padLevel);

    x.letterSpacing = `${Math.round(s.title / 6)}px`;
    x.fillStyle = "#f7ecca";
    x.shadowColor = "rgba(255,220,140,0.55)";
    x.shadowBlur = Math.round(s.title / 2.5);
    x.font = `${s.title}px ${fam}`;
    x.fillText("BACKROOMS", W / 2, H - s.padTitle);
    x.shadowBlur = 0;

    x.letterSpacing = "4px";
    x.fillStyle = "rgba(255,235,180,0.72)";
    x.font = `${s.tag}px ${fam}`;
    x.fillText("don't let it find you", W / 2, H - s.padTag);

    const vig = x.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.36, W / 2, H / 2, Math.max(W, H) * 0.78);
    vig.addColorStop(0, "rgba(0,0,0,0)");
    vig.addColorStop(1, "rgba(0,0,0,0.45)");
    x.fillStyle = vig;
    x.fillRect(0, 0, W, H);

    window.__outB64 = c.toDataURL("image/png").split(",")[1];
    return window.__outB64.length;
  }, s);

  let finalB64 = "";
  for (let i = 0; i < outLen; i += CHUNK) {
    finalB64 += await page.evaluate(
      (o, n) => window.__outB64.slice(o, o + n),
      i, CHUNK,
    );
  }
  await page.evaluate(() => { delete window.__shotB64; delete window.__outB64; });

  const buf = Buffer.from(finalB64, "base64");
  writeFileSync(`scripts/shots/${s.name}.png`, buf);
  console.log(`WROTE scripts/shots/${s.name}.png (${(buf.length / 1024).toFixed(0)} KB)`);
}

await browser.close();
