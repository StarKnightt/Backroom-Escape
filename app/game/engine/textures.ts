import * as THREE from "three";
import { mulberry32, randRange, ValueNoise } from "./rng";

/**
 * 100% procedural asset generation. No image files — every surface in the
 * game is painted onto canvases at boot: albedo, plus normal + roughness maps
 * derived from a height field so the flashlight raking across walls reveals
 * believable surface relief.
 */

export interface PBRMaps {
  map: THREE.CanvasTexture;
  normalMap: THREE.CanvasTexture;
  roughnessMap: THREE.CanvasTexture;
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return { canvas: c, ctx: c.getContext("2d")! };
}

function tex(
  canvas: HTMLCanvasElement,
  opts: { srgb?: boolean; repeat?: boolean; anisotropy?: number } = {},
): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (opts.repeat !== false) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
  }
  t.anisotropy = opts.anisotropy ?? 8;
  t.needsUpdate = true;
  return t;
}

/** Sobel filter over a grayscale height array -> tangent-space normal map. */
function normalFromHeight(
  height: Float32Array,
  w: number,
  h: number,
  strength: number,
): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  const d = img.data;
  const at = (x: number, y: number) =>
    height[((y + h) % h) * w + ((x + w) % w)];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx =
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength;
      let ny = -dy * strength;
      let nz = 1;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
      nx /= len;
      ny /= len;
      nz /= len;
      const i = (y * w + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function grayCanvas(values: Float32Array, w: number, h: number): HTMLCanvasElement {
  const { canvas, ctx } = makeCanvas(w, h);
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(1, values[i])) * 255;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
    img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

/* ------------------------------------------------------------------ */
/*  WALLS — cream painted plaster, wood skirting, white cornice        */
/*  The reference is a 1970s Mediterranean apartment block at night:   */
/*  mustard-cream gotelé walls, varnished timber trim, aged patches.   */
/* ------------------------------------------------------------------ */

export function makeWallMaps(seed: number): PBRMaps {
  const S = 1024;
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 1);
  const n2 = new ValueNoise(seed + 2);
  const n3 = new ValueNoise(seed + 3);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  // Texture spans 4m wide x 3m tall (one wall segment). 1px ≈ 3.9mm/2.9mm.
  const skirtPx = Math.floor(S * 0.042); // ~12cm varnished timber skirting
  const cornicePx = Math.floor(S * 0.032); // ~10cm of ceiling white folding down
  for (let y = 0; y < S; y++) {
    const vy = y / S; // 0 = ceiling line, 1 = floor
    for (let x = 0; x < S; x++) {
      const i = y * S + x;

      // Gotelé: the sprayed-plaster stipple every Spanish hallway wears.
      // Fine and low-contrast — it should only show when light rakes it.
      const stipple = n1.noise(x * 0.9, y * 0.9);
      const stipple2 = n1.noise(x * 0.3 + 61, y * 0.3);
      const grain = n1.fbm(x * 0.05, y * 0.05, 3) * 0.06 + 0.97;
      const mottle = n2.fbm(x * 0.007, y * 0.007, 4); // uneven old paint

      // Cream-mustard emulsion — light, warm, slightly dirty.
      let r = 213, g = 198, b = 149;
      const bump = 0.955 + stipple * 0.06 + stipple2 * 0.035;
      const shade = grain * bump * (0.9 + mottle * 0.2);
      r *= shade; g *= shade; b *= shade;

      // Hand-height grime and scuffing along the traffic band.
      const traffic = Math.exp(-Math.pow((vy - 0.62) / 0.22, 2));
      const dirt = n3.fbm(x * 0.02, y * 0.02, 3) * traffic * 0.22;
      r *= 1 - dirt * 0.6; g *= 1 - dirt * 0.66; b *= 1 - dirt * 0.7;

      // Damp bloom creeping up from the floor in patches.
      const dampLine = 0.8 + n3.noise(x * 0.011, 7.7) * 0.13;
      if (vy > dampLine) {
        const t = Math.min(1, (vy - dampLine) / (1 - dampLine));
        const blotch = 0.55 + n3.fbm(x * 0.022, y * 0.022, 3) * 0.5;
        const k = t * blotch * 0.3;
        r *= 1 - k * 0.45;
        g *= 1 - k * 0.5;
        b *= 1 - k * 0.42;
      }

      // Cornice: the ceiling's white wraps a hand's width down the wall.
      if (y < cornicePx) {
        const t = y / cornicePx;
        const cn = n1.noise(x * 0.06, y * 0.3) * 10;
        const w = 224 + cn;
        r = w; g = w * 0.995; b = w * 0.965;
        if (t > 0.86) { r *= 0.8; g *= 0.79; b *= 0.77; } // shadow under the lip
      }

      // Skirting: varnished timber, warm and orange under tungsten.
      const fromBottom = S - 1 - y;
      if (fromBottom < skirtPx) {
        const t = fromBottom / skirtPx;
        const wood = n1.noise(x * 0.6, y * 0.06); // long horizontal grain
        const wood2 = n2.fbm(x * 0.03, y * 0.2, 3);
        const k = 0.82 + wood * 0.22 + wood2 * 0.16;
        r = 150 * k; g = 92 * k; b = 45 * k;
        if (t > 0.9) { r *= 1.16; g *= 1.16; b *= 1.14; } // moulded top edge
        if (t < 0.12) { r *= 0.6; g *= 0.6; b *= 0.6; } // dust line at the floor
      }

      d[i * 4] = r;
      d[i * 4 + 1] = g;
      d[i * 4 + 2] = b;
      d[i * 4 + 3] = 255;

      const isSkirt = fromBottom < skirtPx;
      height[i] = isSkirt
        ? 0.75
        : stipple * 0.4 + stipple2 * 0.25 + mottle * 0.35;
      // Emulsion is flat; varnished wood is not.
      rough[i] = isSkirt ? 0.42 + n1.noise(x * 0.3, y * 0.3) * 0.1 : 0.9 - mottle * 0.07;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Scuffs from furniture, bikes and shoulders dragged along the corridor.
  ctx.globalAlpha = 0.13;
  ctx.strokeStyle = "#4a3d24";
  for (let s = 0; s < 22; s++) {
    ctx.lineWidth = randRange(rng, 0.6, 2.2);
    const sy = S * randRange(rng, 0.5, 0.9);
    const sx = rng() * S;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(
      sx + randRange(rng, -80, 80),
      sy + randRange(rng, -10, 10),
      sx + randRange(rng, -180, 180),
      sy + randRange(rng, -18, 18),
    );
    ctx.stroke();
  }
  // Patched repaints — a slightly different batch of the same yellow.
  ctx.globalAlpha = 0.09;
  for (let s = 0; s < 5; s++) {
    ctx.fillStyle = rng() < 0.5 ? "#e6dcb4" : "#9c8f60";
    const px = rng() * S, py = randRange(rng, S * 0.2, S * 0.8);
    ctx.beginPath();
    ctx.ellipse(px, py, randRange(rng, 40, 150), randRange(rng, 30, 110), rng() * 3, 0, 7);
    ctx.fill();
  }
  // Rain-streak grime running down from the cornice.
  ctx.globalAlpha = 0.08;
  for (let s = 0; s < 6; s++) {
    const sx = rng() * S;
    const len = randRange(rng, 60, 300);
    const grad = ctx.createLinearGradient(0, 0, 0, len);
    grad.addColorStop(0, "rgba(84,70,40,0.8)");
    grad.addColorStop(1, "rgba(84,70,40,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(sx, 0, randRange(rng, 3, 11), len);
  }
  ctx.globalAlpha = 1;

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.7)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ------------------------------------------------------------- */
/*  FLOOR — polished terrazzo: stone chips in cement, waxed hard  */
/* ------------------------------------------------------------- */

export function makeFloorMaps(seed: number): PBRMaps {
  const S = 1024; // covers 2m x 2m
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 11);
  const n2 = new ValueNoise(seed + 12);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;

  // Cement matrix — warm grey with a faint pink cast, unevenly worn.
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const fine = n1.noise(x * 0.8, y * 0.8);
      const patch = n2.fbm(x * 0.005, y * 0.005, 4);
      const k = 0.86 + fine * 0.1 + patch * 0.16;
      d[i * 4] = 178 * k;
      d[i * 4 + 1] = 168 * k;
      d[i * 4 + 2] = 156 * k;
      d[i * 4 + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // The chips. Ground flat with the cement, so they are pure color, no relief.
  const CHIPS = [
    "#ded9cf", "#efece4", "#cfc7b6", // whites / limestones
    "#6f6a63", "#4a4642", "#2e2b29", // greys / basalts
    "#a8836c", "#8e5f4c", "#b09678", // warm browns
    "#9aa39a", "#7d8a86", // faint greens
  ];
  for (let c = 0; c < 4200; c++) {
    const cx = rng() * S, cy = rng() * S;
    const rx = randRange(rng, 2.2, 12);
    const ry = rx * randRange(rng, 0.45, 1);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rng() * Math.PI);
    ctx.fillStyle = CHIPS[Math.floor(rng() * CHIPS.length)];
    ctx.globalAlpha = 0.55 + rng() * 0.45;
    // Angular, not round — these were crushed, not tumbled.
    ctx.beginPath();
    const sides = 5 + Math.floor(rng() * 3);
    for (let s = 0; s < sides; s++) {
      const a = (s / sides) * Math.PI * 2;
      const jr = 0.72 + rng() * 0.5;
      const px = Math.cos(a) * rx * jr;
      const py = Math.sin(a) * ry * jr;
      if (s === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  ctx.globalAlpha = 1;

  // Decades of foot traffic: dull haze, scratches from dragged furniture.
  ctx.globalAlpha = 0.07;
  for (let s = 0; s < 12; s++) {
    const sx = rng() * S, sy = rng() * S, rad = randRange(rng, 60, 220);
    const grad = ctx.createRadialGradient(sx, sy, rad * 0.15, sx, sy, rad);
    grad.addColorStop(0, "rgba(60,54,46,0.9)");
    grad.addColorStop(1, "rgba(60,54,46,0)");
    ctx.fillStyle = grad;
    ctx.fillRect(sx - rad, sy - rad, rad * 2, rad * 2);
  }
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = "#efeae0";
  for (let s = 0; s < 40; s++) {
    ctx.lineWidth = randRange(rng, 0.4, 1.1);
    const sx = rng() * S, sy = rng() * S;
    const a = rng() * Math.PI;
    const len = randRange(rng, 20, 180);
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + Math.cos(a) * len, sy + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Polished stone: almost no relief, and glossy enough to throw the long
  // smeared reflections of the ceiling tubes back down the corridor.
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const wear = n2.fbm(x * 0.004 + 17, y * 0.004, 3);
      const micro = n1.noise(x * 0.35, y * 0.35);
      height[i] = micro * 0.2 + wear * 0.1;
      rough[i] = 0.17 + wear * 0.22 + micro * 0.05; // waxed, walked-on shine
    }
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.35)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ----------------------------------------------------------- */
/*  CEILING — smooth white plaster, hairline cracks, damp rings */
/* ----------------------------------------------------------- */

export function makeCeilingMaps(seed: number): PBRMaps {
  const S = 1024; // covers 4m x 4m
  const rng = mulberry32(seed);
  const n1 = new ValueNoise(seed + 21);
  const n2 = new ValueNoise(seed + 22);

  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);

  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const roller = n1.noise(x * 0.55, y * 0.55); // roller stipple
      const broad = n2.fbm(x * 0.006, y * 0.006, 4); // uneven skim coat
      const v = 231 * (0.9 + roller * 0.07 + broad * 0.1);
      d[i * 4] = v;
      d[i * 4 + 1] = v * 0.995;
      d[i * 4 + 2] = v * 0.972; // barely warm white
      d[i * 4 + 3] = 255;
      height[i] = roller * 0.2 + broad * 0.35;
      rough[i] = 0.9 - broad * 0.06;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Hairline cracks in the plaster, branching the way settling cracks do.
  ctx.strokeStyle = "rgba(140,132,118,0.5)";
  for (let c = 0; c < 7; c++) {
    let px = rng() * S, py = rng() * S;
    let a = rng() * Math.PI * 2;
    ctx.lineWidth = randRange(rng, 0.5, 1.4);
    ctx.beginPath();
    ctx.moveTo(px, py);
    const segs = 6 + Math.floor(rng() * 12);
    for (let s = 0; s < segs; s++) {
      a += randRange(rng, -0.7, 0.7);
      px += Math.cos(a) * randRange(rng, 8, 34);
      py += Math.sin(a) * randRange(rng, 8, 34);
      ctx.lineTo(px, py);
    }
    ctx.stroke();
  }

  // The neighbour upstairs has a leak. They always do. Kept faint — the
  // ceiling tiles across the whole level, and a strong mark would read as
  // wallpaper the moment you look down a long corridor.
  for (let s = 0; s < 2; s++) {
    const tx = rng() * S, ty = rng() * S;
    let rad = randRange(rng, 50, 130);
    for (let ring = 0; ring < 3; ring++) {
      ctx.beginPath();
      ctx.arc(tx + randRange(rng, -12, 12), ty + randRange(rng, -12, 12), rad, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(150,124,80,${0.1 - ring * 0.025})`;
      ctx.lineWidth = randRange(rng, 3, 9);
      ctx.stroke();
      ctx.fillStyle = `rgba(168,142,96,${0.035 - ring * 0.008})`;
      ctx.fill();
      rad *= randRange(rng, 0.7, 0.9);
    }
  }

  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.45)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ------------------------------------------------------ */
/*  CEILING TUBE — surface-mounted fluorescent batten       */
/* ------------------------------------------------------ */

export function makeLightPanelTexture(): THREE.CanvasTexture {
  const W = 256, H = 48;
  const { canvas, ctx } = makeCanvas(W, H);
  // Painted metal batten body.
  ctx.fillStyle = "#d8d4c6";
  ctx.fillRect(0, 0, W, H);
  // The tube itself: a hot line down the middle, warm white.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, "rgba(255,244,214,0.15)");
  grad.addColorStop(0.34, "rgba(255,248,226,0.95)");
  grad.addColorStop(0.5, "#fffbf0");
  grad.addColorStop(0.66, "rgba(255,248,226,0.95)");
  grad.addColorStop(1, "rgba(255,244,214,0.15)");
  ctx.fillStyle = grad;
  ctx.fillRect(14, 4, W - 28, H - 8);
  // Blackened cathode ends — every tube in a stairwell has them.
  for (const [x0, x1] of [[16, 34], [W - 16, W - 34]]) {
    const eg = ctx.createLinearGradient(x0, 0, x1, 0);
    eg.addColorStop(0, "rgba(90,78,54,0.75)");
    eg.addColorStop(1, "rgba(90,78,54,0)");
    ctx.fillStyle = eg;
    ctx.fillRect(Math.min(x0, x1), 4, Math.abs(x1 - x0), H - 8);
  }
  // End caps.
  ctx.fillStyle = "#b9b4a4";
  ctx.fillRect(0, 0, 12, H);
  ctx.fillRect(W - 12, 0, 12, H);
  // Dead flies collected in the trough. Disgusting. Perfect.
  ctx.fillStyle = "rgba(70,58,34,0.55)";
  ctx.beginPath(); ctx.ellipse(W * 0.36, H * 0.6, 4, 2.4, 0.5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.ellipse(W * 0.71, H * 0.42, 3.4, 2, 1.2, 0, 7); ctx.fill();
  return tex(canvas, { srgb: true, repeat: false });
}

/* ------------------------------------------------------------------ */
/*  APARTMENT DOORS — the thing you actually see in those photos       */
/* ------------------------------------------------------------------ */

/** How many door faces live side by side in the atlas. */
export const DOOR_VARIANTS = 4;

/**
 * One atlas holding every apartment door in the building, so the whole
 * corridor's worth of doors is a single draw call. Varnished hardwood,
 * two sunken panels, a lever handle and a number nobody has polished in
 * thirty years.
 */
export function makeDoorAtlasTexture(seed: number): THREE.CanvasTexture {
  const DW = 256, DH = 512; // one door cell
  const W = DW * DOOR_VARIANTS, H = DH;
  const rng = mulberry32(seed + 91);
  const n = new ValueNoise(seed + 92);
  const { canvas, ctx } = makeCanvas(W, H);

  // Timber tones: mahogany, sapele, a paler oak, a dark walnut.
  const TONES: [number, number, number][] = [
    [126, 62, 34],
    [142, 74, 38],
    [150, 96, 52],
    [96, 50, 30],
  ];

  for (let v = 0; v < DOOR_VARIANTS; v++) {
    const ox = v * DW;
    const [br, bg, bb] = TONES[v % TONES.length];

    // --- grain: vertical, with a few knots and wandering rings
    const img = ctx.createImageData(DW, DH);
    for (let y = 0; y < DH; y++) {
      for (let x = 0; x < DW; x++) {
        const i = (y * DW + x) * 4;
        const wander = n.fbm(x * 0.01 + v * 40, y * 0.004, 3) * 26;
        const rings = Math.sin((x + wander) * 0.55) * 0.5 + 0.5;
        const fine = n.noise(x * 1.4 + v * 13, y * 0.06);
        const k = 0.85 + rings * 0.09 + fine * 0.1;
        img.data[i] = br * k;
        img.data[i + 1] = bg * k;
        img.data[i + 2] = bb * k;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, ox, 0);

    // --- two sunken panels with mitred bevels
    const panels: [number, number, number, number][] = [
      [34, 34, DW - 68, DH * 0.36],
      [34, DH * 0.46, DW - 68, DH * 0.46],
    ];
    for (const [px, py, pw, ph] of panels) {
      ctx.save();
      ctx.translate(ox, 0);
      // sunken face: slightly darker
      ctx.fillStyle = "rgba(0,0,0,0.13)";
      ctx.fillRect(px + 9, py + 9, pw - 18, ph - 18);
      // bevel: lit on top-left, shadowed bottom-right (tubes are overhead)
      ctx.strokeStyle = "rgba(255,225,180,0.16)";
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(px, py + ph);
      ctx.lineTo(px, py);
      ctx.lineTo(px + pw, py);
      ctx.stroke();
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.beginPath();
      ctx.moveTo(px + pw, py);
      ctx.lineTo(px + pw, py + ph);
      ctx.lineTo(px, py + ph);
      ctx.stroke();
      // inner shadow line where the panel drops away
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 9, py + 9, pw - 18, ph - 18);
      ctx.restore();
    }

    // --- escutcheon + keyhole. The lever itself is real geometry (level.ts),
    // so all that belongs here is the plate it screws through and its shadow.
    const hx = ox + (v % 2 === 0 ? DW - 46 : 46);
    const hy = DH * 0.5;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.beginPath();
    ctx.ellipse(hx + 3, hy + 5, 15, 22, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#8d7233";
    ctx.beginPath();
    ctx.ellipse(hx, hy, 14, 21, 0, 0, 7);
    ctx.fill();
    ctx.fillStyle = "#b09246";
    ctx.beginPath();
    ctx.ellipse(hx - 3, hy - 4, 9, 14, 0, 0, 7);
    ctx.fill();
    // keyhole below
    ctx.fillStyle = "rgba(20,12,6,0.85)";
    ctx.beginPath();
    ctx.ellipse(hx, hy + 44, 5, 6, 0, 0, 7);
    ctx.fill();
    ctx.fillRect(hx - 2, hy + 46, 4, 11);

    // --- the flat number, screwed on and never straightened
    ctx.save();
    ctx.translate(ox + DW * 0.5, DH * 0.235);
    ctx.rotate(randRange(rng, -0.05, 0.05));
    ctx.fillStyle = "rgba(24,16,8,0.6)";
    ctx.font = "bold 40px Georgia, serif";
    ctx.textAlign = "center";
    ctx.fillText(`${1 + v}º`, 2, 2);
    ctx.fillStyle = "#a68d5c";
    ctx.fillText(`${1 + v}º`, 0, 0);
    ctx.restore();

    // --- wear: kicked bottom rail, grime around the handle
    const kick = ctx.createLinearGradient(0, DH, 0, DH - 70);
    kick.addColorStop(0, "rgba(24,14,8,0.5)");
    kick.addColorStop(1, "rgba(24,14,8,0)");
    ctx.fillStyle = kick;
    ctx.fillRect(ox, DH - 70, DW, 70);
    const grime = ctx.createRadialGradient(hx, hy, 8, hx, hy, 80);
    grime.addColorStop(0, "rgba(18,10,4,0.4)");
    grime.addColorStop(1, "rgba(18,10,4,0)");
    ctx.fillStyle = grime;
    ctx.fillRect(hx - 90, hy - 90, 180, 180);

    // --- scratches
    ctx.strokeStyle = "rgba(30,18,10,0.4)";
    for (let s = 0; s < 16; s++) {
      ctx.lineWidth = randRange(rng, 0.4, 1.6);
      const sx = ox + rng() * DW, sy = rng() * DH;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + randRange(rng, -30, 30), sy + randRange(rng, -40, 40));
      ctx.stroke();
    }
  }

  return tex(canvas, { srgb: true, repeat: false });
}

/** Enamelled letter plate screwed to the wall beside every door. */
export function makeDoorPlaqueTexture(seed: number): THREE.CanvasTexture {
  const W = 128, H = 160;
  const rng = mulberry32(seed + 77);
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#b9b2a0";
  ctx.fillRect(0, 0, W, H);
  // aged enamel, chipped at the corners
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(${120 + rng() * 60},${112 + rng() * 60},${96 + rng() * 50},${0.1 + rng() * 0.2})`;
    ctx.fillRect(rng() * W, rng() * H, 2 + rng() * 16, 2 + rng() * 10);
  }
  ctx.strokeStyle = "rgba(60,54,42,0.5)";
  ctx.lineWidth = 3;
  ctx.strokeRect(5, 5, W - 10, H - 10);
  // an engraved letter, worn past reading
  ctx.fillStyle = "rgba(48,42,32,0.75)";
  ctx.font = "bold 66px Georgia, serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("A", W / 2, H * 0.38);
  ctx.font = "22px Georgia, serif";
  ctx.fillStyle = "rgba(48,42,32,0.5)";
  ctx.fillText("· · ·", W / 2, H * 0.72);
  // two screws
  ctx.fillStyle = "rgba(70,64,52,0.8)";
  ctx.beginPath(); ctx.arc(W / 2, 20, 5, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(W / 2, H - 20, 5, 0, 7); ctx.fill();
  return tex(canvas, { srgb: true, repeat: false });
}

/* ------------------------------------------------------------------ */
/*  CORRIDOR FITTINGS — the clutter that makes a building a building   */
/* ------------------------------------------------------------------ */

/** Fire hose cabinet: red steel box, white door, a pictogram nobody reads. */
export function makeFireCabinetTexture(seed: number): THREE.CanvasTexture {
  const W = 256, H = 224;
  const rng = mulberry32(seed + 201);
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#a8221b";
  ctx.fillRect(0, 0, W, H);
  // white inner door with a wired-glass pane
  ctx.fillStyle = "#d9d6cd";
  ctx.fillRect(16, 16, W - 32, H - 32);
  const g = ctx.createLinearGradient(0, 26, 0, H - 26);
  g.addColorStop(0, "#8e9a96");
  g.addColorStop(1, "#5d6764");
  ctx.fillStyle = g;
  ctx.fillRect(30, 30, W - 60, H - 60);
  ctx.strokeStyle = "rgba(220,225,220,0.12)";
  ctx.lineWidth = 1;
  for (let x = 30; x < W - 30; x += 11) {
    ctx.beginPath(); ctx.moveTo(x, 30); ctx.lineTo(x, H - 30); ctx.stroke();
  }
  // the coiled hose behind the glass
  ctx.strokeStyle = "rgba(190,60,40,0.55)";
  ctx.lineWidth = 9;
  for (let r = 26; r < 66; r += 13) {
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // red band + lettering across the bottom
  ctx.fillStyle = "#a8221b";
  ctx.fillRect(16, H - 52, W - 32, 36);
  ctx.fillStyle = "#f2ece0";
  ctx.font = "bold 19px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("ROMPASE EN CASO DE INCENDIO", W / 2, H - 27, W - 44);
  // grime + a dent
  ctx.fillStyle = "rgba(30,14,10,0.18)";
  for (let s = 0; s < 40; s++) {
    ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 12, 1 + rng() * 4);
  }
  return tex(canvas, { srgb: true, repeat: false });
}

/** The small red safety plate screwed above an extinguisher. */
export function makeSafetySignTexture(): THREE.CanvasTexture {
  const W = 128, H = 176;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#b21e16";
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 4;
  ctx.strokeRect(7, 7, W - 14, H - 14);
  // extinguisher pictogram
  ctx.fillStyle = "#f4efe6";
  ctx.fillRect(W / 2 - 16, 52, 32, 66);
  ctx.fillRect(W / 2 - 6, 38, 12, 16);
  ctx.beginPath();
  ctx.moveTo(W / 2 + 6, 44);
  ctx.quadraticCurveTo(W / 2 + 34, 46, W / 2 + 30, 74);
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#f4efe6";
  ctx.stroke();
  ctx.font = "bold 15px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("EXTINTOR", W / 2, H - 24);
  return tex(canvas, { srgb: true, repeat: false });
}

/** Grey meter cabinet — every landing has one, always locked. */
export function makeMeterPanelTexture(seed: number): THREE.CanvasTexture {
  const W = 192, H = 240;
  const rng = mulberry32(seed + 211);
  const n = new ValueNoise(seed + 212);
  const { canvas, ctx } = makeCanvas(W, H);
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const k = 0.86 + n.noise(x * 0.5, y * 0.5) * 0.14 + n.fbm(x * 0.02, y * 0.02, 3) * 0.16;
      img.data[i] = 176 * k;
      img.data[i + 1] = 175 * k;
      img.data[i + 2] = 168 * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  // pressed door edge
  ctx.strokeStyle = "rgba(90,90,84,0.6)";
  ctx.lineWidth = 3;
  ctx.strokeRect(9, 9, W - 18, H - 18);
  ctx.strokeStyle = "rgba(255,255,250,0.25)";
  ctx.lineWidth = 2;
  ctx.strokeRect(14, 14, W - 28, H - 28);
  // louvre slots
  ctx.fillStyle = "rgba(60,60,56,0.65)";
  for (let i = 0; i < 5; i++) ctx.fillRect(34, 34 + i * 13, W - 68, 5);
  // triangular lock + warning label
  ctx.fillStyle = "rgba(70,68,62,0.9)";
  ctx.beginPath();
  ctx.arc(W - 34, H / 2, 11, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e8e2cf";
  ctx.fillRect(28, H - 74, 78, 34);
  ctx.fillStyle = "#7a1410";
  ctx.font = "bold 13px Arial, sans-serif";
  ctx.fillText("PELIGRO", 34, H - 52);
  ctx.font = "9px Arial, sans-serif";
  ctx.fillStyle = "#3a352c";
  ctx.fillText("ALTA TENSION", 34, H - 42);
  ctx.fillStyle = "rgba(40,38,32,0.2)";
  for (let s = 0; s < 30; s++) ctx.fillRect(rng() * W, rng() * H, 1 + rng() * 9, 1 + rng() * 3);
  return tex(canvas, { srgb: true, repeat: false });
}

/** Louvred vent grille over a doorway — painted the same tired green. */
export function makeVentGrilleTexture(): THREE.CanvasTexture {
  const W = 256, H = 80;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#7d8c6a";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#1c1f18";
  ctx.fillRect(10, 10, W - 20, H - 20);
  // slats, lit along their top edge
  for (let i = 0; i < 6; i++) {
    const y = 14 + i * 9.5;
    ctx.fillStyle = "#93a17c";
    ctx.fillRect(12, y, W - 24, 6);
    ctx.fillStyle = "rgba(255,255,235,0.22)";
    ctx.fillRect(12, y, W - 24, 1.5);
  }
  ctx.strokeStyle = "rgba(40,46,34,0.8)";
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  return tex(canvas, { srgb: true, repeat: false });
}

/** How many notice sheets live in the atlas. */
export const NOTICE_VARIANTS = 4;

/**
 * A4 sheets taped up by the residents' association: meeting dates, a lift
 * out of service, a complaint about the bins. Typed, photocopied, curling.
 */
export function makeNoticeAtlasTexture(seed: number): THREE.CanvasTexture {
  const NW = 256, NH = 362;
  const W = NW * NOTICE_VARIANTS, H = NH;
  const rng = mulberry32(seed + 221);
  const n = new ValueNoise(seed + 222);
  const { canvas, ctx } = makeCanvas(W, H);

  const HEADS = ["AVISO", "COMUNIDAD", "ASCENSOR", "SE RUEGA"];
  for (let v = 0; v < NOTICE_VARIANTS; v++) {
    const ox = v * NW;
    // paper, gone ivory
    const img = ctx.createImageData(NW, NH);
    for (let y = 0; y < NH; y++) {
      for (let x = 0; x < NW; x++) {
        const i = (y * NW + x) * 4;
        const k = 0.88 + n.fbm((x + v * 300) * 0.02, y * 0.02, 3) * 0.2;
        img.data[i] = 226 * k;
        img.data[i + 1] = 222 * k;
        img.data[i + 2] = 205 * k;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, ox, 0);

    ctx.save();
    ctx.translate(ox, 0);
    // heading
    ctx.fillStyle = "#22201c";
    ctx.font = "bold 30px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(HEADS[v % HEADS.length], NW / 2, 60);
    ctx.fillRect(40, 74, NW - 80, 2);
    // body: typed lines, ragged right
    ctx.fillStyle = "rgba(38,36,32,0.7)";
    for (let l = 0; l < 11; l++) {
      const y = 104 + l * 17;
      if (l === 5 && v % 2 === 0) continue; // paragraph break
      ctx.fillRect(30, y, (NW - 90) * (0.55 + rng() * 0.45), 4);
    }
    // a date and a scrawled signature
    ctx.fillStyle = "rgba(38,36,32,0.6)";
    ctx.fillRect(30, NH - 74, 90, 4);
    ctx.strokeStyle = "rgba(30,40,110,0.55)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(NW - 130, NH - 44);
    for (let s = 0; s < 6; s++) {
      ctx.quadraticCurveTo(
        NW - 120 + s * 18, NH - 44 + (s % 2 ? 16 : -16),
        NW - 110 + s * 18, NH - 44,
      );
    }
    ctx.stroke();
    // tape at the top corners, and a curling shadow down one side
    ctx.fillStyle = "rgba(214,208,186,0.55)";
    ctx.fillRect(16, -6, 54, 26);
    ctx.fillRect(NW - 70, -6, 54, 26);
    const curl = ctx.createLinearGradient(NW - 40, 0, NW, 0);
    curl.addColorStop(0, "rgba(60,54,40,0)");
    curl.addColorStop(1, "rgba(60,54,40,0.35)");
    ctx.fillStyle = curl;
    ctx.fillRect(NW - 40, 0, 40, NH);
    ctx.restore();
  }
  return tex(canvas, { srgb: true, repeat: false });
}

/** Varnished timber for the door architraves. */
export function makeTrimMaps(seed: number): PBRMaps {
  const S = 256; // tiles over 0.5m
  const n = new ValueNoise(seed + 101);
  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const wander = n.fbm(x * 0.02, y * 0.006, 3) * 22;
      const rings = Math.sin((x + wander) * 0.4) * 0.5 + 0.5;
      const fine = n.noise(x * 1.2, y * 0.08);
      const k = 0.8 + rings * 0.2 + fine * 0.12;
      img.data[i * 4] = 138 * k;
      img.data[i * 4 + 1] = 96 * k;
      img.data[i * 4 + 2] = 58 * k;
      img.data[i * 4 + 3] = 255;
      height[i] = rings * 0.5 + fine * 0.3;
      rough[i] = 0.38 + rings * 0.14; // varnish
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 0.5)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ------------------------------------ */
/*  JOURNAL PAGES — handwritten scraps   */
/* ------------------------------------ */

export const PAGE_TEXTS: string[][] = [
  ["DAY 1?", "noclipped through the", "office floor. carpet is", "damp. the hum never", "stops. never."],
  ["the lights go out", "when IT walks.", "count the seconds.", "it counts too."],
  ["DON'T RUN.", "running makes noise.", "noise makes it", "curious."],
  ["i saw it standing in", "the dark today.", "it didn't move.", "it was watching me", "blink."],
  ["the walls taste like", "old paper. i licked", "them. i'm sorry.", "i was so hungry."],
  ["if you look at it,", "it stops. it waits.", "your eyes get dry.", "you WILL blink."],
  ["found a door once.", "green light above it.", "it was humming a", "different song."],
  ["8 pages. that's all", "i had left. if you", "found them all —", "the exit knows you.", "RUN FOR IT."],
];

export function makePageTexture(seed: number, index: number): THREE.CanvasTexture {
  const W = 256, H = 330;
  const rng = mulberry32(seed + index * 977);
  const n = new ValueNoise(seed + 31 + index);
  const { canvas, ctx } = makeCanvas(W, H);

  // Aged paper base with blotches.
  ctx.fillStyle = "#cfc3a2";
  ctx.fillRect(0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const k = 0.82 + n.fbm(x * 0.03, y * 0.03, 3) * 0.3;
      img.data[i] *= k;
      img.data[i + 1] *= k * 0.99;
      img.data[i + 2] *= k * 0.94;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Coffee-ish ring stain.
  if (rng() > 0.4) {
    const sx = randRange(rng, 40, W - 40), sy = randRange(rng, 40, H - 40);
    ctx.strokeStyle = "rgba(110,70,30,0.30)";
    ctx.lineWidth = randRange(rng, 3, 6);
    ctx.beginPath();
    ctx.arc(sx, sy, randRange(rng, 18, 36), 0, Math.PI * 2);
    ctx.stroke();
  }

  // Creased fold lines.
  ctx.strokeStyle = "rgba(80,70,50,0.35)";
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, H * 0.52 + randRange(rng, -8, 8));
  ctx.lineTo(W, H * 0.5 + randRange(rng, -8, 8)); ctx.stroke();

  // Scrawled text, hand-jittered per line.
  const lines = PAGE_TEXTS[index % PAGE_TEXTS.length];
  ctx.fillStyle = "rgba(38,30,28,0.92)";
  lines.forEach((line, li) => {
    ctx.save();
    const fs = 24 + Math.floor(rng() * 4);
    ctx.font = `italic ${fs}px Georgia, serif`;
    ctx.translate(18 + randRange(rng, -4, 6), 56 + li * 50 + randRange(rng, -6, 6));
    ctx.rotate(randRange(rng, -0.05, 0.05));
    ctx.fillText(line, 0, 0, W - 36);
    ctx.restore();
  });
  // Frantic underline on a random line.
  ctx.strokeStyle = "rgba(60,20,18,0.8)";
  ctx.lineWidth = 2;
  const uy = 64 + Math.floor(rng() * lines.length) * 50;
  ctx.beginPath();
  ctx.moveTo(16, uy);
  ctx.quadraticCurveTo(W / 2, uy + randRange(rng, -4, 8), W - 30, uy + randRange(rng, -5, 5));
  ctx.stroke();

  return tex(canvas, { srgb: true, repeat: false });
}

/* ------------------------------- */
/*  EXIT DOOR + glowing EXIT sign   */
/* ------------------------------- */

/**
 * The way out is the building's street door — heavy, dark green paint over
 * steel, wired glass at head height with the night behind it. It is the one
 * door in here that does not belong to a flat.
 */
export function makeDoorTexture(seed: number): THREE.CanvasTexture {
  const W = 512, H = 1024;
  const rng = mulberry32(seed + 41);
  const n = new ValueNoise(seed + 42);
  const { canvas, ctx } = makeCanvas(W, H);

  // Old oil paint over steel: deep green, brush-marked, chalky where it aged.
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const brush = n.noise(x * 0.12, y * 0.9);
      const broad = n.fbm(x * 0.008, y * 0.008, 3);
      const k = 0.72 + brush * 0.16 + broad * 0.24;
      img.data[i] = 46 * k;
      img.data[i + 1] = 66 * k;
      img.data[i + 2] = 50 * k;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);

  // Raised bottom panel, framed by a moulding.
  ctx.strokeStyle = "rgba(12,20,14,0.6)";
  ctx.lineWidth = 5;
  ctx.strokeRect(44, H * 0.52, W - 88, H * 0.34);
  ctx.strokeStyle = "rgba(150,170,140,0.14)";
  ctx.lineWidth = 2;
  ctx.strokeRect(50, H * 0.52 + 6, W - 100, H * 0.34 - 12);

  // Wired-glass window: cold light from the street, chicken-wire mesh.
  const gx = 60, gy = 80, gw = W - 120, gh = H * 0.36;
  const glass = ctx.createLinearGradient(0, gy, 0, gy + gh);
  glass.addColorStop(0, "#6d757a");
  glass.addColorStop(0.55, "#4a5257");
  glass.addColorStop(1, "#343b40");
  ctx.fillStyle = glass;
  ctx.fillRect(gx, gy, gw, gh);
  ctx.strokeStyle = "rgba(190,205,200,0.13)";
  ctx.lineWidth = 1;
  for (let x = gx; x < gx + gw; x += 13) {
    ctx.beginPath(); ctx.moveTo(x, gy); ctx.lineTo(x, gy + gh); ctx.stroke();
  }
  for (let y = gy; y < gy + gh; y += 13) {
    ctx.beginPath(); ctx.moveTo(gx, y); ctx.lineTo(gx + gw, y); ctx.stroke();
  }
  // grime running down the inside of the glass
  ctx.fillStyle = "rgba(20,26,22,0.3)";
  for (let s = 0; s < 9; s++) {
    const sx = gx + rng() * gw;
    ctx.fillRect(sx, gy, randRange(rng, 3, 14), randRange(rng, 20, gh));
  }
  // glazing bead
  ctx.strokeStyle = "rgba(10,16,12,0.75)";
  ctx.lineWidth = 7;
  ctx.strokeRect(gx, gy, gw, gh);

  // Kick plate, dented by thirty years of shopping trolleys.
  ctx.fillStyle = "rgba(126,130,120,0.5)";
  ctx.fillRect(24, H - 130, W - 48, 110);

  // Paint chips down to primer.
  ctx.fillStyle = "rgba(112,92,60,0.5)";
  for (let s = 0; s < 40; s++) {
    const sx = rng() * W, sy = randRange(rng, H * 0.5, H);
    ctx.beginPath();
    ctx.ellipse(sx, sy, randRange(rng, 1, 7), randRange(rng, 1, 5), rng() * 3, 0, 7);
    ctx.fill();
  }
  // Scratches.
  ctx.strokeStyle = "rgba(18,26,20,0.5)";
  for (let s = 0; s < 22; s++) {
    ctx.lineWidth = randRange(rng, 0.5, 2);
    ctx.beginPath();
    const sx = rng() * W, sy = rng() * H;
    ctx.moveTo(sx, sy);
    ctx.lineTo(sx + randRange(rng, -90, 90), sy + randRange(rng, -30, 30));
    ctx.stroke();
  }
  // Grime around the handle area.
  const grad = ctx.createRadialGradient(W - 90, H * 0.56, 6, W - 90, H * 0.56, 90);
  grad.addColorStop(0, "rgba(12,18,12,0.55)");
  grad.addColorStop(1, "rgba(12,18,12,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(W - 190, H * 0.56 - 100, 200, 200);

  return tex(canvas, { srgb: true, repeat: false });
}

export function makeExitSignTexture(): THREE.CanvasTexture {
  const W = 256, H = 96;
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#0a1f0c";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#48ff6a";
  ctx.font = "bold 64px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EXIT", W / 2, H / 2 + 4);
  ctx.strokeStyle = "rgba(60,255,110,0.6)";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);
  return tex(canvas, { srgb: true, repeat: false });
}

/**
 * The OTHER exit signs — red, grimy, pointing at nothing. They lie.
 * `arrow` flips the chevron so different signs send you different ways.
 */
export function makeFalseExitSignTexture(
  seed: number,
  arrow: -1 | 1,
): THREE.CanvasTexture {
  const W = 256, H = 96;
  const rng = mulberry32(seed * 7 + 13);
  const { canvas, ctx } = makeCanvas(W, H);
  ctx.fillStyle = "#160505";
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = "#ff2a22";
  ctx.font = "bold 56px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("EXIT", W / 2 - arrow * 22, H / 2 + 4);

  // chevron arrow
  ctx.beginPath();
  const ax = arrow === 1 ? W - 46 : 46;
  ctx.moveTo(ax - arrow * 14, H / 2 - 20);
  ctx.lineTo(ax + arrow * 12, H / 2 + 2);
  ctx.lineTo(ax - arrow * 14, H / 2 + 24);
  ctx.lineWidth = 9;
  ctx.strokeStyle = "#ff2a22";
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,50,40,0.45)";
  ctx.lineWidth = 4;
  ctx.strokeRect(4, 4, W - 8, H - 8);

  // grime streaks + a dead patch in the lettering — these have been here a while
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 26; i++) {
    ctx.fillStyle = `rgba(0,0,0,${0.25 + rng() * 0.5})`;
    const x = rng() * W, y = rng() * H;
    ctx.fillRect(x, y, 2 + rng() * 14, 1 + rng() * 3);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "rgba(20,4,4,0.55)";
  ctx.fillRect(rng() * W * 0.7, 0, 14 + rng() * 30, H);

  return tex(canvas, { srgb: true, repeat: false });
}

/** Wrap-around label for an almond water bottle — the lore-famous pickup. */
export function makeWaterLabelTexture(seed: number): THREE.CanvasTexture {
  const W = 256, H = 128;
  const rng = mulberry32(seed * 11 + 5);
  const { canvas, ctx } = makeCanvas(W, H);

  // aged cream label — kept dim so the torch doesn't clip it to white
  ctx.fillStyle = "#a89878";
  ctx.fillRect(0, 0, W, H);
  for (let i = 0; i < 60; i++) {
    ctx.fillStyle = `rgba(120,100,60,${0.04 + rng() * 0.08})`;
    ctx.fillRect(rng() * W, rng() * H, 2 + rng() * 22, 1 + rng() * 4);
  }

  ctx.strokeStyle = "#5d4d2c";
  ctx.lineWidth = 3;
  ctx.strokeRect(7, 7, W - 14, H - 14);

  ctx.fillStyle = "#3c2f18";
  ctx.textAlign = "center";
  ctx.font = "bold 30px Georgia, serif";
  ctx.fillText("ALMOND", W / 2, 52);
  ctx.fillText("WATER", W / 2, 86);
  ctx.font = "italic 13px Georgia, serif";
  ctx.fillStyle = "#6b5733";
  ctx.fillText("· bottled where it is always 3 pm ·", W / 2, 110);

  return tex(canvas, { srgb: true, repeat: false });
}

/* --------------------------------------------- */
/*  ENTITY SKIN — wet, mottled, light-swallowing  */
/* --------------------------------------------- */

export function makeEntityMaps(seed: number): PBRMaps {
  const S = 256;
  const n = new ValueNoise(seed + 51);
  const { canvas, ctx } = makeCanvas(S, S);
  const img = ctx.createImageData(S, S);
  const height = new Float32Array(S * S);
  const rough = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      const veins = n.fbm(x * 0.06, y * 0.06, 5);
      const fine = n.noise(x * 0.6, y * 0.6);
      const v = 12 + veins * 26 + fine * 8;
      img.data[i * 4] = v * 1.06;
      img.data[i * 4 + 1] = v * 0.94;
      img.data[i * 4 + 2] = v * 0.9;
      img.data[i * 4 + 3] = 255;
      height[i] = veins * 0.8 + fine * 0.2;
      rough[i] = 0.42 + veins * 0.3; // wet sheen in the hollows
    }
  }
  ctx.putImageData(img, 0, 0);
  return {
    map: tex(canvas, { srgb: true }),
    normalMap: tex(normalFromHeight(height, S, S, 2.2)),
    roughnessMap: tex(grayCanvas(rough, S, S)),
  };
}

/* ---------------------------------------------------------- */
/*  WALL ART — things previous visitors drew. black + red ink  */
/* ---------------------------------------------------------- */

/**
 * One scrawled drawing on a transparent canvas: shaky hand, ink that
 * skips, red that sometimes runs. Motif picked from a small creepy set.
 */
export function makeWallArtTexture(seed: number): THREE.CanvasTexture {
  const S = 384;
  const rng = mulberry32(seed);
  const { canvas, ctx } = makeCanvas(S, S);

  const BLACK = "#16120c";
  const RED = "#6e1410";
  const ink = rng() < 0.42 ? RED : BLACK;
  const isRed = ink === RED;

  /** Shaky multi-pass stroke through the given points (unit space 0..1). */
  const stroke = (pts: [number, number][], w: number, alpha = 1, color = ink) => {
    for (let pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = color;
      ctx.lineWidth = w * (0.75 + rng() * 0.5);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalAlpha = alpha * (0.45 + rng() * 0.35);
      ctx.beginPath();
      pts.forEach(([px, py], i) => {
        const jx = px * S + (rng() - 0.5) * 3.5;
        const jy = py * S + (rng() - 0.5) * 3.5;
        if (i === 0) ctx.moveTo(jx, jy);
        else {
          // bow each segment a little — nobody draws straight lines scared
          const [qx, qy] = pts[i - 1];
          const mx = ((qx + px) / 2) * S + (rng() - 0.5) * 6;
          const my = ((qy + py) / 2) * S + (rng() - 0.5) * 6;
          ctx.quadraticCurveTo(mx, my, jx, jy);
        }
      });
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };

  const circle = (cx: number, cy: number, r: number, w: number, color = ink) => {
    const pts: [number, number][] = [];
    const turns = 1 + rng() * 0.15;
    for (let a = 0; a <= turns * Math.PI * 2 + 0.2; a += 0.5) {
      pts.push([cx + Math.cos(a) * r * (0.9 + rng() * 0.2), cy + Math.sin(a) * r * (0.9 + rng() * 0.2)]);
    }
    stroke(pts, w, 1, color);
  };

  /** Red ink runs — thin streaks dripping from a point. */
  const drip = (x: number, y: number, color = RED) => {
    const len = 0.06 + rng() * 0.16;
    const g = ctx.createLinearGradient(0, y * S, 0, (y + len) * S);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(110,20,16,0)");
    ctx.fillStyle = g;
    ctx.globalAlpha = 0.5 + rng() * 0.3;
    ctx.fillRect(x * S - 1.2, y * S, 2.4 * (0.6 + rng() * 0.8), len * S);
    ctx.globalAlpha = 1;
  };

  const stickFigure = (cx: number, cy: number, h: number, w: number, tall = false) => {
    const headR = h * (tall ? 0.07 : 0.12);
    const neckY = cy - h / 2 + headR * 2;
    circle(cx, cy - h / 2 + headR, headR, w);
    stroke([[cx, neckY], [cx, cy + h * 0.18]], w); // spine
    const armY = neckY + h * (tall ? 0.06 : 0.1);
    const span = h * (tall ? 0.34 : 0.22);
    const droop = tall ? h * 0.3 : h * 0.06;
    stroke([[cx - span, armY + droop], [cx, armY], [cx + span, armY + droop]], w);
    stroke([[cx, cy + h * 0.18], [cx - h * 0.14, cy + h / 2]], w);
    stroke([[cx, cy + h * 0.18], [cx + h * 0.14, cy + h / 2]], w);
  };

  const motif = Math.floor(rng() * 7);
  switch (motif) {
    case 0: {
      // family portrait — small ones, and the long one standing behind
      const n = 2 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        stickFigure(0.2 + (0.6 / Math.max(1, n - 1)) * i, 0.62, 0.3 + rng() * 0.08, 3.2);
      }
      stickFigure(0.3 + rng() * 0.4, 0.42, 0.66, 3.0, true);
      if (rng() < 0.6) circle(0.5, 0.5, 0.42, 4.5, RED); // someone circled it
      break;
    }
    case 1: {
      // the big eye, lashes like cracks
      circle(0.5, 0.5, 0.26, 4.5);
      circle(0.5, 0.5, 0.09, 4);
      ctx.fillStyle = ink;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(0.5 * S, 0.5 * S, 0.045 * S, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let i = 0; i < 11; i++) {
        const a = rng() * Math.PI * 2;
        stroke(
          [
            [0.5 + Math.cos(a) * 0.28, 0.5 + Math.sin(a) * 0.28],
            [0.5 + Math.cos(a) * (0.36 + rng() * 0.1), 0.5 + Math.sin(a) * (0.36 + rng() * 0.1)],
          ],
          2.6,
        );
      }
      break;
    }
    case 2: {
      // spiral, drawn until the hand gave up
      const pts: [number, number][] = [];
      const turns = 3.5 + rng() * 2;
      for (let a = 0; a < turns * Math.PI * 2; a += 0.4) {
        const r = 0.04 + (a / (turns * Math.PI * 2)) * 0.38;
        pts.push([0.5 + Math.cos(a) * r, 0.5 + Math.sin(a) * r * 0.92]);
      }
      stroke(pts, 3.6);
      break;
    }
    case 3: {
      // a door — crossed out
      stroke([[0.3, 0.78], [0.3, 0.2], [0.68, 0.2], [0.68, 0.78]], 4);
      stroke([[0.62, 0.5], [0.65, 0.5]], 4.5); // knob
      stroke([[0.22, 0.16], [0.76, 0.82]], 5, 1, RED);
      stroke([[0.76, 0.18], [0.22, 0.8]], 5, 1, RED);
      if (rng() < 0.7) drip(0.4 + rng() * 0.2, 0.5 + rng() * 0.2);
      break;
    }
    case 4: {
      // tally marks — counting something. days? encounters?
      let y = 0.24 + rng() * 0.1;
      for (let row = 0; row < 3; row++) {
        let x = 0.16 + rng() * 0.08;
        const groups = 2 + Math.floor(rng() * 2);
        for (let gI = 0; gI < groups; gI++) {
          for (let t = 0; t < 4; t++) {
            stroke([[x + t * 0.035, y], [x + t * 0.035 + 0.012, y + 0.13]], 3);
          }
          stroke([[x - 0.015, y + 0.1], [x + 0.13, y + 0.03]], 3);
          x += 0.2;
        }
        y += 0.22;
      }
      break;
    }
    case 5: {
      // handprint — someone touched the wall with a wet red hand
      const cx = 0.5, cy = 0.55;
      ctx.fillStyle = RED;
      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.ellipse(cx * S, cy * S, 0.11 * S, 0.13 * S, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      for (let f = 0; f < 5; f++) {
        const a = -Math.PI / 2 + (f - 2) * 0.32 + (rng() - 0.5) * 0.08;
        const lx = cx + Math.cos(a) * 0.13, ly = cy + Math.sin(a) * 0.15;
        const ex = cx + Math.cos(a) * (0.24 + rng() * 0.04);
        const ey = cy + Math.sin(a) * (0.26 + rng() * 0.04);
        stroke([[lx, ly], [ex, ey]], 9 - Math.abs(f - 2) * 1.4, 0.75, RED);
      }
      drip(cx - 0.06 + rng() * 0.12, cy + 0.1);
      drip(cx - 0.06 + rng() * 0.12, cy + 0.12);
      break;
    }
    default: {
      // arrows that disagree about the way out
      const n = 2 + Math.floor(rng() * 3);
      for (let i = 0; i < n; i++) {
        const y = 0.2 + (0.6 / n) * i + rng() * 0.08;
        const dir = rng() < 0.5 ? 1 : -1;
        const x0 = 0.5 - dir * 0.3, x1 = 0.5 + dir * 0.3;
        stroke([[x0, y], [x1, y]], 4);
        stroke([[x1 - dir * 0.09, y - 0.06], [x1, y], [x1 - dir * 0.09, y + 0.06]], 4);
      }
      if (rng() < 0.5) circle(0.5, 0.5, 0.4, 3, RED);
      break;
    }
  }

  // red ink runs even when the drawing was black — the wall sweats
  if (isRed || rng() < 0.3) {
    for (let i = 0; i < 1 + Math.floor(rng() * 3); i++) {
      drip(0.25 + rng() * 0.5, 0.3 + rng() * 0.35);
    }
  }

  // age it: eat random specks out so the ink looks worn into the wallpaper
  ctx.globalCompositeOperation = "destination-out";
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.12 + rng() * 0.3;
    const x = rng() * S, y = rng() * S;
    ctx.fillRect(x, y, 1 + rng() * 2.5, 1 + rng() * 2);
  }
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;

  const t = tex(canvas, { srgb: true, repeat: false });
  return t;
}
