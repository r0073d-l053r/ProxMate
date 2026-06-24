import { Suspense } from "react";
import { Loader2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import NewVmWizard from "./new-vm-wizard";

// `NewVmWizard` reads `?template=<id>` via useSearchParams, so it must sit under a
// Suspense boundary or the static production build fails (Next 16 CSR bailout rule).
export default function NewVmPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-xl">
          <Card>
            <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </CardContent>
          </Card>
        </div>
      }
    >
      <NewVmWizard />
    </Suspense>
  );
}
