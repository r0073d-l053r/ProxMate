import { vi } from 'vitest';
import type { AxiosInstance } from 'axios';

/**
 * A fake axios-like client whose verbs are vi mocks. Services in this project
 * all accept an optional `client` argument, so passing one of these lets us
 * unit-test the request-building logic without any network or real Proxmox.
 *
 * Defaults: post/put/delete resolve to a Proxmox-shaped `{ data: { data } }`
 * envelope (a UPID for posts). Override `.get` per test with mockResolvedValue.
 */
export function fakeClient() {
  return {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ data: { data: 'UPID:fake' } }),
    put: vi.fn().mockResolvedValue({ data: { data: '' } }),
    delete: vi.fn().mockResolvedValue({ data: { data: '' } }),
  };
}

export type FakeClient = ReturnType<typeof fakeClient>;

/** Cast a fake client to AxiosInstance for passing into the services. */
export function asClient(c: FakeClient): AxiosInstance {
  return c as unknown as AxiosInstance;
}

/** Read the URLSearchParams body (2nd arg) of a recorded mock call as a plain object. */
export function bodyOf(call: unknown[]): Record<string, string> {
  const body = call[1];
  if (body instanceof URLSearchParams) return Object.fromEntries(body);
  return {};
}

export const GB = 1024 ** 3;
