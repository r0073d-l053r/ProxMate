"use client";

import { ArrowUpRight, BookOpen, ShieldOff, Terminal, Globe, Server, AlertTriangle } from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const REPO_DOCS_BASE = "https://github.com/r0073dl053r/ProxMate/blob/main/docs";

function DocLink({
  icon: Icon,
  title,
  description,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  href: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex items-start gap-3 rounded-lg border p-4 transition-colors hover:border-foreground/20 hover:bg-muted/40"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground group-hover:text-foreground">
        <Icon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">{title}</span>
          <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
    </a>
  );
}

export default function HelpPage() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "admin";

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Help & Docs"
        description="Guides for getting your VM online and reaching it from outside ProxMate."
      />

      {/* The rule — front and center */}
      <Card className="mb-6 border-amber-500/30 bg-amber-500/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <ShieldOff className="size-4 text-amber-500" />
            Cluster policy: no port forwarding
          </CardTitle>
          <CardDescription>
            Don&apos;t ask the host admin to forward a port to your VM — they won&apos;t. The two
            guides below cover every external-access case (private SSH and public web) without any
            inbound ports on the host network.
          </CardDescription>
        </CardHeader>
      </Card>

      <div className="grid gap-3">
        <h2 className="mt-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          For tenants
        </h2>

        <DocLink
          icon={BookOpen}
          title="External access overview"
          description="Why no port forwarding, and which of the two tools below to pick for your use case."
          href={`${REPO_DOCS_BASE}/external-access.md`}
        />

        <DocLink
          icon={Terminal}
          title="SSH into your VM from anywhere — Tailscale"
          description="Step-by-step: install Tailscale on your laptop and inside the VM, then `ssh you@your-vm` from anywhere. No public IP, no firewall changes."
          href={`${REPO_DOCS_BASE}/tailscale-ssh.md`}
        />

        <DocLink
          icon={Globe}
          title="Publish a public website — Cloudflare Tunnel"
          description="Get an https://yourapp.yourdomain.com endpoint backed by your VM, with HTTPS and DDoS protection, without exposing any port."
          href={`${REPO_DOCS_BASE}/cloudflare-tunnels.md`}
        />

        {isAdmin && (
          <>
            <h2 className="mt-6 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              For admins
            </h2>
            <DocLink
              icon={Server}
              title="Cluster setup + tenant templates"
              description="First-time Proxmox connection, the firewall-enforcement step you must run before inviting anyone, and how to ship a pre-baked Linux template tenants can deploy in one click."
              href={`${REPO_DOCS_BASE}/admin-guide.md`}
            />
            <DocLink
              icon={AlertTriangle}
              title="Security model — full details"
              description="The application-layer and network-layer isolation guarantees, the &quot;gold-standard&quot; dedicated-VLAN setup, secrets handling, and the deployment hardening checklist."
              href="https://github.com/r0073dl053r/ProxMate/blob/main/SECURITY.md"
            />
          </>
        )}
      </div>
    </div>
  );
}
