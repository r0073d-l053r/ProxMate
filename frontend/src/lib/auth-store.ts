"use client";

import { useEffect, useState } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AuthUser } from "./types";

interface AuthState {
  // The session itself lives in an httpOnly cookie (not readable here); this is
  // only the cached user profile for instant UI. The cookie is the source of truth.
  user: AuthUser | null;
  // Admin required 2FA but the user hasn't set up a method yet — gate the app.
  // Session-derived (from /auth/me); deliberately NOT persisted.
  mfaSetupRequired: boolean;
  setUser: (user: AuthUser) => void;
  setMfaSetupRequired: (v: boolean) => void;
  clear: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      mfaSetupRequired: false,
      setUser: (user) => set({ user }),
      setMfaSetupRequired: (mfaSetupRequired) => set({ mfaSetupRequired }),
      clear: () => set({ user: null, mfaSetupRequired: false }),
    }),
    {
      name: "proxmate-auth",
      partialize: (state) => ({ user: state.user }),
    },
  ),
);

/**
 * Read the double-submit CSRF token from the JS-readable `proxmate_csrf` cookie,
 * to echo back in the `X-CSRF-Token` header on mutating requests.
 */
export function getCsrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)proxmate_csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

/**
 * Returns true once the persisted store has loaded from localStorage.
 * Starts false on the server and first client render to avoid hydration
 * mismatches, then flips true after mount.
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (useAuthStore.persist.hasHydrated()) setHydrated(true);
    const unsub = useAuthStore.persist.onFinishHydration(() => setHydrated(true));
    return unsub;
  }, []);
  return hydrated;
}
