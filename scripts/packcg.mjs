/**
 * Builds the CrazyGames HTML5 bundle: static-exports the game with relative
 * asset paths (CG_EXPORT=1), rewrites the few remaining root-absolute URLs so
 * the bundle works from any CDN subfolder, and zips it ready for upload.
 *
 *   node scripts/packcg.mjs   ->  backrooms-crazygames.zip
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

console.log("[packcg] building static export…");
execSync("pnpm build", { stdio: "inherit", env: { ...process.env, CG_EXPORT: "1" } });

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

// Scripts/CSS/fonts already come out relative thanks to assetPrefix "./", but
// metadata links (favicon, manifest, icons) are still root-absolute — both as
// href attributes and inside the RSC flight payload that Next replays on
// hydration (which re-inserts <link> tags, so the payload must be fixed too).
// Relative "./x" resolves against the page URL, i.e. the CDN subfolder.
const ASSETS = [
  "favicon.ico",
  "icon.png",
  "apple-icon.png",
  "icon-192.png",
  "icon-512.png",
  "manifest.webmanifest",
];
let fixed = 0;
for (const file of walk("out")) {
  if (!/\.(html|txt|webmanifest)$/.test(file)) continue;
  const before = readFileSync(file, "utf8");
  let after = before.replace(/(href|src)="\/(?!\/)/g, '$1="./');
  for (const a of ASSETS) {
    // Covers plain ("/x) and JS-string-escaped (\"/x) forms in flight data.
    after = after.replaceAll(`"/${a}`, `"./${a}`).replaceAll(`\\"/${a}`, `\\"./${a}`);
  }
  if (after !== before) {
    writeFileSync(file, after);
    fixed++;
  }
}
console.log(`[packcg] rewrote root-absolute URLs in ${fixed} file(s)`);

const zip = "backrooms-crazygames.zip";
rmSync(zip, { force: true });
execSync(
  `powershell -NoProfile -Command "Compress-Archive -Path out/* -DestinationPath ${zip} -Force"`,
  { stdio: "inherit" },
);
const mb = (statSync(zip).size / 1024 / 1024).toFixed(2);
console.log(`[packcg] done -> ${zip} (${mb} MB)`);
