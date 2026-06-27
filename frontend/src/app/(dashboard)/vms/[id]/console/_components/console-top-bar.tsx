"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, Monitor, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConsoleMode = "graphical" | "text";

/**
 * Shared console header: a Back link, the Graphical | Text mode toggle, and a
 * slot on the right for mode-specific actions (status, paste, reconnect, …).
 * Both the noVNC and the xterm.js consoles render this so the toggle is always
 * present and consistent.
 */
export function ConsoleTopBar({
  id,
  mode,
  onModeChange,
  children,
}: {
  id: string;
  mode: ConsoleMode;
  onModeChange: (mode: ConsoleMode) => void;
  children?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <Button variant="ghost" render={<Link href={`/vms/${id}`} />}>
          <ArrowLeft /> Back to VM
        </Button>

        <div className="flex items-center rounded-md border p-0.5" role="tablist" aria-label="Console type">
          <ModeButton active={mode === "graphical"} onClick={() => onModeChange("graphical")}>
            <Monitor className="size-4" /> Graphical
          </ModeButton>
          <ModeButton active={mode === "text"} onClick={() => onModeChange("text")}>
            <SquareTerminal className="size-4" /> Text
          </ModeButton>
        </div>
      </div>

      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-sm transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
