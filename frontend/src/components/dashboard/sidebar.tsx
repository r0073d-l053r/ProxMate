"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Server, LayoutDashboard, MonitorPlay, Package, Ticket, Users, Settings, BookOpen, Activity, ScrollText, BarChart3 } from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/vms", label: "Virtual Machines", icon: MonitorPlay, exact: false },
  { href: "/templates", label: "Template Store", icon: Package, exact: false },
  { href: "/help", label: "Help & Docs", icon: BookOpen, exact: false },
];

const ADMIN_NAV = [
  { href: "/admin/monitor", label: "Monitor", icon: Activity },
  { href: "/admin/usage", label: "Usage", icon: BarChart3 },
  { href: "/admin/invites", label: "Invites", icon: Ticket },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/audit", label: "Audit Log", icon: ScrollText },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

/**
 * The shared sidebar contents (brand header + nav), used by both the desktop
 * `Sidebar` and the mobile drawer (`MobileSidebar`) so the two never drift.
 */
export function SidebarNav() {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);

  function isActive(href: string, exact: boolean) {
    return exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <>
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Server className="size-4" />
        </div>
        <span className="font-semibold">ProxMate</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-3">
        {NAV.map((item) => (
          <SidebarLink key={item.href} {...item} active={isActive(item.href, item.exact)} />
        ))}

        {role === "admin" && (
          <>
            <div className="mt-4 mb-1 px-3 text-xs font-medium text-muted-foreground">Admin</div>
            {ADMIN_NAV.map((item) => (
              <SidebarLink key={item.href} {...item} active={isActive(item.href, false)} />
            ))}
          </>
        )}
      </nav>
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <SidebarNav />
    </aside>
  );
}

function SidebarLink({
  href,
  label,
  icon: Icon,
  active,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  active: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
      )}
    >
      <Icon className="size-4" />
      {label}
    </Link>
  );
}
