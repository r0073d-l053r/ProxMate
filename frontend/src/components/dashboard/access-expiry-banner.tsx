"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { api } from "@/lib/api";
import type { MeResponse } from "@/lib/types";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Start nagging this many days out — matches the 7-day warning email. */
const WARN_WITHIN_DAYS = 7;

/**
 * Countdown shown to a tenant whose compute access is about to end, so the
 * cutoff is never a surprise. Renders nothing for admins (they never expire),
 * for accounts with no window, or while the deadline is still far away.
 *
 * The date is used only for the wording — whether access has actually LAPSED is
 * the server's call (`accessExpired`), never arithmetic on the client's clock.
 */
export function AccessExpiryBanner() {
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<MeResponse>("/auth/me")
      .then((r) => {
        if (!active) return;
        setExpiresAt(r.data.user.accessExpiresAt ?? null);
        setExpired(!!r.data.user.accessExpired);
        setIsAdmin(r.data.user.role === "admin");
      })
      .catch(() => {
        /* the guard already handles auth failures — stay silent */
      });
    return () => {
      active = false;
    };
  }, []);

  if (isAdmin || !expiresAt) return null;

  // Already lapsed: say so plainly instead of counting down to a past date.
  // `expired` is the server's verdict — never recomputed from the client clock.
  if (expired) {
    return (
      <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
        <CalendarClock className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div>
          <p className="font-medium">Your compute access has ended.</p>
          <p className="mt-0.5 text-muted-foreground">
            It ended on {formatDate(expiresAt)}, so your machines have been powered off. Nothing has
            been deleted — ask your administrator to restore your access.
          </p>
        </div>
      </div>
    );
  }

  const msLeft = new Date(expiresAt).getTime() - Date.now();
  const daysLeft = Math.ceil(msLeft / 86_400_000);
  if (daysLeft > WARN_WITHIN_DAYS) return null;

  const urgent = daysLeft <= 1;
  const when =
    daysLeft <= 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;

  return (
    <div
      className={cn(
        "mb-4 flex items-start gap-3 rounded-lg border p-3 text-sm",
        urgent
          ? "border-destructive/40 bg-destructive/10"
          : "border-amber-500/40 bg-amber-500/10",
      )}
    >
      <CalendarClock className={cn("mt-0.5 size-4 shrink-0", urgent ? "text-destructive" : "text-amber-500")} />
      <div>
        <p className="font-medium">Your compute access ends {when}.</p>
        <p className="mt-0.5 text-muted-foreground">
          On {formatDate(expiresAt)} your machines will be powered off and you won&apos;t be able to sign
          in. Nothing is deleted — ask your administrator to extend your access.
        </p>
      </div>
    </div>
  );
}
