"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarNav } from "@/components/dashboard/sidebar";

/**
 * Mobile-only navigation: a hamburger button (shown when the desktop sidebar is
 * hidden, i.e. below `md`) that opens a left-anchored drawer with the same nav.
 * The drawer auto-closes on navigation so tapping a link feels native.
 */
export function MobileSidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Close whenever the route changes (after a link tap).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        render={
          <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation menu">
            <Menu className="size-5" />
          </Button>
        }
      />
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/50 transition-opacity duration-200 data-closed:opacity-0 md:hidden" />
        <Dialog.Popup className="fixed inset-y-0 left-0 z-50 flex w-64 max-w-[80vw] flex-col border-r bg-sidebar text-sidebar-foreground shadow-xl transition-transform duration-200 outline-none data-closed:-translate-x-full md:hidden">
          <Dialog.Title className="sr-only">Navigation</Dialog.Title>
          <SidebarNav />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
