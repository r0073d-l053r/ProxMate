"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Megaphone, Loader2, Send } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
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

interface BroadcastResult {
  ok: boolean;
  sent: number;
  failed: number;
  total: number;
  skipped: number; // users who unsubscribed from broadcasts
}

/**
 * Admin → email a maintenance / downtime / general announcement to every user.
 * Requires SMTP to be configured; the send is gated behind a confirm dialog.
 */
export function BroadcastCard() {
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);
  const ready = subject.trim().length > 0 && message.trim().length > 0;

  async function send() {
    setSending(true);
    try {
      const res = await api.post<BroadcastResult>("/admin/broadcast", {
        subject: subject.trim(),
        message: message.trim(),
      });
      const { sent, failed, total, skipped } = res.data;
      const optedOut = skipped ? ` (${skipped} unsubscribed)` : "";
      if (failed === 0) {
        toast.success(`Announcement sent to ${total} user${total === 1 ? "" : "s"}${optedOut}.`);
      } else {
        toast.warning(`Sent to ${sent} of ${total} — ${failed} failed (check SMTP and addresses)${optedOut}.`);
      }
      setOpen(false);
      setSubject("");
      setMessage("");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Megaphone className="size-4 text-muted-foreground" /> Broadcast email
        </CardTitle>
        <CardDescription>
          Email an announcement to <span className="font-medium text-foreground">every user</span> — e.g.
          planned maintenance, expected downtime, or an all-clear. Uses your configured SMTP and the
          ProxMate-branded email template. Users who unsubscribed from announcements are skipped
          (security and account emails are never affected).
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <FormField label="Subject" htmlFor="bc-subject">
          <Input
            id="bc-subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            maxLength={200}
            placeholder="Scheduled maintenance tonight, 10–11pm ET"
          />
        </FormField>
        <FormField label="Message" htmlFor="bc-message" hint="Plain text — line breaks are preserved.">
          <textarea
            id="bc-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={5000}
            rows={6}
            placeholder={
              "Hi everyone,\n\nProxMate will be briefly offline tonight from 10–11pm ET for maintenance. Your VMs keep running — only the dashboard is affected. We'll email an all-clear once it's back.\n\n— Admin"
            }
            className="w-full resize-y rounded-lg border border-input bg-transparent p-2.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </FormField>
        <AlertDialog open={open} onOpenChange={setOpen}>
          <AlertDialogTrigger
            render={
              <Button className="w-fit" disabled={!ready}>
                <Send /> Send to all users
              </Button>
            }
          />
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Email all users?</AlertDialogTitle>
              <AlertDialogDescription>
                This sends &ldquo;{subject.trim() || "your announcement"}&rdquo; to every ProxMate user on
                this server. Double-check the details — there&apos;s no recall once it&apos;s out.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={sending}>Cancel</AlertDialogCancel>
              <Button onClick={send} disabled={sending}>
                {sending ? <Loader2 className="animate-spin" /> : <Send />}
                Send now
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
