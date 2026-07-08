"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, KeySquare, LifeBuoy, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { SshKey, VmDetail } from "@/lib/types";
import { copyText } from "@/lib/clipboard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

function Row({
  title,
  description,
  action,
}: {
  title: string;
  description: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <div className="shrink-0">{action}</div>
    </div>
  );
}

/**
 * The DigitalOcean-style Recovery section of the Settings tab (QEMU only):
 * reset a guest user's password via the guest agent, and boot into / out of
 * rescue mode (an admin-designated rescue ISO).
 */
export function RecoveryPanel({
  vm,
  busy,
  onChanged,
}: {
  vm: VmDetail;
  busy: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<"password" | "rescue" | "sshkey" | null>(null);
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  // Add-SSH-key dialog state; saved keys are fetched lazily when it opens.
  const [keyUsername, setKeyUsername] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [savedKeys, setSavedKeys] = useState<SshKey[]>([]);

  const inRescue = !!vm.rescueBoot;
  const running = vm.status === "running";

  async function resetPassword() {
    const name = username.trim();
    if (!name) {
      toast.error("Enter the guest username (e.g. ubuntu, debian, root).");
      return;
    }
    setWorking(true);
    try {
      const res = await api.post<{ password: string }>(`/vms/${vm.id}/reset-password`, { username: name });
      setNewPassword(res.data.password);
      onChanged();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setWorking(false);
    }
  }

  function openSshKeyDialog() {
    setKeyUsername("");
    setPublicKey("");
    setDialog("sshkey");
    // Saved keys are a convenience — never block the dialog on them.
    api
      .get<SshKey[]>("/ssh-keys")
      .then((r) => setSavedKeys(r.data ?? []))
      .catch(() => setSavedKeys([]));
  }

  async function addSshKey() {
    const name = keyUsername.trim();
    const key = publicKey.trim();
    if (!name) {
      toast.error("Enter the guest username (e.g. ubuntu, debian, root).");
      return;
    }
    if (!/^(ssh-(rsa|ed25519|dss)|ecdsa-sha2-|sk-)/.test(key)) {
      toast.error("That doesn't look like an OpenSSH public key.");
      return;
    }
    setWorking(true);
    try {
      await api.post(`/vms/${vm.id}/ssh-keys`, { username: name, publicKey: key });
      toast.success(`Key added — you can SSH in as ${name} with it now.`);
      setDialog(null);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setWorking(false);
    }
  }

  async function enterRescue() {
    setWorking(true);
    try {
      await api.post(`/vms/${vm.id}/rescue`);
      toast.success("Booting into rescue mode — open the console to use it.");
      setDialog(null);
      onChanged();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setWorking(false);
    }
  }

  async function exitRescue() {
    setWorking(true);
    try {
      await api.post(`/vms/${vm.id}/rescue/exit`);
      toast.success("Leaving rescue mode — booting from disk.");
      onChanged();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setWorking(false);
    }
  }

  async function copyPassword() {
    if (!newPassword) return;
    const ok = await copyText(newPassword);
    if (ok) toast.success("Password copied.");
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <LifeBuoy className="size-4 text-muted-foreground" />
          Recovery
        </CardTitle>
      </CardHeader>
      <CardContent className="divide-y">
        <Row
          title="Reset guest password"
          description={
            running
              ? "Locked out? Set a new password for a user inside the machine (needs the guest agent)."
              : "Start the machine first — the password is set through the running guest agent."
          }
          action={
            <Button
              variant="outline"
              disabled={busy || working || !running}
              onClick={() => {
                setUsername("");
                setNewPassword(null);
                setDialog("password");
              }}
            >
              <KeyRound />
              Reset password
            </Button>
          }
        />
        <Row
          title="Add an SSH key"
          description={
            running
              ? "Add one of your public keys to a user inside the machine — no rebuild needed (uses the guest agent)."
              : "Start the machine first — keys are added through the running guest agent."
          }
          action={
            <Button variant="outline" disabled={busy || working || !running} onClick={openSshKeyDialog}>
              <KeySquare />
              Add SSH key
            </Button>
          }
        />
        <Row
          title="Rescue mode"
          description={
            inRescue
              ? "Booted from the rescue ISO. Repair the disk via the console, then exit to boot normally."
              : vm.rescueAvailable
                ? "Won't boot? Restart from the rescue ISO and repair the disk from the console."
                : "No rescue ISO is set up on this cluster — ask your admin (Admin → Settings)."
          }
          action={
            inRescue ? (
              <Button variant="outline" disabled={busy || working} onClick={exitRescue}>
                {working ? <Loader2 className="animate-spin" /> : <LifeBuoy />}
                Exit rescue
              </Button>
            ) : (
              <Button
                variant="outline"
                disabled={busy || working || !vm.rescueAvailable}
                onClick={() => setDialog("rescue")}
              >
                <LifeBuoy />
                Boot into rescue
              </Button>
            )
          }
        />
      </CardContent>

      {/* Reset password dialog — shows the generated password exactly once. */}
      <AlertDialog
        open={dialog === "password"}
        onOpenChange={(o: boolean) => {
          if (!o) setNewPassword(null);
          setDialog(o ? "password" : null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset a guest password</AlertDialogTitle>
            <AlertDialogDescription>
              Sets a new password for a user inside {vm.name} via the QEMU guest agent — handy when a
              cloud image was deployed key-only. The password is generated securely and shown once;
              ProxMate never stores it.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {newPassword ? (
            <div className="rounded-md border bg-muted/50 p-3">
              <p className="mb-1 text-xs text-muted-foreground">
                New password for <span className="font-medium text-foreground">{username.trim()}</span> — copy
                it now, it won&apos;t be shown again:
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-background px-2 py-1.5 font-mono text-sm">{newPassword}</code>
                <Button variant="outline" size="sm" onClick={copyPassword}>
                  <Copy /> Copy
                </Button>
              </div>
            </div>
          ) : (
            <FormField label="Guest username" htmlFor="guestUser">
              <Input
                id="guestUser"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. ubuntu, debian, root"
                autoComplete="off"
              />
            </FormField>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>{newPassword ? "Done" : "Cancel"}</AlertDialogCancel>
            {!newPassword && (
              <AlertDialogAction onClick={resetPassword} disabled={working || !username.trim()}>
                {working ? <Loader2 className="animate-spin" /> : <KeyRound />}
                Reset password
              </AlertDialogAction>
            )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add-SSH-key dialog — saved-key quick-pick + paste, same as the deploy wizard. */}
      <AlertDialog open={dialog === "sshkey"} onOpenChange={(o: boolean) => setDialog(o ? "sshkey" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Add an SSH key to {vm.name}</AlertDialogTitle>
            <AlertDialogDescription>
              Appends your public key to a user&apos;s <code>authorized_keys</code> inside the machine via
              the QEMU guest agent, so you can SSH in with it right away — no rebuild or reboot needed.
            </AlertDialogDescription>
          </AlertDialogHeader>

          <FormField label="SSH public key" htmlFor="addSshKey">
            {savedKeys.length > 0 && (
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-xs text-muted-foreground">Use a saved key:</span>
                {savedKeys.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    onClick={() => setPublicKey(k.publicKey)}
                    className={
                      "rounded-full border px-2.5 py-0.5 text-xs transition-colors " +
                      (publicKey === k.publicKey
                        ? "border-primary bg-primary/10 text-primary"
                        : "hover:bg-muted")
                    }
                  >
                    {k.name}
                  </button>
                ))}
              </div>
            )}
            <textarea
              id="addSshKey"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              placeholder="ssh-ed25519 AAAA… you@laptop"
              className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
            />
          </FormField>

          <FormField label="Guest username" htmlFor="addSshKeyUser" hint="The user whose authorized_keys receives the key.">
            <Input
              id="addSshKeyUser"
              value={keyUsername}
              onChange={(e) => setKeyUsername(e.target.value)}
              placeholder="e.g. ubuntu, debian, root"
              autoComplete="off"
            />
          </FormField>

          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={addSshKey} disabled={working || !keyUsername.trim() || !publicKey.trim()}>
              {working ? <Loader2 className="animate-spin" /> : <KeySquare />}
              Add key
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Enter-rescue confirm dialog. */}
      <AlertDialog open={dialog === "rescue"} onOpenChange={(o: boolean) => setDialog(o ? "rescue" : null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Boot {vm.name} into rescue mode?</AlertDialogTitle>
            <AlertDialogDescription>
              The machine is <span className="font-medium text-foreground">stopped (forced if needed)</span> and
              restarted from the cluster&apos;s rescue ISO — your disk is untouched and stays attached, so you
              can repair it from the console. When you&apos;re done, use{" "}
              <span className="font-medium text-foreground">Exit rescue</span> to boot normally again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={working}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={enterRescue} disabled={working}>
              {working ? <Loader2 className="animate-spin" /> : <LifeBuoy />}
              Boot into rescue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
