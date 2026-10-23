import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { AdminManagedBadge, AdminManagedNote, showsAdminManaged } from "./admin-managed-notice";

afterEach(cleanup);

describe("admin-managed notice", () => {
  it("shows a badge and the one-line explainer to a non-admin", () => {
    const { container } = render(
      <>
        <AdminManagedBadge vm={{ adminManaged: true }} isAdmin={false} />
        <AdminManagedNote vm={{ adminManaged: true }} isAdmin={false} />
      </>,
    );
    expect(container.textContent).toContain("Admin-managed");
    expect(container.textContent).toContain("Set up by your admin — only an admin can resize or rebuild it.");
  });

  it("shows nothing to an admin (they keep the controls) or for a VM the tenant created", () => {
    const admin = render(<AdminManagedNote vm={{ adminManaged: true }} isAdmin />);
    expect(admin.container.textContent).toBe("");
    cleanup();
    const own = render(<AdminManagedBadge vm={{ adminManaged: false }} isAdmin={false} />);
    expect(own.container.textContent).toBe("");
  });

  it("treats a missing flag as not admin-managed", () => {
    expect(showsAdminManaged({}, false)).toBe(false);
  });
});
