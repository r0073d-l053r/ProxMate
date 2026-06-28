import type { MetadataRoute } from "next";
import { siteConfig } from "@/lib/site";

// Web App Manifest — makes ProxMate installable ("Add to Home Screen" /
// install as a desktop app) with proper branding. Icons live in /public so
// they resolve at stable, literal paths. Colors match the dark-slate app chrome.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: siteConfig.name,
    short_name: siteConfig.name,
    description: siteConfig.shortDescription,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0d1013",
    theme_color: "#0d1013",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
