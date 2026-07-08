import { describe, it, expect } from 'vitest';

import {
  parsePciMappingEntry,
  evaluatePassthroughReadiness,
  checkPassthroughHostReadiness,
  type NodePciDevice,
  type PciMappingEntry,
} from '../src/services/proxmox.service.js';
import { fakeClient, asClient } from './helpers.js';

// The live pve-4 layout the design was built against: an NVIDIA GTX 1650
// (0000:01:00.0) + its HDMI-audio function (.1), both in IOMMU group 2, plus the
// host iGPU in group 0.
const GTX_ENTRY: PciMappingEntry = { node: 'pve-4', path: '0000:01:00', id: '10de:1f82', iommugroup: 2 };
const gtxDevices = (): NodePciDevice[] => [
  { id: '0000:00:02.0', class: '0x038000', vendor: '0x8086', device: '0x1912', deviceName: 'HD Graphics 530', iommugroup: 0 },
  { id: '0000:01:00.0', class: '0x030000', vendor: '0x10de', device: '0x1f82', deviceName: 'GTX 1650', iommugroup: 2 },
  { id: '0000:01:00.1', class: '0x040300', vendor: '0x10de', device: '0x10fa', iommugroup: 2 },
];

const q35 = { q35: true, ovmf: true, efidisk: true, warnings: [] as string[] };
const q35NoOvmf = { q35: true, ovmf: false, efidisk: false, warnings: ['BIOS is not OVMF (UEFI).'] };
const seabios = {
  q35: false,
  ovmf: false,
  efidisk: false,
  warnings: ['Machine type is not q35 — the device will be attached as legacy PCI.', 'BIOS is not OVMF (UEFI).'],
};

const hasVfioWarning = (ws: string[]) => ws.some((w) => /bound to vfio-pci/i.test(w));

describe('parsePciMappingEntry', () => {
  it('parses a comma-joined "k=v" string entry', () => {
    const e = parsePciMappingEntry('id=10de:1f82,iommugroup=2,node=pve-4,path=0000:01:00,subsystem-id=1043:86b9');
    expect(e).toEqual({ node: 'pve-4', path: '0000:01:00', id: '10de:1f82', iommugroup: 2, subsystemId: '1043:86b9' });
  });

  it('parses an object-form entry', () => {
    const e = parsePciMappingEntry({ node: 'pve-3', path: '0000:02:00', id: '1002:6613', iommugroup: 5 });
    expect(e).toMatchObject({ node: 'pve-3', path: '0000:02:00', id: '1002:6613', iommugroup: 5 });
  });

  it('returns null without a node or path, and for non-object input', () => {
    expect(parsePciMappingEntry('id=10de:1f82,iommugroup=2')).toBeNull(); // no node/path
    expect(parsePciMappingEntry('node=pve-4')).toBeNull(); // no path
    expect(parsePciMappingEntry(42)).toBeNull();
    expect(parsePciMappingEntry(null)).toBeNull();
  });
});

describe('evaluatePassthroughReadiness — blockers (certain failures)', () => {
  it('blocks when the mapping has no entry for the target node', () => {
    const r = evaluatePassthroughReadiness('pve-4', undefined, gtxDevices(), q35);
    expect(r.ok).toBe(false);
    expect(r.blockers[0]).toMatch(/no device entry for node pve-4/i);
    expect(r.safeToAutoStart).toBe(false);
  });

  it('blocks when the device is not present on the node', () => {
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, [], q35);
    expect(r.ok).toBe(false);
    expect(r.blockers.some((b) => /not present on pve-4/i.test(b))).toBe(true);
    expect(r.safeToAutoStart).toBe(false);
  });

  it("blocks when the device identity no longer matches the mapping", () => {
    const swapped = gtxDevices().map((d) =>
      d.id === '0000:01:00.0' ? { ...d, device: '0x2184' } : d,
    );
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, swapped, q35);
    expect(r.blockers.some((b) => /is now 10de:2184 but the mapping expects 10de:1f82/i.test(b))).toBe(true);
  });

  it('blocks when IOMMU is inactive (group -1) and when the field is absent (null)', () => {
    const off = gtxDevices().map((d) => (d.id === '0000:01:00.0' ? { ...d, iommugroup: -1 } : d));
    expect(evaluatePassthroughReadiness('pve-4', GTX_ENTRY, off, q35).blockers.some((b) => /IOMMU is not active/i.test(b))).toBe(true);

    const noGroup = gtxDevices().map((d) => (d.id === '0000:01:00.0' ? { ...d, iommugroup: null } : d));
    expect(evaluatePassthroughReadiness('pve-4', GTX_ENTRY, noGroup, q35).blockers.some((b) => /IOMMU is not active/i.test(b))).toBe(true);
  });
});

describe('evaluatePassthroughReadiness — warnings (advisory / unverifiable)', () => {
  it('always warns that vfio-pci binding is unverifiable, even on a fully-ready host', () => {
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, gtxDevices(), q35);
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(hasVfioWarning(r.warnings)).toBe(true);
  });

  it('merges the VM boot-readiness warnings (q35 / OVMF)', () => {
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, gtxDevices(), seabios);
    expect(r.warnings.some((w) => /not q35/i.test(w))).toBe(true);
    expect(r.warnings.some((w) => /OVMF/i.test(w))).toBe(true);
  });

  it('warns on IOMMU-group drift since the mapping was created', () => {
    const r = evaluatePassthroughReadiness('pve-4', { ...GTX_ENTRY, iommugroup: 9 }, gtxDevices(), q35);
    expect(r.warnings.some((w) => /group.*changed.*was 9, now 2/i.test(w))).toBe(true);
  });

  it('warns when the IOMMU group is shared with an unrelated device, but not the device\'s own functions', () => {
    const withRoommate: NodePciDevice[] = [
      ...gtxDevices(),
      { id: '0000:02:00.0', class: '0x020000', vendor: '0x8086', device: '0x1533', deviceName: 'I210 NIC', iommugroup: 2 },
    ];
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, withRoommate, q35);
    const shareWarn = r.warnings.find((w) => /also contains/i.test(w));
    expect(shareWarn).toBeDefined();
    expect(shareWarn).toContain('0000:02:00.0');
    expect(shareWarn).not.toContain('0000:01:00.1'); // the GPU's own audio function is not "sharing"
  });
});

describe('evaluatePassthroughReadiness — safeToAutoStart (the pve-4 crash guard)', () => {
  it('is TRUE for a GPU on a q35 + OVMF guest', () => {
    expect(evaluatePassthroughReadiness('pve-4', GTX_ENTRY, gtxDevices(), q35).safeToAutoStart).toBe(true);
  });

  it('is FALSE for a GPU on a non-q35 (legacy BIOS) guest — the first live node-crash combo', () => {
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, gtxDevices(), seabios);
    expect(r.isGpu).toBe(true);
    expect(r.ok).toBe(true); // not a hard blocker — we still attach
    expect(r.safeToAutoStart).toBe(false); // but we do NOT auto-start it
  });

  it('is FALSE for a GPU on q35 but WITHOUT OVMF — the second live node-crash combo', () => {
    const r = evaluatePassthroughReadiness('pve-4', GTX_ENTRY, gtxDevices(), q35NoOvmf);
    expect(r.isGpu).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.safeToAutoStart).toBe(false); // q35 alone isn't enough — needs OVMF too
  });

  it('is TRUE for a non-GPU device on a non-q35 guest (only GPUs are gated)', () => {
    const nic: PciMappingEntry = { node: 'pve-4', path: '0000:03:00', id: '8086:1533', iommugroup: 7 };
    const devices: NodePciDevice[] = [
      { id: '0000:03:00.0', class: '0x020000', vendor: '0x8086', device: '0x1533', deviceName: 'I210 NIC', iommugroup: 7 },
    ];
    const r = evaluatePassthroughReadiness('pve-4', nic, devices, seabios);
    expect(r.isGpu).toBe(false);
    expect(r.safeToAutoStart).toBe(true);
  });
});

describe('checkPassthroughHostReadiness (live-data wrapper)', () => {
  function clientFor(mapEntry: string, devices: NodePciDevice[]) {
    const c = fakeClient();
    c.get.mockImplementation((url: string) => {
      if (url === '/cluster/mapping/pci') {
        return Promise.resolve({ data: { data: [{ id: 'GTX1650', map: [mapEntry] }] } });
      }
      if (url === '/nodes/pve-4/hardware/pci') {
        return Promise.resolve({ data: { data: devices } });
      }
      throw new Error(`unexpected GET ${url}`);
    });
    return c;
  }

  const mapString = 'id=10de:1f82,iommugroup=2,node=pve-4,path=0000:01:00,subsystem-id=1043:86b9';
  // hardware/pci returns snake_case keys; the wrapper normalizes them.
  const hwDevices = (): NodePciDevice[] =>
    gtxDevices().map((d) => ({ ...d, class_name: 'x', device_name: d.deviceName }) as unknown as NodePciDevice);

  it('resolves the mapping entry + node devices and reports a ready q35 host', async () => {
    const c = clientFor(mapString, hwDevices());
    const r = await checkPassthroughHostReadiness('pve-4', 'GTX1650', { machine: 'q35', bios: 'ovmf', efidisk0: 'x' }, asClient(c));
    expect(r.ok).toBe(true);
    expect(r.blockers).toHaveLength(0);
    expect(r.device?.liveId).toBe('10de:1f82');
    expect(r.safeToAutoStart).toBe(true);
    expect(hasVfioWarning(r.warnings)).toBe(true);
  });

  it('flags a GPU on a SeaBIOS guest as attach-but-do-not-auto-start', async () => {
    const c = clientFor(mapString, hwDevices());
    const r = await checkPassthroughHostReadiness('pve-4', 'GTX1650', {}, asClient(c)); // no machine/bios ⇒ i440fx/seabios
    expect(r.ok).toBe(true);
    expect(r.isGpu).toBe(true);
    expect(r.safeToAutoStart).toBe(false);
  });
});
