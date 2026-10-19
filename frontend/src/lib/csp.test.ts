import { describe, it, expect } from "vitest";
import { buildConnectSrc } from "./csp";

describe("buildConnectSrc", () => {
  it("uses the operator-pinned value verbatim", () => {
    expect(
      buildConnectSrc({ pinned: "'self' https://a.example", apiUrl: "http://localhost:4000/api", isDev: false }),
    ).toBe("'self' https://a.example");
  });

  it("allows a plain-HTTP API on another port (and its WebSocket) in production", () => {
    const src = buildConnectSrc({ pinned: "", apiUrl: "http://localhost:4000/api", isDev: false }).split(" ");
    expect(src).toContain("'self'");
    expect(src).toContain("http://localhost:4000");
    expect(src).toContain("ws://localhost:4000");
  });

  it("allows an HTTPS API origin and its wss counterpart", () => {
    const src = buildConnectSrc({ pinned: undefined, apiUrl: "https://api.example.com/api", isDev: false }).split(" ");
    expect(src).toContain("https://api.example.com");
    expect(src).toContain("wss://api.example.com");
  });

  it("keeps the generic default for a same-origin (relative) API URL", () => {
    expect(buildConnectSrc({ pinned: undefined, apiUrl: "/api", isDev: false })).toBe("'self' https: wss:");
  });

  it("stays permissive in development", () => {
    expect(buildConnectSrc({ pinned: undefined, apiUrl: "/api", isDev: true })).toBe("'self' https: http: wss: ws:");
  });

  it("ignores an unparseable API URL", () => {
    expect(buildConnectSrc({ pinned: "  ", apiUrl: "http://", isDev: false })).toBe("'self' https: wss:");
  });
});
