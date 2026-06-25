import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/lib/prisma.js', () => ({ prisma: {} }));

import {
  isCloudInitTemplate,
  setCloudInitConfig,
  primaryDiskSizeGb,
} from '../src/services/proxmox.service.js';
import { fakeClient, asClient, bodyOf } from './helpers.js';

describe('isCloudInitTemplate', () => {
  it('detects a cloud-init drive in the config', () => {
    expect(
      isCloudInitTemplate({
        scsi0: 'local-lvm:vm-1-disk-0,size=2G',
        ide2: 'local-lvm:vm-1-cloudinit,media=cdrom',
      }),
    ).toBe(true);
  });

  it('is false for a plain (ISO-installed) template', () => {
    expect(isCloudInitTemplate({ scsi0: 'local-lvm:vm-1-disk-0,size=8G', net0: 'virtio,bridge=vmbr0' })).toBe(false);
  });
});

describe('primaryDiskSizeGb', () => {
  it('parses GB / MB / TB and rounds up, ignoring the cloud-init cdrom', () => {
    expect(primaryDiskSizeGb({ scsi0: 'local-lvm:vm-1-disk-0,size=20G' })).toBe(20);
    expect(primaryDiskSizeGb({ scsi0: 'local-lvm:vm-1-disk-0,size=2252M' })).toBe(3); // ~2.2G → 3
    expect(primaryDiskSizeGb({ scsi0: 'local-lvm:vm-1-disk-0,size=1T' })).toBe(1024);
    expect(primaryDiskSizeGb({ ide2: 'local-lvm:vm-1-cloudinit,media=cdrom' })).toBe(0);
  });
});

describe('setCloudInitConfig', () => {
  it('sets ciuser/cipassword/ipconfig and URL-encodes sshkeys (the Proxmox quirk)', async () => {
    const c = fakeClient();
    const keys = 'ssh-ed25519 AAAAC3NzaC1 test@laptop';
    await setCloudInitConfig('pve-0', 100, { ciuser: 'matey', cipassword: 'pw', sshKeys: keys, ipConfig: 'ip=dhcp' }, asClient(c));

    expect(c.put).toHaveBeenCalledWith('/nodes/pve-0/qemu/100/config', expect.any(URLSearchParams));
    const body = bodyOf(c.put.mock.calls[0]!);
    expect(body.ciuser).toBe('matey');
    expect(body.cipassword).toBe('pw');
    expect(body.ipconfig0).toBe('ip=dhcp');
    // sshkeys must be URL-encoded by us (Proxmox un-escapes it) — spaces become %20.
    expect(body.sshkeys).toBe(encodeURIComponent(keys));
  });

  it('defaults ipconfig0 to dhcp and omits unset fields', async () => {
    const c = fakeClient();
    await setCloudInitConfig('pve-1', 7, { sshKeys: 'ssh-rsa AAAA' }, asClient(c));
    const body = bodyOf(c.put.mock.calls[0]!);
    expect(body.ipconfig0).toBe('ip=dhcp');
    expect(body.ciuser).toBeUndefined();
    expect(body.cipassword).toBeUndefined();
  });

  it('attaches a vendor snippet as cicustom=vendor=<volid> (merges, does not replace user-data)', async () => {
    const c = fakeClient();
    await setCloudInitConfig(
      'pve-0',
      5,
      { ciuser: 'me', sshKeys: 'ssh-rsa AAAA', vendorSnippet: 'local:snippets/proxmate-docker.yaml' },
      asClient(c),
    );
    const body = bodyOf(c.put.mock.calls[0]!);
    expect(body.cicustom).toBe('vendor=local:snippets/proxmate-docker.yaml');
    expect(body.ciuser).toBe('me'); // user-data still applied
  });

  it('omits cicustom when no vendor snippet is given', async () => {
    const c = fakeClient();
    await setCloudInitConfig('pve-0', 5, { sshKeys: 'ssh-rsa AAAA' }, asClient(c));
    expect(bodyOf(c.put.mock.calls[0]!).cicustom).toBeUndefined();
  });
});
