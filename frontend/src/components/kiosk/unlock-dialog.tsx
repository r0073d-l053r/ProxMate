"use client";

import { useState } from "react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Fingerprint, Delete, X, KeyRound, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * The re-auth gate shown when an admin taps ✕ to leave kiosk mode. Full-screen,
 * touch-first (on-screen keypad), and offers whichever methods are available:
 * passkey, the admin-set exit PIN, and the account password as a fallback so the
 * admin can never be locked out of their own panel. On success `onUnlock` runs
 * the real exit; `onCancel` returns to the panel. Nothing here re-mints a login
 * session — it only proves the admin is present.
 */
export function KioskUnlockDialog({
  hasPasskeys,
  pinSet,
  onUnlock,
  onCancel,
}: {
  hasPasskeys: boolean;
  pinSet: boolean;
  onUnlock: () => void;
  onCancel: () => void;
}) {
  const [mode, setMode] = useState<"pin" | "password">(pinSet ? "pin" : "password");
  const [pin, setPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "pin" | "password" | "passkey">(null);
  const [error, setError] = useState<string | null>(null);

  const tapPin = (d: string) => {
    setError(null);
    setPin((p) => (p.length >= 12 ? p : p + d));
  };
  const backspace = () => setPin((p) => p.slice(0, -1));

  async function submitPin() {
    if (pin.length < 4 || busy) return;
    setBusy("pin");
    setError(null);
    try {
      await api.post("/auth/kiosk-exit", { method: "pin", value: pin });
      onUnlock();
    } catch (err) {
      setError(apiError(err));
      setPin("");
    } finally {
      setBusy(null);
    }
  }

  async function submitPassword() {
    if (!password || busy) return;
    setBusy("password");
    setError(null);
    try {
      await api.post("/auth/kiosk-exit", { method: "password", value: password });
      onUnlock();
    } catch (err) {
      setError(apiError(err));
      setPassword("");
    } finally {
      setBusy(null);
    }
  }

  async function passkeyUnlock() {
    if (busy) return;
    setBusy("passkey");
    setError(null);
    try {
      const { data: options } = await api.post("/auth/kiosk-exit/passkey-options");
      const assertion = await startAuthentication({ optionsJSON: options });
      await api.post("/auth/kiosk-exit/passkey-verify", assertion);
      onUnlock();
    } catch (err) {
      setError(apiError(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex cursor-auto items-center justify-center bg-background/95 backdrop-blur-sm">
      <div className="w-[26rem] max-w-[92vw] rounded-2xl border bg-card p-6 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2 text-base font-semibold">
            <KeyRound className="size-5 text-primary" /> Unlock to exit
          </div>
          <button
            onClick={onCancel}
            aria-label="Stay in kiosk mode"
            className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent"
          >
            <X className="size-5" />
          </button>
        </div>

        <p className="mb-4 text-sm text-muted-foreground">
          Confirm it&apos;s you to leave the panel.
        </p>

        {hasPasskeys && (
          <button
            onClick={passkeyUnlock}
            disabled={!!busy}
            className="mb-4 flex w-full items-center justify-center gap-2 rounded-xl border bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60"
          >
            {busy === "passkey" ? <Loader2 className="size-5 animate-spin" /> : <Fingerprint className="size-5" />}
            Unlock with passkey
          </button>
        )}

        {mode === "pin" && pinSet ? (
          <>
            <div className="mb-4 flex items-center justify-center gap-2" aria-label="PIN entry">
              {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
                <span
                  key={i}
                  className={cn(
                    "size-3 rounded-full border",
                    i < pin.length ? "border-primary bg-primary" : "border-muted-foreground/40",
                  )}
                />
              ))}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                <KeypadKey key={d} onClick={() => tapPin(d)} disabled={!!busy}>
                  {d}
                </KeypadKey>
              ))}
              <KeypadKey onClick={backspace} disabled={!!busy} aria-label="Backspace">
                <Delete className="size-5" />
              </KeypadKey>
              <KeypadKey onClick={() => tapPin("0")} disabled={!!busy}>
                0
              </KeypadKey>
              <KeypadKey
                onClick={submitPin}
                disabled={pin.length < 4 || !!busy}
                className="bg-primary text-primary-foreground hover:opacity-90"
                aria-label="Unlock"
              >
                {busy === "pin" ? <Loader2 className="size-5 animate-spin" /> : "↵"}
              </KeypadKey>
            </div>
          </>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitPassword();
            }}
            className="grid gap-3"
          >
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Account password"
              className="w-full rounded-xl border bg-background px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-primary"
            />
            <button
              type="submit"
              disabled={!password || !!busy}
              className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-sm font-medium text-primary-foreground transition-colors hover:opacity-90 disabled:opacity-60"
            >
              {busy === "password" ? <Loader2 className="size-5 animate-spin" /> : null}
              Unlock &amp; exit
            </button>
          </form>
        )}

        {error && <p className="mt-3 text-center text-sm text-destructive">{error}</p>}

        <div className="mt-4 flex items-center justify-center gap-4 text-xs text-muted-foreground">
          {pinSet && (
            <button onClick={() => { setMode((m) => (m === "pin" ? "password" : "pin")); setError(null); }} className="hover:text-foreground">
              {mode === "pin" ? "Use account password" : "Use PIN"}
            </button>
          )}
          <button onClick={onCancel} className="hover:text-foreground">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

function KeypadKey({
  children,
  onClick,
  disabled,
  className,
  ...rest
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-14 items-center justify-center rounded-xl border bg-card/60 text-xl font-medium tabular-nums transition-colors hover:bg-accent disabled:opacity-50",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
