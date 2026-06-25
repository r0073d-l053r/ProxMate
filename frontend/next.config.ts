import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Produce a self-contained .next/standalone build for a small production image.
  output: "standalone",
  // This `frontend/` directory is the Next app root. Pin it so Turbopack doesn't
  // infer the wrong workspace root from the stray repo-root package-lock.json
  // (which triggers the "multiple lockfiles" warning).
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
