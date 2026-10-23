import { describe, it, expect, vi } from 'vitest';

// A VM's project tag is its owner's way of organising machines: sharees get the
// plain labels only, through every route that returns a VM.

vi.mock('../src/lib/prisma.js', () => ({
  prisma: {
    vmShare: { findMany: vi.fn(async () => [{ vmId: 'vm-shared', userId: 'u2', role: 'viewer' }]) },
  },
}));

import { tagsForAccess } from '../src/services/project.service.js';
import { annotateAccess } from '../src/services/vm.service.js';

describe('tagsForAccess', () => {
  it('shows the project to the owner and admins only', () => {
    expect(tagsForAccess('web,project:acme', 'owner')).toBe('web,project:acme');
    expect(tagsForAccess('web,project:acme', 'admin')).toBe('web,project:acme');
    expect(tagsForAccess('web,project:acme', 'viewer')).toBe('web');
    expect(tagsForAccess('project:acme', 'manager')).toBeNull();
    expect(tagsForAccess(null, 'viewer')).toBeNull();
  });
});

describe('annotateAccess', () => {
  it("strips the owner's project tag from a shared VM and keeps the caller's own", async () => {
    const rows = [
      { id: 'vm-own', userId: 'u2', tags: 'mine,project:home' },
      { id: 'vm-shared', userId: 'u1', tags: 'db,project:acme-secret' },
    ];
    const out = await annotateAccess(rows, { id: 'u2', role: 'user' });
    expect(out.find((v) => v.id === 'vm-own')?.tags).toBe('mine,project:home');
    const shared = out.find((v) => v.id === 'vm-shared');
    expect(shared?.access).toBe('viewer');
    expect(shared?.tags).toBe('db');
  });
});
