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

export const metadata: Metadata = {
  // Absolute base so og:image/twitter:image resolve for social scrapers.
  metadataBase: new URL("https://backroom-escape.vercel.app"),
  title: "BACKROOMS — LEVEL 0",
  description:
    "A procedural first-person horror experience. Find the pages. Find the door. Don't let it find you.",
  openGraph: {
    title: "BACKROOMS — LEVEL 0",
    description:
      "A procedural first-person horror experience in your browser. Find the pages. Find the door. Don't let it find you.",
    url: "/",
    siteName: "BACKROOMS — LEVEL 0",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "BACKROOMS — LEVEL 0",
    description:
      "A procedural first-person horror experience in your browser. Don't let it find you.",
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${specialElite.variable} h-full antialiased`}>
      <body className="h-full overflow-hidden bg-black text-zinc-200">
        {children}
        {/* Vercel-only — the CrazyGames bundle would just spam 404s */}
        {process.env.CG_EXPORT !== "1" && <Analytics />}
      </body>
    </html>
  );
}
