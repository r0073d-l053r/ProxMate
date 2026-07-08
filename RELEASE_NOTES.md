## Highlights

**The Cluster Balancer no longer proposes migrations that can't succeed** — and when
a migration does fail, you now see the real reason.

If a VM's disks live on **node-local storage that no other node has** (for example a
local ZFS pool like `tank`), Proxmox can't migrate it anywhere. The balancer used to
rank VMs purely by memory load and would keep suggesting such a move, which failed
every time with an opaque *"Request failed with status code 500"*. This release
teaches the balancer to skip un-migratable guests, and makes migration failures
report Proxmox's actual explanation.

## What changed

- **Migratability-aware planning.** Before building a plan, the balancer now asks
  Proxmox — via its own migrate preflight (`allowed_nodes`) — which nodes each
  running, otherwise-movable guest can actually go to. A VM with nowhere to land is
  pinned (never proposed for a move), and the planner will never target a node a VM
  can't reach. This is fail-open: if the preflight can't be read, the VM stays
  movable and the apply step re-validates, so nothing that used to work is blocked.
- **Real failure reasons.** Failed migrations (balancer apply and node drain) now
  record Proxmox's actual message — e.g. *"storage 'tank' is not available on node
  'pve-3'"* — instead of the generic HTTP status. The reason shows in the Audit Log
  and the apply result.

## Notes

- The **node drain** planner can still *propose* an evacuation for a guest that's
  pinned to node-local storage; its apply now surfaces the real reason, and teaching
  drain the same migratability guard is a tracked follow-up.
- To make a node-local-storage VM balanceable, move its disk onto shared storage
  (e.g. an NFS/Ceph pool every node can see).

## Upgrade notes

- **No database migrations, no breaking changes, no new environment variables.**
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **495 tests** (+2) — the planner now proves it will not
  propose a move to a node outside a guest's allowed set, and still moves a guest
  when the target *is* allowed. Existing balancer/drain integration tests updated for
  the new preflight call. Typecheck and lint clean on backend and frontend; frontend
  production build green.
- **Live-verified on the production cluster (musebot):** a VM whose disks sit on a
  node-local ZFS pool (`allowed_nodes: []`) is now correctly pinned and absent from
  the computed plan, where it previously produced a repeating, always-failing move.
