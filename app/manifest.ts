import type { MetadataRoute } from "next";

// Required for `output: "export"` (CrazyGames bundle); no-op otherwise.
export const dynamic = "force-static";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "BACKROOMS — LEVEL 0",
    short_name: "BACKROOMS",
    description:
      "A procedural first-person horror experience. Find the pages. Find the door. Don't let it find you.",
    start_url: "/",
    // Installed-to-home-screen runs with zero browser chrome — the only
    // route to true fullscreen on iPhones, where the Fullscreen API is N/A.
    display: "fullscreen",
    orientation: "landscape",
    background_color: "#0a0905",
    theme_color: "#0a0905",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
