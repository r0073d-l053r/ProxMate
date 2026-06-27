import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { ConsoleSwitcher } from "./_components/console-switcher";

// `ConsoleSwitcher` reads `?mode=` via useSearchParams, so it must sit under a
// Suspense boundary or the static production build fails (Next 16 CSR bailout rule).
export default function ConsolePage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex h-[calc(100vh-6.5rem)] max-w-6xl items-center justify-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading console…
        </div>
      }
    >
      <ConsoleSwitcher />
    </Suspense>
  );
}
