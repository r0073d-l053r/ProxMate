// Absolute origin + shared copy for SEO metadata (OG/canonical/manifest).
//
// The origin must be the EXTERNALLY reachable one, because link-preview bots
// fetch the OG image over the public internet — an internal/localhost address
// yields a broken unfurl (the image URL can't be reached). We resolve it, in
// order: an explicit operator override, then the actual request origin, then a
// last-ditch default.

const DEFAULT_ORIGIN = "https://proxmate.myhomelab.pro";

/**
 * An explicit, externally-reachable origin set by the operator via
 * NEXT_PUBLIC_SITE_URL. The Docker images bake `NEXT_PUBLIC_SITE_URL=
 * http://localhost:3000` as a dev default, so a localhost value is treated as
 * "unset" — otherwise every unfurl bot would be handed a localhost og:image URL
 * it can't fetch (this was the "no image on shared links" bug). Trailing slash
 * stripped to avoid `//og` artifacts.
 */
function explicitSiteUrl(): string | null {
  const raw = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/+$/, "");
  if (!raw) return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(raw)) return null;
  return raw;
}

/** Build-time best guess (explicit override, else default). Kept for any
 *  non-request context; request-aware code should prefer `resolveSiteOrigin`. */
export const siteUrl = explicitSiteUrl() ?? DEFAULT_ORIGIN;

/**
 * Resolve the absolute origin for OG/canonical URLs. Prefers an explicit
 * NEXT_PUBLIC_SITE_URL, then the **actual request origin** (so link previews
 * work on any self-hosted instance with zero config, behind a tunnel/proxy),
 * then the default. Server-only (reads request headers) — call from
 * `generateMetadata`.
 */
export async function resolveSiteOrigin(): Promise<string> {
  const explicit = explicitSiteUrl();
  if (explicit) return explicit;
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const host = h.get("x-forwarded-host") ?? h.get("host");
    if (host) {
      const proto = (h.get("x-forwarded-proto") ?? "https").split(",")[0]!.trim();
      return `${proto}://${host}`;
    }
  } catch {
    // headers() unavailable (static/build context) — fall through to default.
  }
  return DEFAULT_ORIGIN;
}

export const siteConfig = {
  name: "ProxMate",
  // Punchy line for OG/Twitter cards (renders fully in small thumbnails).
  shortDescription: "Invite-only cloud dashboard for Proxmox VE.",
  // ~125 chars — survives intact in search/preview snippets.
  description:
    "Self-hosted, invite-only cloud dashboard for Proxmox VE. Spin up VMs and share your homelab — without handing over the keys.",
  tagline: "Share your homelab. Keep your boundaries.",
} as const;
