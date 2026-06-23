"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Server, LayoutDashboard, MonitorPlay, Ticket, Users, Settings } from "lucide-react";
import { useAuthStore } from "@/lib/auth-store";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/vms", label: "Virtual Machines", icon: MonitorPlay, exact: false },
];

const ADMIN_NAV = [
  { href: "/admin/invites", label: "Invites", icon: Ticket },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/settings", label: "Settings", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  const role = useAuthStore((s) => s.user?.role);

  function isActive(href: string, exact: boolean) {
    return exact ? pathname === href : pathname === href || pathname.startsWith(href + "/");
  }

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground md:flex">
      <div className="flex h-14 items-center gap-2 border-b px-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Server className="size-4" />
        </div>
        <span className="font-semibold">ProxMate</span>
      </div>

      <nav className="flex flex-1 flex-col gap-1 p-3">
        {NAV.map((item) => (
          <SidebarLink key={item.href} {...item} active={isActive(item.href, item.exact)} />
        ))}

        {role === "admin" && (
          <>
            <div className="mt-4 mb-1 px-3 text-xs font-medium text-muted-foreground">Admin</div>
            {ADMIN_NAV.map((item) => (
              <SidebarLink
                key={item.href}
                {...item}
                active={isActive(item.href, false)}
              />
            ))}
          </>
        )}
      </nav>
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
