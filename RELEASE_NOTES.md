## Highlights

**A safer path to GPU / PCI passthrough, and a much richer cloud-init story.**
Two big pieces land in v0.6.2:

- A **pre-flight host-readiness check** now runs before an admin approves a
  passthrough request. Passthrough is the one feature that can hard-crash a
  Proxmox node if the host underneath isn't prepared, so ProxMate now inspects
  what it can see over the API and refuses the approvals that would wedge a node —
  instead of finding out the hard way at first boot.
- The **cloud-init extras** system was rebuilt into an admin-configurable catalog
  with an always-on base layer, four new install options, and — the important part
  — **ProxMate now writes the cloud-init snippet for you at deploy time**, so the
  extras work out of the box without hand-placing YAML files on every node.

## Passthrough pre-flight host-readiness check

GPU/PCI passthrough requires the host itself to be prepared (IOMMU on in the
kernel, the device bound to `vfio-pci`, the guest booting under q35 + OVMF). Get
it wrong and starting the VM can hang the whole node until a physical power-cycle.
ProxMate is API-only and can't do the host-side setup for you — but it *can* now
check the parts that are visible over the API and warn about the parts that aren't.

When an admin goes to approve a passthrough request, ProxMate evaluates:

- **Hard blockers (approval is refused):** the mapped device no longer exists on
  the target node, the device's PCI identity doesn't match what was mapped
  (vendor/device ID drift), or IOMMU is off on the node. These make passthrough
  impossible or actively dangerous, so the approval stops with a clear reason.
- **Warnings (approval proceeds, but you're told):** the `vfio-pci` binding can't
  be confirmed over the API, the guest isn't set to q35 + OVMF, or the device
  shares an IOMMU group with other devices. These are the "you probably still have
  host work to do" cases.
- **Auto-start guard:** even when an approval goes through, ProxMate will **not
  automatically start a GPU-class device unless the guest is q35 AND OVMF**. This
  is the specific combination that hangs the host on teardown, so it's gated
  rather than warned. Boot settings are only ever flagged — never silently
  rewritten under your VM.

There's an in-app explanation of what the check does and why, aimed at admins who
are new to passthrough.

## Cloud-init extras: rebuilt, configurable, and self-provisioning

### On-demand snippet writing (no more hand-placed YAML)

Proxmox's API can upload ISOs and container templates, but it **cannot** create
cloud-init vendor snippets — which previously meant an admin had to manually place
a YAML file on the node for each combination of extras. ProxMate now writes the
combined snippet itself, at deploy time, to a shared snippet storage:

- Point ProxMate at a snippets directory that's mounted into the container and
  backed by a storage all nodes can read (an NFS export is the natural fit), via
  the new `SNIPPET_DIR` and `SNIPPET_STORAGE` environment variables.
- On each deploy it composes exactly the selected features into one snippet file,
  writes it atomically (temp file + rename), and reuses it if an identical one
  already exists — no duplicates, no leftover temp files.
- **If you don't configure it, nothing breaks:** ProxMate transparently falls back
  to the previous behavior (manual pre-placement), so existing installs keep
  working unchanged.

### An always-on base layer plus a configurable catalog

- **Always-on base:** admins can nominate a set of features that are installed on
  **every** new cloud-init guest automatically (fail2ban, unattended-upgrades, and
  btop are the recommended starting set). These are applied on top of whatever the
  tenant picks.
- **Offered extras:** admins choose which optional features tenants see as
  checkboxes in the deploy wizard (Docker, Tailscale, QEMU guest agent, and the
  new tools below).
- Both the base layer and the offered list are configurable in **two** places: a
  new step in the **setup wizard** (so a fresh install is opinionated out of the
  box) and the **Template Store** (to change it later). The manual, searchable
  snippet picker is still there in both modes for anyone who wants full control.

### New install options

Four new cloud-init features join Docker / Tailscale / QEMU guest agent:

- **Cockpit** — web-based server management console.
- **Netdata** — real-time per-second metrics dashboard.
- **Caddy** — automatic-HTTPS web server / reverse proxy (installed from the
  official Cloudsmith apt repo).
- **code-server** — VS Code in the browser (pinned release `.deb`).
- **Superfile** — a fast terminal file manager (pinned GitHub release), replacing
  the previously experimented-with Warp terminal, which was dropped because it's a
  GUI-desktop app and made no sense on a headless cloud VM.

All install content is pinned to specific versions and uses distro package
managers where possible, rather than piping unpinned remote install scripts.

## Fixes

- **Template Store "Cloud-init extras" took minutes to load — now milliseconds.**
  The old listing computed every possible combination of features (2ⁿ) and made
  per-node API calls for each, which ballooned as options were added. It now
  short-circuits when on-demand writing is configured and, otherwise, does a single
  batched listing per node. Measured load time dropped from minutes to ~60 ms.
- **Fixed a Template Store crash after saving an extras selection.** Saving posted
  a partial config back and the card tried to render it as if it were the full
  payload (`Cannot read properties of undefined (reading 'find')`). It now re-fetches
  the full state after saving and guards against a missing bundles list.

## Upgrade notes

- **No database migrations, no breaking changes.**
- **New, optional environment variables — `SNIPPET_DIR` and `SNIPPET_STORAGE`.**
  Set both to enable on-demand snippet writing: `SNIPPET_DIR` is the in-container
  path to a snippets directory, and `SNIPPET_STORAGE` is the Proxmox storage ID
  that backs it (the storage must have the `snippets` content type enabled and be
  readable by every node — a shared/NFS export is the natural choice). Mount the
  same underlying directory into the backend container. **If you leave these unset,
  ProxMate falls back to manual snippet pre-placement exactly as before.**
- After updating, visit **Template Store → Cloud-init extras** (or re-run the setup
  wizard's defaults step) to choose your always-on base layer and the extras
  offered to tenants. Fresh installs are prompted for this during setup.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **479 tests** (+36 since v0.6.1) — the passthrough
  readiness evaluator (device/identity/IOMMU blockers, vfio/boot/IOMMU-group
  warnings, and the q35+OVMF auto-start guard), the begin-refuses-on-blocker and
  attach-but-don't-auto-start request paths, and the cloud-init catalog work
  (js-yaml-parsed snippet content for every new feature, plus the atomic /
  idempotent / no-leftover-temp / unconfigured-fallback behavior of on-demand
  snippet writing). Typecheck and lint clean on backend and frontend; frontend
  production build green.
- **Live-verified on the production cluster:** the pre-flight check was hardened
  against two real node wedges during GPU bring-up (the origin of the q35+OVMF
  guard), the on-demand snippet write path was exercised end-to-end against a real
  NFS-backed snippet storage, and the rebuilt Template Store extras UI (perf fix +
  crash fix) was confirmed live.
