"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

// The dedicated deploy page was merged into the unified /vms/new wizard.
// Keep this route as a redirect shim so existing /templates/<id> links still work.
export default function DeployTemplateRedirect() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(`/vms/new?template=${id}`);
  }, [id, router]);

  return (
    <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> Redirecting…
    </div>
  );
}
