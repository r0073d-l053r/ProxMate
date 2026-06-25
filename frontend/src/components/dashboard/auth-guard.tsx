"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore, useHydrated } from "@/lib/auth-store";
import type { MeResponse } from "@/lib/types";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const mfaSetupRequired = useAuthStore((s) => s.mfaSetupRequired);
  const setMfaSetupRequired = useAuthStore((s) => s.setMfaSetupRequired);
  const [validated, setValidated] = useState(false);

  // The session lives in an httpOnly cookie, so we can't read it here — `/auth/me`
  // (cookie sent automatically) is the source of truth.
  useEffect(() => {
    if (!hydrated) return;
    let active = true;

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
          .catch(() => {
            // Interceptor clears the cached user on 401; bounce to login.
            if (active) router.replace("/login");
          });
      })
      .catch(() => {
        if (active) router.replace("/login");
      });

    return () => {
      active = false;
    };
  }, [hydrated, router, setUser, setMfaSetupRequired]);

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

  if (!hydrated || !validated || !user) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading ProxMate…
      </div>
    );
  }

  return <>{children}</>;
}
