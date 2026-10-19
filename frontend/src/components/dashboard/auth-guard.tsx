"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { authFailure } from "@/lib/auth-failure";
import { useAuthStore, useHydrated } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import type { MeResponse } from "@/lib/types";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const clear = useAuthStore((s) => s.clear);
  const mfaSetupRequired = useAuthStore((s) => s.mfaSetupRequired);
  const setMfaSetupRequired = useAuthStore((s) => s.setMfaSetupRequired);
  const [validated, setValidated] = useState(false);
  // The API couldn't be reached (or errored) — show a retry state, not /login.
  const [unavailable, setUnavailable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The session lives in an httpOnly cookie, so we can't read it here — `/auth/me`
  // (cookie sent automatically) is the source of truth.
  useEffect(() => {
    if (!hydrated) return;
    let active = true;

    // Only a definite "signed out" answer goes to /login. Anything else (backend
    // down, proxy 502) keeps the user here with a retry: /login sends a cached user
    // straight back, so redirecting would just bounce between the two pages.
    const fail = (err: unknown) => {
      if (!active) return;
      if (authFailure(err) === "signed-out") {
        // A 401 is already cleared by the interceptor; a deleted account (404) isn't.
        clear();
        router.replace("/login");
      } else {
        setUnavailable(true);
      }
    };

    api
      .get<{ setupComplete: boolean }>("/setup/status")
      .then((setupRes) => {
        if (!active) return;
        if (!setupRes.data.setupComplete) {
          router.replace("/setup");
          return;
        }
        api
          .get<MeResponse>("/auth/me")
          .then((res) => {
            if (!active) return;
            const u = res.data.user;
            setUser({ id: u.id, email: u.email, role: u.role, displayName: u.displayName });
            setMfaSetupRequired(!!u.mfaSetupRequired);
            setValidated(true);
          })
          .catch(fail);
      })
      .catch(fail);

    return () => {
      active = false;
    };
  }, [hydrated, router, setUser, setMfaSetupRequired, clear, attempt]);

  // If a mid-session 401 clears the user (interceptor), bounce to login.
  useEffect(() => {
    if (hydrated && validated && !user) router.replace("/login");
  }, [hydrated, validated, user, router]);

  // Admin-required 2FA not yet set up → corral the user to /security on every
  // navigation until they enrol a method (the backend also blocks resource APIs).
  useEffect(() => {
    if (hydrated && validated && mfaSetupRequired && !pathname.startsWith("/security")) {
      router.replace("/security");
    }
  }, [hydrated, validated, mfaSetupRequired, pathname, router]);

  if (unavailable && !validated) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>Cannot reach the ProxMate API. Is the backend running?</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setUnavailable(false);
            setAttempt((n) => n + 1);
          }}
        >
          <RefreshCw /> Retry
        </Button>
      </div>
    );
  }

  if (!hydrated || !validated || !user) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading ProxMate…
      </div>
    );
  }

  return <>{children}</>;
}
