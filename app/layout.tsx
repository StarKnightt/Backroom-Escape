import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

// Special Elite (Apache 2.0), self-hosted: builds kept failing on flaky
// fetches to fonts.gstatic.com, and bundling kills that dependency for
// Vercel too.
const specialElite = localFont({
  src: "./fonts/SpecialElite.woff2",
  variable: "--font-elite",
  weight: "400",
  display: "swap",
  // Turbopack dev fails decompressing this woff2 when computing the
  // size-adjusted fallback ("get_font_fallbacks ... compression error").
  // Skip it and declare fallbacks by hand — it's a decorative font.
  adjustFontFallback: false,
  fallback: ["Courier New", "monospace"],
});

const SITE = "https://backroom-escape.vercel.app";

export const metadata: Metadata = {
  // Absolute base so og:image/twitter:image resolve for social scrapers.
  metadataBase: new URL(SITE),
  // Search-facing title (what people actually type: "backrooms game",
  // "browser horror game"). In-game branding stays BACKROOMS — LEVEL 0.
  title: "Backrooms: Level 0 — Free Browser Horror Game",
  description:
    "Play the Backrooms free in your browser. First-person horror in a procedurally generated maze — find the 8 pages, escape Level 0, don't let it hear you walk. No download.",
  applicationName: "Backrooms: Level 0",
  // No author URL in the CG build — keeps every external link out of the bundle.
  authors:
    process.env.CG_EXPORT === "1"
      ? [{ name: "StarKnightt" }]
      : [{ name: "StarKnightt", url: "https://github.com/StarKnightt" }],
  creator: "StarKnightt",
  keywords: [
    "backrooms game",
    "backrooms",
    "play backrooms online",
    "browser horror game",
    "free horror game",
    "level 0",
    "liminal space game",
    "no download horror game",
    "three.js game",
    "procedural horror",
  ],
  alternates: { canonical: "/" },
  robots: { index: true, follow: true },
  openGraph: {
    title: "Backrooms: Level 0 — Free Browser Horror Game",
    description:
      "You noclipped out of reality. Find the 8 pages, escape the maze, don't let it hear you walk. Every run is a maze that has never existed before.",
    url: "/",
    siteName: "Backrooms: Level 0",
    type: "website",
    locale: "en_US",
  },
  twitter: {
    card: "summary_large_image",
    site: "@prasenx",
    creator: "@prasenx",
    title: "Backrooms: Level 0 — Free Browser Horror Game",
    description:
      "You noclipped out of reality. Find the 8 pages, escape the maze, don't let it hear you walk.",
  },
};

export const viewport: Viewport = {
  themeColor: "#0a0905",
  colorScheme: "dark",
  // Game viewport: bleed under notches in fullscreen, no pinch/double-tap
  // zoom fighting the touch controls.
  viewportFit: "cover",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

// Structured data: lets Google show this as a game in rich results.
const jsonLd = {
  "@context": "https://schema.org",
  "@type": "VideoGame",
  name: "Backrooms: Level 0",
  url: SITE,
  image: `${SITE}/opengraph-image.png`,
  description:
    "Free first-person horror game in the browser. Explore a procedurally generated Backrooms maze, collect the 8 pages and escape — while something hunts you by sound.",
  genre: ["Horror", "Survival"],
  playMode: "SinglePlayer",
  gamePlatform: ["Web Browser"],
  applicationCategory: "Game",
  operatingSystem: "Any",
  inLanguage: "en",
  isAccessibleForFree: true,
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
    availability: "https://schema.org/InStock",
  },
  author: {
    "@type": "Person",
    name: "StarKnightt",
    url: "https://github.com/StarKnightt",
    sameAs: ["https://x.com/prasenx", "https://github.com/StarKnightt"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${specialElite.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-black text-zinc-200">
        {/* SEO structured data — Vercel-only; useless inside the CG iframe
            and it carries external profile URLs their QA could flag */}
        {process.env.CG_EXPORT !== "1" && (
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
            }}
          />
        )}
        {children}
        {/* Vercel-only — the CrazyGames bundle would just spam 404s */}
        {process.env.CG_EXPORT !== "1" && <Analytics />}
      </body>
    </html>
  );
}
