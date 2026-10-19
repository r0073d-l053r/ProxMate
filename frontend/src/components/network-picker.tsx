"use client";

import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import type { GuestNetwork } from "@/lib/types";
import { networkCoverageWarning, networkKindLabel, networkNameError } from "@/lib/networks";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The "default network" picker, shared by the setup wizard and admin settings.
 *
 * Lists Linux bridges, OVS bridges and SDN VNets across the cluster, flagging any that
 * some nodes lack. It can always fall back to typing a name: discovery depends on the
 * token's privileges and the Proxmox release, and an empty list must never be what
 * stops setup (issue #126).
 */
export function NetworkPicker({
  networks,
  nodeCount,
  value,
  onChange,
  id,
}: {
  networks: GuestNetwork[];
  nodeCount?: number;
  value: string;
  onChange: (v: string) => void;
  id?: string;
}) {
  const [typing, setTyping] = useState(false);
  // A saved value discovery cannot see (e.g. a VNet hidden by a missing SDN.Audit)
  // stays visible and editable instead of rendering as a blank select.
  const unlisted = !!value && !networks.some((n) => n.name === value);
  const empty = networks.length === 0;
  const manual = typing || empty || unlisted;

  const selected = networks.find((n) => n.name === value);
  const coverage = selected ? networkCoverageWarning(selected, nodeCount) : null;
  const nameError = manual && value ? networkNameError(value) : null;

  return (
    <div className="grid gap-1.5">
      {manual ? (
        <Input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="e.g. vmbr0 or an SDN VNet ID"
          aria-invalid={!!nameError}
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <Select value={value} onValueChange={(v) => onChange(v as string)}>
          <SelectTrigger id={id} className="w-full">
            <SelectValue placeholder="Select a bridge or SDN VNet" />
          </SelectTrigger>
          <SelectContent>
            {networks.map((n) => {
              const partial = networkCoverageWarning(n, nodeCount);
              return (
                <SelectItem key={n.name} value={n.name}>
                  {n.name}
                  <span className="text-muted-foreground">
                    {" "}
                    · {networkKindLabel(n)}
                    {n.comment ? ` · ${n.comment}` : ""}
                    {partial ? ` · ${partial}` : ""}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      )}

      {nameError && <p className="text-xs text-destructive">{nameError}</p>}
      {coverage && (
        <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          This network is {coverage}. Guests placed on the other nodes will fail to start.
        </p>
      )}
      {empty ? (
        <p className="text-xs text-muted-foreground">
          No bridges or SDN VNets were found. On an SDN cluster, check that the token holds
          SDN.Audit and that the SDN configuration has been applied — or type the VNet ID.
        </p>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="justify-self-start text-muted-foreground"
          onClick={() => {
            if (manual) {
              setTyping(false);
              if (unlisted) onChange("");
            } else {
              setTyping(true);
            }
          }}
        >
          {manual ? "Choose from the discovered networks" : "Not listed? Type a name"}
        </Button>
      )}
    </div>
  );
}
