"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Server, Check } from "lucide-react";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { useAuthStore, useHydrated } from "@/lib/auth-store";

const STEPS = [
  { path: "/setup", label: "Admin" },
  { path: "/setup/proxmox", label: "Proxmox" },
  { path: "/setup/defaults", label: "Defaults" },
  { path: "/setup/complete", label: "Finish" },
];

export default function SetupLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [checked, setChecked] = useState(false);
  const token = useAuthStore((s) => s.token);
  const hydrated = useHydrated();

  // Guard routing through the wizard based on setup and auth state
  useEffect(() => {
    if (!hydrated) return;
    let active = true;
    api
      .get<{ setupComplete: boolean; adminExists: boolean }>("/setup/status")
      .then((res) => {
        if (!active) return;
        const { setupComplete, adminExists } = res.data;

        if (setupComplete) {
          router.replace("/login");
          return;
        }

        if (token) {
          // If authenticated, step 1 is done
          if (pathname === "/setup") {
            router.replace("/setup/proxmox");
          } else {
            setChecked(true);
          }
        } else {
          // If not authenticated, they can only view step 1 (admin creation)
          if (pathname !== "/setup") {
            router.replace(adminExists ? "/login" : "/setup");
          } else {
            setChecked(true);
          }
        }
      })
      .catch(() => {
        if (active) setChecked(true);
      });
    return () => {
      active = false;
    };
  }, [hydrated, token, pathname, router]);

  const currentIndex = STEPS.findIndex((s) => s.path === pathname);

  if (!checked) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 flex-col items-center bg-muted/30 px-4 py-12">
      <div className="absolute right-4 top-4 flex items-center gap-4">
        {token && (
          <button
            onClick={() => {
              useAuthStore.getState().clear();
              router.push("/login");
            }}
            className="text-sm font-medium text-muted-foreground hover:text-foreground cursor-pointer transition-colors"
          >
            Sign Out
          </button>
        )}
        <ThemeToggle />
      </div>
      <div className="mb-8 flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Server className="size-4" />
        </div>
        <span className="text-lg font-semibold">ProxMate Setup</span>
      </div>

      <ol className="mb-8 flex items-center gap-2">
        {STEPS.map((step, i) => {
          const done = i < currentIndex;
          const active = i === currentIndex;
          return (
            <li key={step.path} className="flex items-center gap-2">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex size-6 items-center justify-center rounded-full text-xs font-medium",
                    done && "bg-primary text-primary-foreground",
                    active && "bg-primary text-primary-foreground ring-2 ring-primary/30",
                    !done && !active && "bg-muted text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span
                  className={cn(
                    "text-sm",
                    active ? "font-medium text-foreground" : "text-muted-foreground",
                  )}
                >
                  {step.label}
                </span>
              </div>
              {i < STEPS.length - 1 && <div className="h-px w-6 bg-border" />}
            </li>
          );
        })}
      </ol>

      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}
