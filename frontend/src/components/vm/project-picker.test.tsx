import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";

const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => String(e),
}));
const success = vi.fn();
const error = vi.fn();
vi.mock("sonner", () => ({
  toast: { success: (...a: unknown[]) => success(...a), error: (...a: unknown[]) => error(...a) },
}));

import { ProjectPicker } from "./project-picker";

beforeEach(() => {
  post.mockReset();
  success.mockReset();
  error.mockReset();
});
afterEach(cleanup);

describe("ProjectPicker (Move to project…)", () => {
  it("moves the selected VMs into the typed project", async () => {
    post.mockResolvedValue({ data: { project: "shop", results: [{ id: "a", ok: true }, { id: "b", ok: true }] } });
    const onDone = vi.fn();
    render(<ProjectPicker ids={["a", "b"]} suggestions={["shop"]} onDone={onDone} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: " Shop " } });
    fireEvent.click(screen.getByRole("button", { name: /Move/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/assign", { ids: ["a", "b"], project: "shop" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("shop"));
    expect(success).toHaveBeenCalledWith("Moved to shop: 2 VMs.");
  });

  it("removes the VMs from their project", async () => {
    post.mockResolvedValue({ data: { project: null, results: [{ id: "a", ok: true }] } });
    render(<ProjectPicker ids={["a"]} current="shop" onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Remove from project/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/projects/assign", { ids: ["a"], project: null }));
  });

  it("refuses an invalid name without calling the API", () => {
    render(<ProjectPicker ids={["a"]} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "bad name!" } });
    fireEvent.click(screen.getByRole("button", { name: /Move/ }));
    expect(post).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it("reports VMs the caller doesn't own", async () => {
    post.mockResolvedValue({ data: { project: "shop", results: [{ id: "a", ok: true }, { id: "b", ok: false, error: "not found" }] } });
    render(<ProjectPicker ids={["a", "b"]} onDone={() => {}} />);
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "shop" } });
    fireEvent.click(screen.getByRole("button", { name: /Move/ }));
    await waitFor(() => expect(success).toHaveBeenCalledWith("Moved to shop: 1 VM, 1 not yours to move."));
  });
});
