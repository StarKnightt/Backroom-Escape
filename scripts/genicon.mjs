/**
 * Procedural favicon/app-icon generator — backrooms wall, fluorescent bar,
 * black doorway (with something faint standing in it at large sizes).
 * Outputs:
 *   app/favicon.ico            16+32+48 (PNG-in-ICO)
 *   app/icon.png               192
 *   app/apple-icon.png         180
 *   public/icon-192.png        manifest
 *   public/icon-512.png        manifest
 *   scripts/shots/icon-preview.png  review grid
 */
import puppeteer from "puppeteer-core";
import { writeFileSync, mkdirSync } from "node:fs";

const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
mkdirSync("scripts/shots", { recursive: true });

const browser = await puppeteer.launch({
  executablePath: EDGE,
  headless: true,
  args: ["--enable-unsafe-swiftshader"],
});
const page = await browser.newPage();

const pngs = await page.evaluate(() => {
  function draw(S) {
    const c = document.createElement("canvas");
    c.width = c.height = S;
    const x = c.getContext("2d");
    const px = (v) => Math.max(1, Math.round(v * S));

    // --- mono-yellow wall
    const wall = x.createLinearGradient(0, 0, 0, S);
    wall.addColorStop(0, "#d8c476");
    wall.addColorStop(0.7, "#b8a256");
    wall.addColorStop(1, "#9f8a45");
    x.fillStyle = wall;
    x.fillRect(0, 0, S, S);

    // --- damp carpet floor
    const floorY = S >= 48 ? px(0.82) : px(0.88);
    x.fillStyle = "#857237";
    x.fillRect(0, floorY, S, S - floorY);
    x.fillStyle = "rgba(0,0,0,0.3)";
    x.fillRect(0, floorY, S, Math.max(1, Math.round(S * 0.01)));

    // --- fluorescent bar + glow (too small to read below 96)
    if (S >= 96) {
      const lw = px(0.36), lh = Math.max(2, px(0.04));
      const lx = (S - lw) / 2, ly = px(0.07);
      const glow = x.createRadialGradient(S / 2, ly, 1, S / 2, ly, px(0.34));
      glow.addColorStop(0, "rgba(255,247,205,0.6)");
      glow.addColorStop(1, "rgba(255,247,205,0)");
      x.fillStyle = glow;
      x.fillRect(0, 0, S, px(0.45));
      x.fillStyle = "#fff7d2";
      x.fillRect(lx, ly, lw, lh);
      x.fillStyle = "rgba(255,247,205,0.5)";
      x.fillRect(lx - px(0.012), ly + lh, lw + px(0.024), Math.max(1, Math.round(lh * 0.5)));
    }

    // --- grain on the wall (before the doorway so the void stays clean black)
    if (S >= 96) {
      for (let i = 0; i < S * S * 0.045; i++) {
        const gx = Math.random() * S, gy = Math.random() * S;
        x.fillStyle = Math.random() < 0.5
          ? `rgba(0,0,0,${0.03 + Math.random() * 0.05})`
          : `rgba(255,244,200,${0.02 + Math.random() * 0.03})`;
        x.fillRect(gx, gy, 1, 1);
      }
    }

    // --- doorway: black, sitting on the floor line
    const dw = S >= 48 ? px(0.38) : Math.round(S * 0.4);
    const dh = S >= 48 ? px(0.56) : Math.round(S * 0.62);
    const dx = Math.round((S - dw) / 2);
    const dy = floorY - dh;
    if (S >= 32) {
      const f = Math.max(1, px(0.02));
      x.fillStyle = "#6e5d2c";
      x.fillRect(dx - f, dy - f, dw + f * 2, dh + f);
    }
    x.fillStyle = "#070604";
    x.fillRect(dx, dy, dw, dh);

    // --- it, barely (large sizes only)
    if (S >= 160) {
      x.fillStyle = "#191813";
      const cx = dx + dw * 0.56;
      const headR = dw * 0.085;
      const headY = dy + dh * 0.34;
      x.beginPath();
      x.arc(cx, headY, headR, 0, Math.PI * 2);
      x.fill();
      // gaunt neck + sloped shoulders + long torso, tapering
      x.beginPath();
      x.moveTo(cx - headR * 0.45, headY + headR * 0.8);
      x.lineTo(cx - headR * 1.7, headY + headR * 3.2);
      x.lineTo(cx - headR * 1.1, dy + dh);
      x.lineTo(cx + headR * 1.1, dy + dh);
      x.lineTo(cx + headR * 1.7, headY + headR * 3.2);
      x.lineTo(cx + headR * 0.45, headY + headR * 0.8);
      x.closePath();
      x.fill();
    }

    // --- vignette for big sizes
    if (S >= 96) {
      const vig = x.createRadialGradient(S / 2, S / 2, S * 0.3, S / 2, S / 2, S * 0.74);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.4)");
      x.fillStyle = vig;
      x.fillRect(0, 0, S, S);
    }

    return c.toDataURL("image/png");
  }

  const sizes = [16, 32, 48, 180, 192, 512];
  const out = {};
  for (const s of sizes) out[s] = draw(s);

  // review grid
  const pad = 12, cell = 220;
  const grid = document.createElement("canvas");
  grid.width = cell * 3 + pad * 4;
  grid.height = cell * 2 + pad * 3;
  const g = grid.getContext("2d");
  g.fillStyle = "#202020";
  g.fillRect(0, 0, grid.width, grid.height);
  g.imageSmoothingEnabled = false;
  return new Promise((resolve) => {
    let loaded = 0;
    sizes.forEach((s, i) => {
      const img = new Image();
      img.onload = () => {
        const cx = pad + (i % 3) * (cell + pad);
        const cy = pad + Math.floor(i / 3) * (cell + pad);
        const d = Math.min(cell - 24, s >= 160 ? cell - 24 : s * (s <= 48 ? 4 : 1));
        g.drawImage(img, cx + (cell - d) / 2, cy + (cell - d) / 2 - 8, d, d);
        g.fillStyle = "#ddd";
        g.font = "13px monospace";
        g.textAlign = "center";
        g.fillText(`${s}px`, cx + cell / 2, cy + cell - 6);
        if (++loaded === sizes.length) {
          out.preview = grid.toDataURL("image/png");
          resolve(out);
        }
      };
      img.src = out[s];
    });
  });
});
await browser.close();

const buf = (dataUrl) => Buffer.from(dataUrl.split(",")[1], "base64");

/** Pack PNG blobs into a .ico container (PNG-in-ICO, Vista+/all browsers). */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  const dirs = [];
  const blobs = [];
  let offset = 6 + 16 * entries.length;
  for (const { size, data } of entries) {
    const d = Buffer.alloc(16);
    d.writeUInt8(size >= 256 ? 0 : size, 0);
    d.writeUInt8(size >= 256 ? 0 : size, 1);
    d.writeUInt16LE(1, 4); // planes
    d.writeUInt16LE(32, 6); // bpp
    d.writeUInt32LE(data.length, 8);
    d.writeUInt32LE(offset, 12);
    offset += data.length;
    dirs.push(d);
    blobs.push(data);
  }
  return Buffer.concat([header, ...dirs, ...blobs]);
}

writeFileSync("app/favicon.ico", buildIco([
  { size: 16, data: buf(pngs[16]) },
  { size: 32, data: buf(pngs[32]) },
  { size: 48, data: buf(pngs[48]) },
]));
writeFileSync("app/icon.png", buf(pngs[192]));
writeFileSync("app/apple-icon.png", buf(pngs[180]));
mkdirSync("public", { recursive: true });
writeFileSync("public/icon-192.png", buf(pngs[192]));
writeFileSync("public/icon-512.png", buf(pngs[512]));
writeFileSync("scripts/shots/icon-preview.png", buf(pngs.preview));
console.log("ICONS WRITTEN: favicon.ico (16/32/48), icon.png 192, apple-icon.png 180, public 192/512");
