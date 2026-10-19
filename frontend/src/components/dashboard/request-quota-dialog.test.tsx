import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";

const get = vi.fn();
const post = vi.fn();
vi.mock("@/lib/api", () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
  apiError: (e: unknown) => (e instanceof Error ? e.message : "error"),
}));

import { RequestQuotaDialog } from "./request-quota-dialog";

afterEach(cleanup);

beforeEach(() => {
  get.mockReset().mockResolvedValue({ data: [] });
  post.mockReset().mockResolvedValue({ data: {} });
});

const quota = (ramMb: number) => ({
  cpu: { used: 0, max: 4 },
  ram: { used: 0, max: ramMb },
  storage: { used: 0, max: 50 },
});

async function openAndSend() {
  fireEvent.click(await screen.findByRole("button", { name: /request more quota/i }));
  fireEvent.click(await screen.findByRole("button", { name: /send request/i }));
  await waitFor(() => expect(post).toHaveBeenCalled());
  return post.mock.calls[0]![1] as { ram: number };
}

describe("RequestQuotaDialog", () => {
  it("keeps a non-GB RAM quota exactly when only other fields are requested", async () => {
    render(<RequestQuotaDialog quota={quota(1536)} />);
    expect((await openAndSend()).ram).toBe(1536);
  });

  it("sends the typed GB value once RAM is changed", async () => {
    render(<RequestQuotaDialog quota={quota(1536)} />);
    fireEvent.click(await screen.findByRole("button", { name: /request more quota/i }));
    fireEvent.change(await screen.findByLabelText("RAM (GB)"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: /send request/i }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect((post.mock.calls[0]![1] as { ram: number }).ram).toBe(4096);
  });
});
