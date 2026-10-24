"use client";

import { useCallback, useState } from "react";

type Run = "idle" | "started" | "seen";

/**
 * The VM page's local "installing the IDE" flag, which covers the moments before
 * the server records the install. It is set when "Open IDE" starts an install and
 * cleared by the caller when that flow ends, or as soon as the polled VM has shown
 * the install running and then finished (`ready` or `failed`), whichever is first —
 * so the banner follows the server even while the flow's own wait is still out.
 */
export function useIdeInstallFlag(serverState: string | null | undefined): [boolean, (on: boolean) => void] {
  const [run, setRun] = useState<Run>("idle");
  // Adjusted while rendering from the polled state (React's "derive from props" pattern).
  if (run === "started" && serverState === "installing") setRun("seen");
  if (run === "seen" && (serverState === "ready" || serverState === "failed")) setRun("idle");
  const set = useCallback((on: boolean) => setRun(on ? "started" : "idle"), []);
  return [run !== "idle", set];
}
