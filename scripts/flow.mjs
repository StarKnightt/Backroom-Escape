/**
 * Functional flow test: page pickup -> HUD update -> death -> retry button.
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
await new Promise((r) => setTimeout(r, 1000));

// --- wall scrawls generated and placed
const art = await page.evaluate(() => window.__backrooms.level.artSpots.length);
console.log("WALL ART:", art >= 10 ? `OK (${art})` : `LOW (${art})`);

// --- exploration content generated
const extras = await page.evaluate(() => ({
  water: window.__backrooms.items.waters.length,
  signs: window.__backrooms.level.falseExits.length,
  beacons: window.__backrooms.level.fixtures.filter((f) => f.state === "flicker").length,
  hueAnomalies: window.__backrooms.level.fixtures.filter((f) => f.base[0] !== 1.9).length,
}));
const extrasOk =
  extras.water === 4 && extras.signs >= 4 && extras.beacons >= 8 && extras.hueAnomalies >= 2;
console.log("EXPLORATION:", extrasOk ? "OK" : "FAILED", JSON.stringify(extras));

// --- almond water drink restores stamina
await page.evaluate(() => {
  const e = window.__backrooms;
  const w = e.items.waters[0].group.position;
  e.player.pos.set(w.x + 1.1, 0, w.z);
  e.player.yaw = Math.atan2(1.1, 0); // forward = (-sin,-cos) → face -X
  e.player.pitch = -0.85;
  e.player.stamina = 0.15;
});
await new Promise((r) => setTimeout(r, 300));
await page.keyboard.down("KeyE");
await new Promise((r) => setTimeout(r, 80));
await page.keyboard.up("KeyE");
await new Promise((r) => setTimeout(r, 400));
const drank = await page.evaluate(() => ({
  taken: window.__backrooms.items.waters[0].taken,
  stamina: window.__backrooms.player.stamina,
}));
console.log(
  "ALMOND WATER:",
  drank.taken && drank.stamina > 0.95 ? "OK" : "FAILED",
  JSON.stringify(drank),
);

// --- starter page lands a short walk from spawn (findability)
const starterDist = await page.evaluate(() => {
  const e = window.__backrooms;
  const s = e.level.spawn;
  const p = e.level.pageSpots[0].pos;
  return Math.hypot(p.x - s.x, p.z - s.z);
});
const pageCount = await page.evaluate(() => window.__backrooms.level.pageSpots.length);
console.log(
  "STARTER PAGE:",
  starterDist < 30 && pageCount === 8
    ? `OK (${starterDist.toFixed(1)}m, ${pageCount} pages)`
    : `BAD (${starterDist.toFixed(1)}m, ${pageCount} pages)`,
);

// --- objective banner announces the goal at run start
const bannerUp = await page.evaluate(() => {
  const t = document.body.innerText;
  return t.includes("OBJECTIVE") && t.includes("PINNED TO THE WALLS");
});
console.log("OBJECTIVE BANNER:", bannerUp ? "OK" : "FAILED");
await page.screenshot({ path: "scripts/shots/f0-objective.png" });

// --- collect a page
await page.evaluate(() => {
  const e = window.__backrooms;
  const p = e.player;
  const spot = e.level.pageSpots[0];
  p.pos.set(spot.pos.x + spot.normal.x * 1.4, 0, spot.pos.z + spot.normal.z * 1.4);
  p.yaw = Math.atan2(spot.normal.x, spot.normal.z);
  p.pitch = 0;
});
await new Promise((r) => setTimeout(r, 400));
await page.keyboard.down("KeyE");
await new Promise((r) => setTimeout(r, 80));
await page.keyboard.up("KeyE");
await new Promise((r) => setTimeout(r, 800));
const hudAfterPage = await page.evaluate(() => document.body.innerText);
const pageOk = hudAfterPage.includes("PAGES 1/8") || hudAfterPage.includes("1/8");
await page.screenshot({ path: "scripts/shots/f1-page-collected.png" });
console.log("PAGE PICKUP:", pageOk ? "OK" : "FAILED", "| overlay visible:", hudAfterPage.includes("noclipped") || hudAfterPage.includes("DAY 1"));

// --- let it take us
await page.evaluate(() => {
  const e = window.__backrooms;
  const ent = e.entity;
  ent.activate();
  ent.pos.set(e.player.pos.x + 0.9, 0, e.player.pos.z);
});
await page.waitForFunction(
  () => document.body.innerText.includes("YOU WERE TAKEN"),
  { timeout: 15000 },
);
await page.screenshot({ path: "scripts/shots/f2-death.png" });
console.log("DEATH SCREEN: OK");

// --- retry restarts a fresh run (button arms itself after ~450ms —
// double-click protection — so wait until it's clickable)
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    x.textContent.includes("WAKE UP AGAIN"),
  );
  return b && !b.disabled;
}, { timeout: 5000 });
await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    x.textContent.includes("WAKE UP AGAIN"),
  );
  b.click();
});
await page.waitForFunction(
  () => {
    const t = document.body.innerText;
    return t.includes("PAGES 0/8") || t.includes("COLLECT THE PAGES — 0/8");
  },
  { timeout: 30000 },
);
console.log("RETRY: OK");
await page.screenshot({ path: "scripts/shots/f3-retry.png" });

// --- pause -> exit to menu -> fresh ENTER available
await page.evaluate(() => window.__backrooms.pause());
await page.waitForFunction(() => document.body.innerText.includes("PAUSED"), { timeout: 5000 });
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    x.textContent.includes("EXIT TO MENU"),
  );
  return b && !b.disabled;
}, { timeout: 5000 });
await page.screenshot({ path: "scripts/shots/f4-pause-exit.png" });
await page.evaluate(() => {
  [...document.querySelectorAll("button")]
    .find((x) => x.textContent.includes("EXIT TO MENU"))
    .click();
});
await page.waitForFunction(() => {
  const t = document.body.innerText;
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return t.includes("BACKROOMS") && b && !b.disabled;
}, { timeout: 30000 });
const menuState = await page.evaluate(() => window.__backrooms.state);
console.log("EXIT TO MENU:", menuState === "idle" ? "OK" : `FAILED (state=${menuState})`);

console.log("=== ISSUES (" + errors.length + ") ===");
for (const e of errors.slice(0, 20)) console.log(e);
await browser.close();
