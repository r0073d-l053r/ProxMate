"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Loader2, RefreshCw, Keyboard, Circle, ClipboardPaste, Send, X } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { RFBOptions } from "@novnc/novnc";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConsoleTopBar, type ConsoleMode } from "./console-top-bar";

type RfbInstance = {
  scaleViewport: boolean;
  showDotCursor: boolean;
  background: string;
  disconnect(): void;
  sendCtrlAltDel(): void;
  clipboardPasteFrom(text: string): void;
  sendKey(keysym: number, code?: string | null, down?: boolean): void;
  focus(): void;
  addEventListener(type: string, cb: (e: Event) => void): void;
};

type ConnState = "connecting" | "connected" | "disconnected" | "error";

const XK_RETURN = 0xff0d;
const XK_TAB = 0xff09;
const XK_SHIFT_L = 0xffe1;

/**
 * Map a single character to an X11 keysym. Printable ASCII / Latin-1 keysyms
 * equal their Unicode code point; anything above gets the 0x01000000 + codepoint
 * Unicode keysym.
 */
function charKeysym(ch: string): number | null {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return null;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp;
  return 0x01000000 + cp;
}

/**
 * US-layout map from a character to its physical key (`KeyboardEvent.code`) and
 * whether Shift is held. noVNC turns the code into a scancode (QEMU extended key
 * events), so injecting the *physical key + Shift* types EXACTLY like a real
 * keyboard. Sending only the keysym (the old behavior) let the server drop the
 * shift — so "&"→"7", ":"→";", and every uppercase/shifted symbol came out wrong.
 */
const KEY_BY_CHAR: Record<string, { code: string; shift: boolean }> = (() => {
  const map: Record<string, { code: string; shift: boolean }> = {};
  for (let c = 0; c < 26; c++) {
    const lower = String.fromCharCode(97 + c);
    const code = `Key${lower.toUpperCase()}`;
    map[lower] = { code, shift: false };
    map[lower.toUpperCase()] = { code, shift: true };
  }
  const pairs: Array<[string, string, string]> = [
    ["1", "!", "Digit1"], ["2", "@", "Digit2"], ["3", "#", "Digit3"], ["4", "$", "Digit4"],
    ["5", "%", "Digit5"], ["6", "^", "Digit6"], ["7", "&", "Digit7"], ["8", "*", "Digit8"],
    ["9", "(", "Digit9"], ["0", ")", "Digit0"],
    ["`", "~", "Backquote"], ["-", "_", "Minus"], ["=", "+", "Equal"],
    ["[", "{", "BracketLeft"], ["]", "}", "BracketRight"], ["\\", "|", "Backslash"],
    [";", ":", "Semicolon"], ["'", '"', "Quote"],
    [",", "<", "Comma"], [".", ">", "Period"], ["/", "?", "Slash"],
  ];
  for (const [lo, hi, code] of pairs) {
    map[lo] = { code, shift: false };
    map[hi] = { code, shift: true };
  }
  map[" "] = { code: "Space", shift: false };
  return map;
})();

/**
 * Type a string into the VM as individual key taps (no guest clipboard needed),
 * holding Shift for shifted characters so symbols/uppercase arrive intact.
 */
function typeText(rfb: RfbInstance, text: string) {
  for (const ch of text.replace(/\r\n/g, "\n")) {
    if (ch === "\n") {
      rfb.sendKey(XK_RETURN, "Enter");
      continue;
    }
    if (ch === "\t") {
      rfb.sendKey(XK_TAB, "Tab");
      continue;
    }
    const ks = charKeysym(ch);
    if (ks == null) continue;
    const km = KEY_BY_CHAR[ch];
    if (km) {
      // Physical key + explicit Shift = identical to real typing (reliable on QEMU).
      if (km.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", true);
      rfb.sendKey(ks, km.code);
      if (km.shift) rfb.sendKey(XK_SHIFT_L, "ShiftLeft", false);
    } else {
      // Accented / non-US characters: no physical-key mapping — best-effort keysym.
      rfb.sendKey(ks);
    }
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

export function VncConsole({
  id,
  mode,
  onModeChange,
}: {
  id: string;
  mode: ConsoleMode;
  onModeChange: (mode: ConsoleMode) => void;
}) {
  const areaRef = useRef<HTMLDivElement>(null); // available space; centers the box
  const boxRef = useRef<HTMLDivElement>(null); // console box, sized to the fit-box
  const screenRef = useRef<HTMLDivElement>(null); // noVNC mounts its canvas here
  const rfbRef = useRef<RfbInstance | null>(null);
  const fbRef = useRef<{ w: number; h: number } | null>(null); // framebuffer pixel size

  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");

  /**
   * Size the console box to the largest rectangle of the framebuffer's aspect
   * ratio that fits the available area, so the black box hugs the actual screen
   * content — no letterbox bars above/below. noVNC (1.7) watches its mount
   * element with a ResizeObserver and rescales the canvas to fill the box.
   */
  const fit = useCallback(() => {
    const area = areaRef.current;
    const box = boxRef.current;
    if (!area || !box) return;
    const aw = area.clientWidth;
    const ah = area.clientHeight;
    if (!aw || !ah) return;
    const fb = fbRef.current;
    const ar = fb ? fb.w / fb.h : 4 / 3; // sensible default until we know the resolution
    let w = aw;
    let h = Math.round(aw / ar);
    if (h > ah) {
      h = ah;
      w = Math.round(ah * ar);
    }
    box.style.width = `${w}px`;
    box.style.height = `${h}px`;
  }, []);

  /** Read the framebuffer resolution off noVNC's canvas (retrying until ready). */
  const captureFramebuffer = useCallback(() => {
    let tries = 0;
    const read = () => {
      const canvas = screenRef.current?.querySelector("canvas");
      if (canvas && canvas.width && canvas.height) {
        fbRef.current = { w: canvas.width, h: canvas.height };
        fit();
      } else if (tries++ < 20) {
        setTimeout(read, 100);
      }
    };
    read();
  }, [fit]);

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
      rfb.scaleViewport = true; // scale the framebuffer to fill the (fit-sized) box
      rfb.showDotCursor = true; // show a dot when the guest sends no cursor (text consoles)
      rfb.background = "#000";

      rfb.addEventListener("connect", () => {
        setState("connected");
        captureFramebuffer();
      });
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
  }, [id, captureFramebuffer]);

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

  // Refit when the available area changes (window resize, sidebar toggle, etc.).
  useEffect(() => {
    const area = areaRef.current;
    if (!area) return;
    const ro = new ResizeObserver(() => fit());
    ro.observe(area);
    fit();
    return () => ro.disconnect();
  }, [fit]);

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
      <ConsoleTopBar id={id} mode={mode} onModeChange={onModeChange}>
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
      </ConsoleTopBar>

      {/* Available area — centers a console box sized to the framebuffer aspect. */}
      <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center">
        <div
          ref={boxRef}
          className="relative overflow-hidden rounded-xl bg-black ring-1 ring-foreground/10"
        >
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
    </div>
  );
}
