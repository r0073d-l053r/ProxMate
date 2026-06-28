import type { NextConfig } from "next";

// Baseline security headers for EVERY response (including the static assets that
// proxy.ts skips). The per-request nonce Content-Security-Policy is set in
// proxy.ts (it needs a fresh nonce per request); these are the static headers.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" }, // legacy clickjacking guard (older browsers); CSP frame-ancestors covers modern ones
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  // Ignored over plain HTTP (dev/LAN); enforced once served over HTTPS (prod).
  { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  // Produce a self-contained .next/standalone build for a small production image.
  output: "standalone",
  // This `frontend/` directory is the Next app root. Pin it so Turbopack doesn't
  // infer the wrong workspace root from the stray repo-root package-lock.json
  // (which triggers the "multiple lockfiles" warning).
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
