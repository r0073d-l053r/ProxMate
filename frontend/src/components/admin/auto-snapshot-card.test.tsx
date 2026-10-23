import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const get = vi.fn();
const put = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a) },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AutoSnapshotCard } from "./auto-snapshot-card";
import { autoSnapshotNote, isAutoSnapshotName } from "@/lib/auto-snapshot";

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: { autoSnapshot: { enabled: true, keep: 3 } } });
  put.mockReset().mockResolvedValue({});
});
afterEach(cleanup);

describe("AutoSnapshotCard", () => {
  it("loads the setting and saves a new keep count", async () => {
    render(<AutoSnapshotCard />);
    const keep = await screen.findByLabelText("Automatic snapshots kept per VM");
    await waitFor(() => expect((keep as HTMLInputElement).value).toBe("3"));
    fireEvent.change(keep, { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/admin/settings/auto-snapshot", { enabled: true, keep: 5 }));
  });

  it("can turn the feature off", async () => {
    render(<AutoSnapshotCard />);
    const box = await screen.findByRole("checkbox");
    await waitFor(() => expect((box as HTMLInputElement).checked).toBe(true));
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(put).toHaveBeenCalledWith("/admin/settings/auto-snapshot", { enabled: false, keep: 3 }));
  });

  it("says plainly that a rebuild is not covered", async () => {
    render(<AutoSnapshotCard />);
    await screen.findByText(/A rebuild isn.t covered/);
  });
});

describe("autoSnapshotNote", () => {
  it("names the snapshot taken, explains an unsupported storage, and stays quiet otherwise", () => {
    expect(autoSnapshotNote({ taken: "pm-auto-resize-20261023-120000" })).toMatch(/pm-auto-resize-20261023-120000/);
    expect(autoSnapshotNote({ taken: null, skipped: "unsupported" })).toMatch(/doesn't support snapshots/);
    expect(autoSnapshotNote({ taken: null, skipped: "disabled" })).toBeNull();
    expect(autoSnapshotNote({ taken: null, skipped: "container" })).toBeNull();
    expect(autoSnapshotNote(undefined)).toBeNull();
  });

  it("recognises automatic snapshot names", () => {
    expect(isAutoSnapshotName("pm-auto-rescue-20261023-120000")).toBe(true);
    expect(isAutoSnapshotName("before-upgrade")).toBe(false);
  });
});
