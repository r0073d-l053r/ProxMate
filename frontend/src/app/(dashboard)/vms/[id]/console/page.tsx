"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Loader2, RefreshCw, Keyboard, Circle } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { getToken } from "@/lib/auth-store";
import type { RFBOptions } from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RfbInstance = {
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  sendCtrlAltDel(): void;
  addEventListener(type: string, cb: (e: Event) => void): void;
};

type ConnState = "connecting" | "connected" | "disconnected" | "error";

const WS_BASE = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api").replace(
  /^http/i,
  "ws",
);

export default function ConsolePage() {
  const { id } = useParams<{ id: string }>();
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance | null>(null);

  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);

  const connect = useCallback(async () => {
    setState("connecting");
    setError(null);

    // Tear down any previous session.
    if (rfbRef.current) {
      rfbRef.current.disconnect();
      rfbRef.current = null;
    }

    try {
      const res = await api.post<{ ticket: string; port: string }>(`/vms/${id}/console`);
      const { ticket, port } = res.data;
      const token = getToken() ?? "";

      const params = new URLSearchParams({ token, vncticket: ticket, port });
      const wsUrl = `${WS_BASE}/vms/${id}/console?${params.toString()}`;

      const { default: RFB } = await import("@novnc/novnc");
      if (!screenRef.current) return;

      const options: RFBOptions = { credentials: { password: ticket } };
      const rfb = new RFB(screenRef.current, wsUrl, options) as unknown as RfbInstance;
      rfb.scaleViewport = true;
      rfb.background = "#000";

      rfb.addEventListener("connect", () => setState("connected"));
      rfb.addEventListener("disconnect", (e: Event) => {
        const detail = (e as CustomEvent<{ clean: boolean }>).detail;
        setState(detail?.clean ? "disconnected" : "error");
        if (!detail?.clean) setError("The console connection was lost.");
      });
      rfb.addEventListener("securityfailure", () => {
        setState("error");
        setError("VNC authentication failed. The ticket may have expired — try reconnecting.");
      });

      rfbRef.current = rfb;
    } catch (err) {
      setState("error");
      setError(apiError(err));
    }
  }, [id]);

  useEffect(() => {
    // Debounce the initial connect so React StrictMode's mount→unmount→mount
    // in dev doesn't burn a single-use VNC ticket on a torn-down attempt.
    const timer = setTimeout(connect, 60);
    return () => {
      clearTimeout(timer);
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
    };
  }, [connect]);

  return (
    <div className="mx-auto flex h-[calc(100vh-6.5rem)] max-w-6xl flex-col">
      <div className="mb-3 flex items-center justify-between gap-3">
        <Button variant="ghost" render={<Link href={`/vms/${id}`} />}>
          <ArrowLeft /> Back to VM
        </Button>

        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Circle
              className={cn(
                "size-2 fill-current",
                state === "connected" && "text-emerald-500",
                state === "connecting" && "text-amber-500",
                (state === "disconnected" || state === "error") && "text-muted-foreground",
              )}
            />
            {state === "connecting" && "Connecting…"}
            {state === "connected" && "Connected"}
            {state === "disconnected" && "Disconnected"}
            {state === "error" && "Error"}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={state !== "connected"}
            onClick={() => rfbRef.current?.sendCtrlAltDel()}
          >
            <Keyboard /> Ctrl+Alt+Del
          </Button>
          <Button variant="outline" size="sm" onClick={connect}>
            <RefreshCw /> Reconnect
          </Button>
        </div>
      </div>

      <div className="relative flex-1 overflow-hidden rounded-xl bg-black ring-1 ring-foreground/10">
        <div ref={screenRef} className="h-full w-full" />

        {state === "connecting" && (
          <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
            <Loader2 className="size-4 animate-spin" /> Opening console…
          </div>
        )}

        {(state === "error" || state === "disconnected") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <p className="max-w-sm text-sm text-white/70">
              {error ?? "The console session ended."}
            </p>
            <Button variant="outline" size="sm" onClick={connect}>
              <RefreshCw /> Reconnect
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
