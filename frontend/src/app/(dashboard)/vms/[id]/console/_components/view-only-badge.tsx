import { Eye } from "lucide-react";

/** Shown on a view-only console: the screen is visible, input is not sent. */
export function ViewOnlyBadge() {
  return (
    <span
      className="flex items-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-700 dark:text-amber-400"
      title="Your share level lets you watch this console. Keyboard, mouse and clipboard input are not sent."
    >
      <Eye className="size-3.5" /> View only
    </span>
  );
}
