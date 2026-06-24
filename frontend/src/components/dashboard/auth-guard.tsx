"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore, useHydrated } from "@/lib/auth-store";
import type { MeResponse } from "@/lib/types";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const token = useAuthStore((s) => s.token);
  const setUser = useAuthStore((s) => s.setUser);
  const [validated, setValidated] = useState(false);

  useEffect(() => {
    if (!hydrated) return;
    if (!token) {
      router.replace("/login");
      return;
    }
    let active = true;

    // Check setup status first
    api
      .get<{ setupComplete: boolean }>("/setup/status")
      .then((setupRes) => {
        if (!active) return;
        if (!setupRes.data.setupComplete) {
          router.replace("/setup");
          return;
        }

        // Setup is complete, validate session
        api
          .get<MeResponse>("/auth/me")
          .then((res) => {
            if (!active) return;
            const u = res.data.user;
            setUser({ id: u.id, email: u.email, role: u.role, displayName: u.displayName });
            setValidated(true);
          })
          .catch(() => {
            // Interceptor clears the token on 401; bounce to login.
            if (active) router.replace("/login");
          });
      })
      .catch(() => {
        if (active) router.replace("/login");
      });

    return () => {
      active = false;
    };
  }, [hydrated, token, router, setUser]);

  // `!token` also gates here so that the instant sign-out clears the token, the
  // dashboard subtree stops rendering (no null-user flash) while we redirect.
  if (!hydrated || !validated || !token) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading ProxMate…
      </div>
    );
  }

  return <>{children}</>;
}
