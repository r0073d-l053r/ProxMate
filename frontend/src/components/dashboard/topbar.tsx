"use client";

import { useRouter } from "next/navigation";
import { LogOut, ChevronDown, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { ThemeToggle } from "@/components/theme-toggle";
import { MobileSidebar } from "@/components/dashboard/mobile-sidebar";

function initials(name: string): string {
  return name
    .split(" ")
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function Topbar() {
  const router = useRouter();
  const user = useAuthStore((s) => s.user);
  const clear = useAuthStore((s) => s.clear);

  function logout() {
    // Best-effort server-side session delete; never let a slow/failing
    // network call block (or throw out of) the sign-out flow.
    api.post("/auth/logout").catch(() => {});
    clear();
    router.replace("/login");
  }

  return (
    <header className="flex h-14 shrink-0 items-center gap-1 border-b bg-background px-4">
      <MobileSidebar />
      <div className="ml-auto flex items-center gap-1">
        <ThemeToggle />
        <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" className="h-9 gap-2">
              <span className="flex size-6 items-center justify-center rounded-full bg-primary text-xs font-medium text-primary-foreground">
                {user ? initials(user.displayName) : "?"}
              </span>
              <span className="hidden text-sm font-medium sm:inline">{user?.displayName}</span>
              <ChevronDown className="size-3.5 text-muted-foreground" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-1">
              <span className="text-sm font-medium text-foreground">{user?.displayName}</span>
              <span className="text-xs text-muted-foreground">{user?.email}</span>
              {user?.role === "admin" && (
                <Badge variant="secondary" className="mt-1 w-fit">
                  Administrator
                </Badge>
              )}
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => router.push("/security")}>
            <ShieldCheck />
            Security
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={logout}>
            <LogOut />
            Sign out
          </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
