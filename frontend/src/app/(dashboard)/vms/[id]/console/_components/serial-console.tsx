"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Circle, SquareTerminal, PictureInPicture2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ConsoleTopBar, type ConsoleMode } from "./console-top-bar";
import "@xterm/xterm/css/xterm.css";

type ConnState = "connecting" | "connected" | "disconnected" | "error" | "unsupported";

// Document Picture-in-Picture (Chrome/Edge 116+): the only browser surface that
// genuinely stays on top of other windows — perfect for a floating terminal.
interface DocumentPip {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
}
function getDocumentPip(): DocumentPip | null {
  const w = window as unknown as { documentPictureInPicture?: DocumentPip };
  return w.documentPictureInPicture ?? null;
}

/** Clone every stylesheet into the PiP window so the terminal renders identically. */
function copyStylesTo(pip: Window): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join("\n");
      const style = pip.document.createElement("style");
      style.textContent = css;
      pip.document.head.appendChild(style);
    } catch {
      // Cross-origin sheet — link it instead.
      if (sheet.href) {
        const link = pip.document.createElement("link");
        link.rel = "stylesheet";
        link.href = sheet.href;
        pip.document.head.appendChild(link);
      }
    }
  }
}

const enc = new TextEncoder();

/**
 * Resolve the WebSocket base from the API URL against the page's current origin
 * (relative "/api" → same-origin wss), so the console works behind a reverse
 * proxy / Tailscale / Cloudflare Tunnel, not just localhost.
 */
function wsBase(): string {
  const raw = process.env.NEXT_PUBLIC_API_URL ?? "/api";
  const u = new URL(raw, window.location.origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/+$/, "");
}

type TerminalLike = {
  cols: number;
  rows: number;
  open(el: HTMLElement): void;
  loadAddon(addon: unknown): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): void;
  onResize(cb: (size: { cols: number; rows: number }) => void): void;
  focus(): void;
  dispose(): void;
};

/**
 * Text (serial) console backed by Proxmox `termproxy` and rendered with xterm.js.
 * Unlike the noVNC console (a pixel framebuffer), this is real text — so the
 * web-links addon turns printed URLs into genuine clickable links (Ctrl/⌘-click
 * opens them in a new browser tab), and you get real selection + scrollback.
 *
 * Wire protocol (Proxmox terminal framing, spoken entirely here — the backend is
 * a dumb byte relay): authenticate with `${user}:${ticket}\n`; send keystrokes as
 * `0:<utf8-byte-length>:<data>`, terminal resizes as `1:<cols>:<rows>:`, and a
 * `2` keepalive. Incoming frames are raw terminal output written straight to xterm.
 */
export function SerialConsole({
  id,
  mode,
  onModeChange,
  popout = false,
}: {
  id: string;
  mode?: ConsoleMode;
  onModeChange?: (mode: ConsoleMode) => void;
  /** Chromeless variant for the pop-out window: no top bar, fills the viewport. */
  popout?: boolean;
}) {
  const mountRef = useRef<HTMLDivElement>(null); // xterm mounts here
  const bodyRef = useRef<HTMLDivElement>(null); // the terminal box — moved into PiP
  const homeRef = useRef<HTMLDivElement>(null); // where the box returns after PiP
  const pipRef = useRef<Window | null>(null);
  const termRef = useRef<TerminalLike | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const fitRef = useRef<{ fit(): void } | null>(null);
  const pingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [state, setState] = useState<ConnState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [pipActive, setPipActive] = useState(false);
  const pipSupported = typeof window !== "undefined" && getDocumentPip() !== null;

  /** Float the terminal in an always-on-top PiP window (Chrome/Edge). */
  const enterPip = useCallback(async () => {
    const dpip = getDocumentPip();
    const body = bodyRef.current;
    if (!dpip || !body || pipRef.current) return;
    try {
      const pip = await dpip.requestWindow({ width: 880, height: 440 });
      pipRef.current = pip;
      copyStylesTo(pip);
      pip.document.title = "ProxMate console";
      pip.document.body.style.margin = "0";
      pip.document.body.style.background = "#000";
      pip.document.body.appendChild(body);
      body.style.height = "100vh";
      setPipActive(true);
      const refit = () => fitRef.current?.fit();
      pip.addEventListener("resize", refit);
      setTimeout(refit, 50);
      pip.addEventListener("pagehide", () => {
        pipRef.current = null;
        body.style.height = "";
        homeRef.current?.appendChild(body);
        setPipActive(false);
        setTimeout(() => fitRef.current?.fit(), 50);
      });
      termRef.current?.focus();
    } catch {
      pipRef.current = null; // user gesture denied / unsupported — button stays available
    }
  }, []);

  // Leaving the page while the terminal floats: close the PiP window with it.
  useEffect(() => {
    return () => {
      try {
        pipRef.current?.close();
      } catch {
        /* already closed */
      }
    };
  }, []);

  /** Frame + send one terminal control message to Proxmox (text opcode). */
  const sendFrame = useCallback((frame: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(frame);
  }, []);

  const teardown = useCallback(() => {
    if (pingRef.current) {
      clearInterval(pingRef.current);
      pingRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onclose = null;
      wsRef.current.onerror = null;
      wsRef.current.onmessage = null;
      try {
        wsRef.current.close();
      } catch {
        /* already closing */
      }
      wsRef.current = null;
    }
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitRef.current = null;
  }, []);

  const connect = useCallback(async () => {
    setState("connecting");
    setError(null);
    teardown();

    let ticket: string, port: string, user: string;
    try {
      const res = await api.post<{ ticket: string; port: string; user: string }>(`/vms/${id}/serial`);
      ({ ticket, port, user } = res.data);
    } catch (err) {
      // 409 from the backend means the VM has no serial port (e.g. an ISO VM).
      const e = err as { response?: { status?: number; data?: { code?: string } } };
      if (e.response?.status === 409 && e.response.data?.code === "no_serial") {
        setState("unsupported");
        return;
      }
      setState("error");
      setError(apiError(err));
      return;
    }

    if (!mountRef.current) return;

    // Load xterm + addons on demand so they stay out of the initial bundle.
    const [{ Terminal }, { FitAddon }, { WebLinksAddon }] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/addon-web-links"),
    ]);
    if (!mountRef.current) return; // unmounted while importing

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      scrollback: 5000,
      theme: { background: "#000000", foreground: "#e5e7eb" },
    }) as unknown as TerminalLike;

    const fit = new FitAddon();
    // Open the URL only on Ctrl/⌘-click (matches a local terminal) — a plain
    // click still just positions/selects, so highlighting text doesn't navigate.
    const links = new WebLinksAddon((event: MouseEvent, uri: string) => {
      if (event.ctrlKey || event.metaKey) window.open(uri, "_blank", "noopener,noreferrer");
    });
    term.loadAddon(fit);
    term.loadAddon(links);

    term.open(mountRef.current);
    fit.fit();
    fitRef.current = fit;
    termRef.current = term;

    // Resize the remote PTY whenever xterm's geometry changes.
    term.onResize(({ cols, rows }) => sendFrame(`1:${cols}:${rows}:`));
    // Forward keystrokes.
    term.onData((data) => sendFrame(`0:${enc.encode(data).length}:${data}`));

    const wsUrl = `${wsBase()}/vms/${id}/serial?${new URLSearchParams({ vncticket: ticket, port })}`;
    const ws = new WebSocket(wsUrl);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      // In-band auth, then sync the PTY size to the current terminal geometry.
      ws.send(`${user}:${ticket}\n`);
      ws.send(`1:${term.cols}:${term.rows}:`);
      setState("connected");
      term.focus();
      pingRef.current = setInterval(() => sendFrame("2"), 30_000);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const t = termRef.current;
      if (!t) return;
      const d = ev.data;
      if (typeof d === "string") t.write(d);
      else if (d instanceof ArrayBuffer) t.write(new Uint8Array(d));
      else if (d instanceof Blob) void d.arrayBuffer().then((b) => t.write(new Uint8Array(b)));
    };
    ws.onclose = (ev: CloseEvent) => {
      if (pingRef.current) {
        clearInterval(pingRef.current);
        pingRef.current = null;
      }
      setState((s) => (s === "connected" ? (ev.wasClean ? "disconnected" : "error") : s === "connecting" ? "error" : s));
      if (!ev.wasClean) setError("The console connection was lost.");
    };
    ws.onerror = () => {
      setState((s) => (s === "connected" ? "error" : s));
    };
  }, [id, sendFrame, teardown]);

  useEffect(() => {
    // Debounce so StrictMode's mount→unmount→mount in dev doesn't burn the
    // single-use termproxy ticket on a torn-down attempt.
    const timer = setTimeout(connect, 60);
    return () => {
      clearTimeout(timer);
      teardown();
    };
  }, [connect, teardown]);

  // Refit xterm to the available area on resize (sidebar toggle, window resize).
  useEffect(() => {
    const el = mountRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const statusIndicator = (
    <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Circle
        className={cn(
          "size-2 fill-current",
          state === "connected" && "text-emerald-500",
          state === "connecting" && "text-amber-500",
          (state === "disconnected" || state === "error" || state === "unsupported") && "text-muted-foreground",
        )}
      />
      {state === "connecting" && "Connecting…"}
      {state === "connected" && "Connected"}
      {state === "disconnected" && "Disconnected"}
      {state === "error" && "Error"}
      {state === "unsupported" && "No text console"}
    </span>
  );

  return (
    <div className={cn("mx-auto flex flex-col", popout ? "h-screen w-full p-2" : "h-[calc(100vh-6.5rem)] max-w-6xl")}>
      {popout ? (
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1">
          {statusIndicator}
          <div className="flex items-center gap-2">
            <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
              <SquareTerminal className="size-3.5" /> Ctrl/⌘-click links · copy/paste works
            </span>
            {pipSupported && (
              <Button variant="outline" size="sm" onClick={enterPip} disabled={pipActive} title="Float the terminal in a window that stays on top (Chrome/Edge)">
                <PictureInPicture2 /> {pipActive ? "Floating" : "Keep on top"}
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={connect} disabled={state === "unsupported"}>
              <RefreshCw /> Reconnect
            </Button>
          </div>
        </div>
      ) : (
        <ConsoleTopBar id={id} mode={mode ?? "text"} onModeChange={onModeChange ?? (() => undefined)}>
          <span className="hidden items-center gap-1.5 text-xs text-muted-foreground sm:flex">
            <SquareTerminal className="size-3.5" /> Ctrl/⌘-click links to open
          </span>
          {statusIndicator}
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              window.open(`/console-popout/${id}`, `proxmate-console-${id}`, "popup,width=960,height=540")
            }
            title="Open this text console in its own window"
          >
            <PictureInPicture2 /> Pop out
          </Button>
          <Button variant="outline" size="sm" onClick={connect} disabled={state === "unsupported"}>
            <RefreshCw /> Reconnect
          </Button>
        </ConsoleTopBar>
      )}

      <div ref={homeRef} className="min-h-0 flex-1">
        <div ref={bodyRef} className="relative h-full w-full overflow-hidden rounded-xl bg-black p-2 ring-1 ring-foreground/10">
          <div ref={mountRef} className="h-full w-full" />

          {state === "connecting" && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-white/70">
              <Loader2 className="size-4 animate-spin" /> Opening text console…
            </div>
          )}

          {state === "unsupported" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-md text-sm text-white/70">
                This VM has no text console — it was created without a serial port (typical for ISO
                installs). Cloud-init VMs include one automatically. Use the graphical console instead.
              </p>
              {!popout && onModeChange && (
                <Button variant="outline" size="sm" onClick={() => onModeChange("graphical")}>
                  <SquareTerminal /> Switch to graphical console
                </Button>
              )}
            </div>
          )}

          {state === "error" && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="max-w-sm text-sm text-white/70">{error ?? "The console session ended."}</p>
              <Button variant="outline" size="sm" onClick={connect}>
                <RefreshCw /> Reconnect
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
