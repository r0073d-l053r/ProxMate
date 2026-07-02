"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Loader2, Pause, Play, Power, RotateCw, Square } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { VmDetail } from "@/lib/types";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Power actions right on the console page, so you never have to leave the
 * terminal to start / pause / restart the machine you're looking at. State is
 * polled lightly so items enable/disable to match reality; Pause/Resume are
 * QEMU-only (LXC can't be paused).
 */
export function ConsoleActions({ id }: { id: string }) {
  const [vm, setVm] = useState<VmDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const res = await api.get<VmDetail>(`/vms/${id}`);
      if (mounted.current) setVm(res.data);
    } catch {
      /* console page shows its own errors; the menu just stays generic */
    }
  }, [id]);

  useEffect(() => {
    mounted.current = true;
    load();
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 8000);
    return () => {
      mounted.current = false;
      clearInterval(iv);
    };
  }, [load]);

  async function action(label: string, path: string) {
    setBusy(true);
    try {
      await api.post(`/vms/${id}/${path}`);
      toast.success(`${label} sent.`);
      await load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  const running = vm?.status === "running";
  const stopped = vm?.status === "stopped" || vm?.status === "error";
  const paused = vm?.live?.qmpstatus === "paused";
  const isLxc = vm?.type === "lxc";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Power />}
            Actions
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuGroup>
          <DropdownMenuItem disabled={busy || !stopped} onClick={() => action("Start", "start")}>
            <Play />
            Start
          </DropdownMenuItem>
          {!isLxc && paused ? (
            <DropdownMenuItem disabled={busy} onClick={() => action("Resume", "resume")}>
              <Play />
              Resume
            </DropdownMenuItem>
          ) : (
            !isLxc && (
              <DropdownMenuItem disabled={busy || !running} onClick={() => action("Pause", "pause")}>
                <Pause />
                Pause
              </DropdownMenuItem>
            )
          )}
          <DropdownMenuItem disabled={busy || !running} onClick={() => action("Restart", "restart")}>
            <RotateCw />
            Restart
          </DropdownMenuItem>
          <DropdownMenuItem disabled={busy || stopped} onClick={() => action("Shutdown", "stop")}>
            <Square />
            Shut down
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={busy || stopped}
          onClick={() => action("Force stop", "stop?force=true")}
        >
          <Square />
          Force stop
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
