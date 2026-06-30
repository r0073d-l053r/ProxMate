import { redirect } from "next/navigation";

/**
 * The Usage view has moved under Users › Usage (one combined admin tab). Keep the
 * old /admin/usage path working for bookmarks by redirecting to it.
 */
export default function UsagePage() {
  redirect("/admin/users");
}
