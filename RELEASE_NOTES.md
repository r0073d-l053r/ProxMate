## Highlights

**The "Migrate to another node" picker now only offers nodes a VM can actually
reach.** Building on v0.6.6 (which stopped the balancer proposing impossible
moves), the manual migrate dialog no longer lets an admin pick a target the guest
can't be migrated to — so you can't kick off a move that's doomed to fail.

## What changed

- **VM Settings → Migrate to another node** now populates its node list from
  Proxmox's own migrate preflight for that specific VM (`allowed_nodes`), via a new
  admin-only `GET /vms/:id/migrate-targets`. If the VM's disks live on node-local
  storage no other node has (e.g. a local ZFS pool), or it has a device that pins
  it to its host, the picker shows **"No eligible nodes"** and explains why, instead
  of listing targets that would 500.
- **Cluster Balancer → Maintenance drain → "Migrate to"** no longer lists offline
  nodes as drain targets. (Per-guest storage eligibility during a drain is a tracked
  follow-up; the balancer's own plans already honor it as of v0.6.6.)
- **Migration errors read clearly.** The manual migrate route now surfaces
  Proxmox's real reason (via `pveMessage`) rather than a raw HTTP status —
  consistent with the balancer fix in v0.6.6.

## Confirmations (no change)

- Migrating a VM between nodes remains **admin-only**: the API rejects non-admins
  with 403, and the control is hidden from tenants in the UI. Tenants can neither
  see nor trigger a migration.

## Upgrade notes

- **No database migrations, no breaking changes, no new environment variables.**
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **498 tests** (+3) — a new `migratableTargets` unit test
  covers reading Proxmox's allowed target nodes, the empty result (nowhere to
  migrate), and the fail-open `null` when the preflight can't be read. Typecheck and
  lint clean on backend and frontend; frontend production build green.
- **Live-verified on the production cluster (musebot):** a VM whose disks sit on a
  node-local ZFS pool returns no eligible targets (empty picker), while a normal VM
  lists its valid nodes.
