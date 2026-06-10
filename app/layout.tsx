import type { Metadata, Viewport } from "next";
import { Special_Elite } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";

const specialElite = Special_Elite({
  variable: "--font-elite",
  weight: "400",
  subsets: ["latin"],
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
        <Analytics />
      </body>
    </html>
  );
}
