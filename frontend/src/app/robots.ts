import type { MetadataRoute } from "next";

// ProxMate is a private, invite-only control plane: nothing here should be
// indexed. `Disallow: /` is the crawler-facing half of the posture; the
// `<meta name="robots" content="noindex,nofollow">` in layout.tsx is the other.
// No `sitemap:` line — a private app intentionally publishes none.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      disallow: "/",
    },
  };
}
