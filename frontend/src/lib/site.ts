// Absolute origin + shared copy for SEO metadata (OG/canonical/manifest).
//
// `siteUrl` must be the EXTERNALLY reachable origin (the Cloudflare Tunnel
// hostname), because link-preview bots fetch the OG image over the public
// internet — an internal container address (http://app:3000) yields broken
// unfurls. Override per-deployment with NEXT_PUBLIC_SITE_URL (the NEXT_PUBLIC_
// prefix makes it available at render time; it's only a public origin, so no
// secret is exposed). The trailing slash is stripped to avoid `//og` artifacts.
export const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "") ||
  "https://proxmate.myhomelab.pro";

export const siteConfig = {
  name: "ProxMate",
  // Punchy line for OG/Twitter cards (renders fully in small thumbnails).
  shortDescription: "Invite-only cloud dashboard for Proxmox VE.",
  // ~125 chars — survives intact in search/preview snippets.
  description:
    "Self-hosted, invite-only cloud dashboard for Proxmox VE. Spin up VMs and share your homelab — without handing over the keys.",
  tagline: "Share your homelab. Keep your boundaries.",
} as const;
