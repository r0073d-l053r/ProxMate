"use client";

import { useSyncExternalStore } from "react";

// Desktop = at least Tailwind's `md` breakpoint (768px), the same line where the
// app switches from the mobile hamburger drawer to the persistent sidebar. Used
// to keep desktop-only features (the ProxMate IDE popout) out of mobile mode.
const DESKTOP_QUERY = "(min-width: 768px)";

function subscribe(callback: () => void): () => void {
  const mql = window.matchMedia(DESKTOP_QUERY);
  mql.addEventListener("change", callback);
  return () => mql.removeEventListener("change", callback);
}

/**
 * True when the viewport is desktop-width. SSR-safe via useSyncExternalStore:
 * the server snapshot is `false` (so desktop-only UI never renders during SSR),
 * and it tracks live viewport changes (resize / orientation) on the client.
 */
export function useIsDesktop(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => false,
  );
}
