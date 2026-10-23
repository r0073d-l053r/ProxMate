"use client";

import { useState } from "react";
import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { projectOf } from "@/lib/projects";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ProjectPicker } from "@/components/vm/project-picker";
import { cn } from "@/lib/utils";

/** The VM's project (owner/admin only): shows it, and sets or clears it. */
export function ProjectCard({
  vmId,
  tags,
  onSaved,
  className,
}: {
  vmId: string;
  tags: string | null;
  onSaved: () => void;
  className?: string;
}) {
  const current = projectOf(tags);
  const [editing, setEditing] = useState(false);

  return (
    <Card className={cn(className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FolderKanban className="size-4 text-muted-foreground" />
          Project
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <p className="text-sm">
          {current ? (
            <Link href="/projects" className="font-medium hover:underline">
              {current}
            </Link>
          ) : (
            <span className="text-muted-foreground">Not in a project.</span>
          )}
        </p>
        {editing ? (
          <ProjectPicker
            ids={[vmId]}
            current={current}
            onDone={() => { setEditing(false); onSaved(); }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              {current ? "Change project" : "Add to project"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
