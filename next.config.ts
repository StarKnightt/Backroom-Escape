import type { NextConfig } from "next";

// CG_EXPORT=1 produces the CrazyGames build: a fully static, self-contained
// bundle with relative asset paths so it runs from their CDN subfolder.
// The normal (Vercel) build is untouched.
const cgExport = process.env.CG_EXPORT === "1";

const nextConfig: NextConfig = {
  // Inlined into the client bundle — lets UI strip portal-forbidden content
  // (external links / cross-promotion) from the CrazyGames build.
  env: { NEXT_PUBLIC_CG_EXPORT: cgExport ? "1" : "" },
  ...(cgExport && {
    output: "export" as const,
    assetPrefix: "./",
    images: { unoptimized: true },
  }),
};

export default nextConfig;
