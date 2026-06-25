"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, RefreshCw, Keyboard, Circle, ClipboardPaste, Send, X } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { RFBOptions } from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type RfbInstance = {
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  sendCtrlAltDel(): void;
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code?: string | null, down?: boolean): void;
  focus(): void;
  addEventListener(type: string, cb: (e: Event) => void): void;
};

type ConnState = "connecting" | "connected" | "disconnected" | "error";

/**
 * Map a single character to an X11 keysym so we can inject text as keystrokes.
 * Printable ASCII and Latin-1 keysyms equal their Unicode code point; anything
 * above gets the 0x01000000 + codepoint Unicode keysym. Newlines become Return.
 */
function charKeysym(ch: string): number | null {
  if (ch === "\n" || ch === "\r") return 0xff0d; // Return
  if (ch === "\t") return 0xff09; // Tab
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

/** Type a string into the VM as individual key taps (no guest clipboard needed). */
function typeText(rfb: RfbInstance, text: string) {
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const ks = charKeysym(ch);
    if (ks != null) rfb.sendKey(ks);
  }
}

/**
 * Resolve the WebSocket base from the API URL against the page's current origin,
 * so the console works wherever ProxMate is accessed from — including behind a
 * reverse proxy, Tailscale, or a Cloudflare Tunnel (not just localhost).
 * A relative API URL (e.g. "/api") becomes same-origin wss automatically.
 */
function wsBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "/api";
  const u = new URL(raw, window.location.origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/+$/, "");
}

export default function ConsolePage() {
  const { id } = useParams<{ id: string }>();
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RfbInstance | null>(null);

  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

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

      // Auth rides on the httpOnly session cookie (sent on the WS handshake) —
      // no token in the URL.
      const params = new URLSearchParams({ vncticket: ticket, port });
      const wsUrl = `${wsBase()}/vms/${id}/console?${params.toString()}`;

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
      // Copy from the VM: when the guest copies, mirror it to the local clipboard.
      rfb.addEventListener("clipboard", (e: Event) => {
        const text = (e as CustomEvent<{ text: string }>).detail?.text;
        if (!text) return;
        navigator.clipboard?.writeText(text).then(
          () => toast.success("Copied from VM to your clipboard"),
          () => toast.message("VM clipboard updated", { description: "Allow clipboard access to copy it locally." }),
        );
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

  // Open the paste overlay, prefilling from the local clipboard when allowed.
  const openPaste = useCallback(async () => {
    setPasteOpen(true);
    try {
      const t = await navigator.clipboard.readText();
      if (t) setPasteText(t);
    } catch {
      // Clipboard read blocked (permissions/focus) — the user pastes manually.
    }
  }, []);

  function sendPaste() {
    const rfb = rfbRef.current;
    if (!rfb || !pasteText) {
      setPasteOpen(false);
      return;
    }
    // Set the VM clipboard buffer (for guests with clipboard tools) AND type the
    // text as keystrokes (works on a plain VM with no guest clipboard agent).
    rfb.clipboardPasteFrom(pasteText);
    typeText(rfb, pasteText);
    rfb.focus();
    toast.success("Sent to VM");
    setPasteOpen(false);
    setPasteText("");
  }

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
          <Button variant="outline" size="sm" disabled={state !== "connected"} onClick={openPaste}>
            <ClipboardPaste /> Paste
          </Button>
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
            <p className="max-w-sm text-sm text-white/70">{error ?? "The console session ended."}</p>
            <Button variant="outline" size="sm" onClick={connect}>
              <RefreshCw /> Reconnect
            </Button>
          </div>
        )}

        {pasteOpen && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-lg rounded-xl border bg-background p-4 shadow-xl">
              <div className="mb-2 flex items-center justify-between">
                <h2 className="text-sm font-semibold">Paste into the VM</h2>
                <Button size="icon-sm" variant="ghost" onClick={() => setPasteOpen(false)} title="Close">
                  <X />
                </Button>
              </div>
              <p className="mb-2 text-xs text-muted-foreground">
                ProxMate types this into the VM as keystrokes, so it works even without guest clipboard
                tools. Click into the VM where you want the text first.
              </p>
              <textarea
                autoFocus
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder="Paste or type the text to send…"
                className="h-40 w-full resize-none rounded-md border bg-background p-2 font-mono text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <div className="mt-3 flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setPasteOpen(false)}>
                  Cancel
                </Button>
                <Button size="sm" disabled={!pasteText} onClick={sendPaste}>
                  <Send /> Send to VM
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
