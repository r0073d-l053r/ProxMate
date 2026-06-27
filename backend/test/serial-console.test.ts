import { describe, it, expect } from 'vitest';

// proxmox.service → config.service → prisma constructs a client at import; stub it.
import { vi } from 'vitest';
vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import { hasSerialConsole } from '../src/services/proxmox.service.js';
import { requestTermProxy } from '../src/services/vnc-proxy.service.js';
import { fakeClient, asClient } from './helpers.js';

describe('hasSerialConsole (text-console capability)', () => {
  it('is true when a serial port is present (cloud-init VMs)', () => {
    expect(hasSerialConsole({ serial0: 'socket', vga: 'std', scsi0: 'local:vm-100-disk-0' })).toBe(true);
  });

  it('is true for a non-zero serial index', () => {
    expect(hasSerialConsole({ serial1: 'socket' })).toBe(true);
  });

  it('is false when no serial port exists (typical ISO VM)', () => {
    expect(hasSerialConsole({ vga: 'std', scsi0: 'local:vm-101-disk-0', net0: 'virtio=AA:BB' })).toBe(false);
  });

  it('does not match unrelated keys that merely contain "serial"', () => {
    expect(hasSerialConsole({ smbios1: 'serial=ABC123' })).toBe(false);
  });
});

describe('requestTermProxy', () => {
  it('POSTs to the node termproxy endpoint and maps ticket/port/user', async () => {
    const c = fakeClient();
    c.post.mockResolvedValue({ data: { data: { ticket: 'PVEVNC:tok', port: 5900, user: 'root@pam' } } });

    const res = await requestTermProxy('pve-2', 104, asClient(c));

    expect(c.post.mock.calls[0]![0]).toBe('/nodes/pve-2/qemu/104/termproxy');
    expect(res).toEqual({ ticket: 'PVEVNC:tok', port: '5900', user: 'root@pam' });
  });
});
