import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
  },
  apiError: (e: unknown) => String(e),
}));
const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: (...a: unknown[]) => toastError(...a) } }));

import { IdeLogDialog } from "./ide-log-dialog";
import { FilePushDialog } from "./file-push-dialog";

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  toastError.mockReset();
});
afterEach(cleanup);

describe("IdeLogDialog", () => {
  it("shows the log as plain text, never as markup", async () => {
    get.mockResolvedValue({
      data: { path: "/var/log/pmide-provision.log", log: "<b>bold</b>\x1b[31m red\x1b[0m", truncated: false, missing: false },
    });
    const { container } = render(<IdeLogDialog vmId="vm1" vmName="web" open onOpenChange={() => {}} />);
    const pre = await screen.findByTestId("ide-log");
    await waitFor(() => expect(pre.textContent).toBe("<b>bold</b> red"));
    expect(get).toHaveBeenCalledWith("/ide/vm1/install-log");
    expect(container.ownerDocument.querySelector("pre b")).toBeNull();
  });

  it("re-reads the log on refresh", async () => {
    get.mockResolvedValue({ data: { path: "/var/log/pmide-provision.log", log: "one", truncated: false, missing: false } });
    render(<IdeLogDialog vmId="vm1" vmName="web" open onOpenChange={() => {}} />);
    await screen.findByText("one");
    get.mockResolvedValue({ data: { path: "/var/log/pmide-provision.log", log: "two", truncated: true, missing: false } });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByText("two")).toBeTruthy();
    expect(screen.getByText(/Older lines are left out/)).toBeTruthy();
  });

  it("says so when there is no log, and shows server errors", async () => {
    get.mockResolvedValueOnce({ data: { path: "/var/log/pmide-provision.log", log: "", truncated: false, missing: true } });
    render(<IdeLogDialog vmId="vm1" vmName="web" open onOpenChange={() => {}} />);
    expect(await screen.findByText(/no install log/i)).toBeTruthy();
    get.mockRejectedValueOnce("Only this VM's owner (or an admin) can read its IDE install log.");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });
});

describe("FilePushDialog", () => {
  const pick = (name: string, size: number) => {
    const file = new File([new Uint8Array(size)], name);
    fireEvent.change(screen.getByTestId("push-file-input"), { target: { files: [file] } });
    return file;
  };

  it("uploads the file with path, mode, owner and create-parents, then shows the result", async () => {
    post.mockResolvedValue({ data: { path: "/etc/app/app.conf", size: 5, sha256: "ab".repeat(32), verified: true } });
    render(<FilePushDialog vmId="vm1" vmName="web" open onOpenChange={() => {}} />);
    pick("app.conf", 5);
    expect((screen.getByLabelText("Destination path") as HTMLInputElement).value).toBe("/root/app.conf");
    fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "/etc/app/app.conf" } });
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "0640" } });
    fireEvent.change(screen.getByLabelText("Owner (optional)"), { target: { value: "ubuntu" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /push file/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, form] = post.mock.calls[0] as [string, FormData];
    expect(url).toBe("/vms/vm1/files");
    expect(form.get("path")).toBe("/etc/app/app.conf");
    expect(form.get("mode")).toBe("0640");
    expect(form.get("owner")).toBe("ubuntu");
    expect(form.get("createParents")).toBe("true");
    expect(await screen.findByTestId("push-result")).toBeTruthy();
  });

  it("refuses a bad path before uploading", () => {
    render(<FilePushDialog vmId="vm1" vmName="web" open onOpenChange={() => {}} />);
    pick("x", 1);
    fireEvent.change(screen.getByLabelText("Destination path"), { target: { value: "/etc/../shadow" } });
    expect(screen.getByText(/\.\. segments/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /push file/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("refuses a file over the server's limit", () => {
    render(<FilePushDialog vmId="vm1" vmName="web" maxBytes={1024} open onOpenChange={() => {}} />);
    pick("big.bin", 2048);
    expect(screen.getByText(/larger than the/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /push file/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
