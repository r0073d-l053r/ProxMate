/**
 * What the VM page says when its VM answers 404. A create that failed after the
 * request answered removes the machine, and the API then returns the reason to its
 * owner (or an admin) as `code: "create_failed"`. Returns null for an ordinary 404.
 */
export function missingVmMessage(
  body: { error?: string; code?: string } | undefined,
  lastStatus: string | null,
): string | null {
  if (body?.code === "create_failed") return `This machine couldn't be created: ${body.error ?? "provisioning failed"}`;
  if (lastStatus === "creating") return "This machine no longer exists.";
  return null;
}
