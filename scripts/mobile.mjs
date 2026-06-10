/** Emulated phone test: rotate prompt, touch controls, joystick walk. */
import puppeteer from "puppeteer-core";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--mute-audio", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (err) => errors.push(`[pageerror] ${err.message}`));
page.on("console", (m) => {
  if (m.type() === "error") errors.push(`[console] ${m.text()}`);
});

// --- portrait phone first: expect the rotate overlay
await page.emulate({
  viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
});
await page.goto("http://localhost:3000", { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));
const rotateShown = await page.evaluate(() =>
  document.body.innerText.includes("ROTATE YOUR DEVICE"),
);
console.log("PORTRAIT ROTATE PROMPT:", rotateShown ? "OK" : "FAILED");
await page.screenshot({ path: "scripts/shots/m1-portrait.png" });

// --- landscape: menu + start + touch HUD
await page.setViewport({
  width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
});
await new Promise((r) => setTimeout(r, 400));
const rotateGone = await page.evaluate(
  () => !document.body.innerText.includes("ROTATE YOUR DEVICE"),
);
console.log("LANDSCAPE PROMPT GONE:", rotateGone ? "OK" : "FAILED");

await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent.includes("ENTER"));
  return b && !b.disabled;
}, { timeout: 30000 });

// --- menu taller than a short landscape screen: it must scroll so the
// ENTER button is actually reachable (used to be clipped with no scroll)
const menuScroll = await page.evaluate(() => {
  const scroller = [...document.querySelectorAll("div")].find(
    (d) => getComputedStyle(d).overflowY === "auto" && d.scrollHeight > d.clientHeight + 4,
  );
  const btn = [...document.querySelectorAll("button")].find((x) =>
    x.textContent.includes("ENTER"),
  );
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
  const r = btn.getBoundingClientRect();
  return {
    scrollable: !!scroller,
    btnReachable: r.top >= 0 && r.bottom <= window.innerHeight,
  };
});
console.log("MENU SCROLL:", JSON.stringify(menuScroll),
  menuScroll.btnReachable ? "OK" : "FAILED");
await page.screenshot({ path: "scripts/shots/m1b-menu-scrolled.png" });

await page.tap("button");
await new Promise((r) => setTimeout(r, 1200));

// fullscreen is requested on the start tap (headless may deny — informational)
const fs = await page.evaluate(() => !!document.fullscreenElement);
console.log("FULLSCREEN ON START TAP:", fs ? "granted" : "denied by environment (ok in headless)");

const hudInfo = await page.evaluate(() => ({
  torchBtn: document.body.innerText.includes("TORCH"),
  sneakBtn: document.body.innerText.includes("SNEAK"),
  state: window.__backrooms.state,
  touchPrimary: window.__backrooms.touchPrimary,
}));
console.log("TOUCH HUD:", JSON.stringify(hudInfo),
  hudInfo.torchBtn && hudInfo.sneakBtn && hudInfo.state === "playing" ? "OK" : "FAILED");

// --- drag the joystick forward for a second; player should move
const before = await page.evaluate(() => {
  const p = window.__backrooms.player.pos;
  return { x: p.x, z: p.z };
});
// joystick base center: left-8 (32px) + 72px = 104, bottom-8: 390-32-72 = 286
await page.touchscreen.touchStart(104, 286);
await page.touchscreen.touchMove(104, 236);
await new Promise((r) => setTimeout(r, 1000));
await page.touchscreen.touchEnd();
const after = await page.evaluate(() => {
  const p = window.__backrooms.player.pos;
  return { x: p.x, z: p.z };
});
const moved = Math.hypot(after.x - before.x, after.z - before.z);
console.log("JOYSTICK WALK:", moved > 0.5 ? `OK (${moved.toFixed(2)}m)` : `FAILED (${moved.toFixed(2)}m)`);
await page.screenshot({ path: "scripts/shots/m2-touch-hud.png" });

console.log("=== ISSUES (" + errors.length + ") ===");
for (const e of errors.slice(0, 10)) console.log(e);
await browser.close();
