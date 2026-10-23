import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { post: (...a: unknown[]) => post(...a), get: vi.fn() },
  apiError: (e: unknown) => String(e),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), message: vi.fn() } }));
vi.mock("./console-top-bar", () => ({
  ConsoleTopBar: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

const instances: Array<{ url: string; options: { shared?: boolean }; viewOnly: boolean }> = [];
vi.mock("@novnc/novnc", () => ({
  default: class {
    viewOnly = false;
    scaleViewport = false;
    showDotCursor = false;
    background = "";
    constructor(_el: Element, public url: string, public options: { shared?: boolean }) {
      instances.push(this as never);
    }
    addEventListener() {}
    disconnect() {}
  },
}));

import { VncConsole } from "./vnc-console";

beforeEach(() => {
  instances.length = 0;
  post.mockReset();
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});
afterEach(cleanup);

describe("VncConsole", () => {
  it("opens a view-only, shared noVNC session when the server says view-only", async () => {
    post.mockResolvedValue({ data: { ticket: "PVEVNC:t", port: "5900", viewOnly: true } });
    render(<VncConsole id="vm1" mode="graphical" onModeChange={() => undefined} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0]!.viewOnly).toBe(true);
    expect(instances[0]!.options.shared).toBe(true);
    expect(await screen.findByText("View only")).toBeTruthy();
    expect(screen.queryByText("Paste")).toBeNull();
    expect(screen.queryByText("Ctrl+Alt+Del")).toBeNull();
  });

  it("keeps the interactive console unchanged otherwise", async () => {
    post.mockResolvedValue({ data: { ticket: "PVEVNC:t", port: "5900", viewOnly: false } });
    render(<VncConsole id="vm1" mode="graphical" onModeChange={() => undefined} />);
    await waitFor(() => expect(instances).toHaveLength(1));
    expect(instances[0]!.viewOnly).toBe(false);
    expect(screen.queryByText("View only")).toBeNull();
    expect(screen.getByText("Paste")).toBeTruthy();
  });
});
