import type { Metadata } from "next";
import { AuthGuard } from "@/components/dashboard/auth-guard";

// A chromeless shell (no sidebar/topbar) for the rack touch-panel kiosk. Auth is
// still enforced via AuthGuard; the page itself gates to admins (cluster-wide data).
export const metadata: Metadata = { title: "Kiosk" };

export default function KioskLayout({ children }: { children: React.ReactNode }) {
  return <AuthGuard>{children}</AuthGuard>;
}
