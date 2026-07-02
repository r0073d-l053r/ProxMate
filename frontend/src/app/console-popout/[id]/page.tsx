"use client";

import { useEffect } from "react";
import { useParams } from "next/navigation";
import { api } from "@/lib/api";
import { SerialConsole } from "@/app/(dashboard)/vms/[id]/console/_components/serial-console";

/**
 * Chromeless pop-out text console — opened via `window.open` from the VM page
 * or the console page, so a terminal can sit beside (or, with "Keep on top",
 * float above) whatever else you're working on. No sidebar, no tabs: just the
 * terminal, reusing the same authenticated session cookie as the opener.
 */
export default function ConsolePopoutPage() {
  const { id } = useParams<{ id: string }>();

  // Name the window after the VM (best-effort — the console works regardless).
  useEffect(() => {
    let cancelled = false;
    api
      .get<{ name?: string }>(`/vms/${id}`)
      .then((res) => {
        if (!cancelled && res.data?.name) document.title = `${res.data.name} · ProxMate console`;
      })
      .catch(() => {
        document.title = "ProxMate console";
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return <SerialConsole id={id} popout />;
}
