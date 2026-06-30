"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowUpCircle, Loader2, Send } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { Quota } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/form-field";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

interface MyRequest {
  id: string;
  status: string;
}

/** User action under the quota cards: ask an admin to raise the caps. */
export function RequestQuotaDialog({ quota }: { quota: Quota }) {
  const [open, setOpen] = useState(false);
  const [cpu, setCpu] = useState(quota.cpu.max);
  const [ramGb, setRamGb] = useState(Math.round(quota.ram.max / 1024));
  const [storage, setStorage] = useState(quota.storage.max);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    api
      .get<MyRequest[]>("/quota-requests/mine")
      .then((r) => setPending(r.data.some((x) => x.status === "pending")))
      .catch(() => undefined);
  }, []);

  const num = (v: string) => Math.max(1, Math.floor(Number(v) || 1));

  function onOpenChange(o: boolean) {
    setOpen(o);
    if (o) {
      setCpu(quota.cpu.max);
      setRamGb(Math.round(quota.ram.max / 1024));
      setStorage(quota.storage.max);
    }
  }

  async function submit() {
    setBusy(true);
    try {
      await api.post("/quota-requests", { cpu, ram: ramGb * 1024, storage, reason: reason.trim() || undefined });
      toast.success("Quota request sent to your administrator.");
      setOpen(false);
      setReason("");
      setPending(true);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setBusy(false);
    }
  }

  if (pending) {
    return (
      <p className="mt-3 text-xs text-muted-foreground">
        A quota-increase request is pending your administrator&apos;s review.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogTrigger
          render={
            <Button size="sm" variant="outline">
              <ArrowUpCircle /> Request more quota
            </Button>
          }
        />
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Request a quota increase</AlertDialogTitle>
            <AlertDialogDescription>
              Ask your administrator to raise your caps. Enter the totals you&apos;d like — they&apos;ll
              approve or deny.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid items-start gap-3 py-1 sm:grid-cols-3">
            <FormField label="vCPU" htmlFor="rq-cpu">
              <Input id="rq-cpu" type="number" min={1} value={cpu} onChange={(e) => setCpu(num(e.target.value))} />
            </FormField>
            <FormField label="RAM (GB)" htmlFor="rq-ram">
              <Input id="rq-ram" type="number" min={1} value={ramGb} onChange={(e) => setRamGb(num(e.target.value))} />
            </FormField>
            <FormField label="Storage (GB)" htmlFor="rq-storage">
              <Input id="rq-storage" type="number" min={1} value={storage} onChange={(e) => setStorage(num(e.target.value))} />
            </FormField>
          </div>
          <FormField label="Reason (optional)" htmlFor="rq-reason">
            <textarea
              id="rq-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              maxLength={1000}
              placeholder="What do you need the extra capacity for?"
              className="w-full resize-y rounded-lg border border-input bg-transparent p-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </FormField>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button onClick={submit} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <Send />}
              Send request
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
