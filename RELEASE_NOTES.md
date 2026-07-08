## Highlights

**Fixes the tenant deploy wizard hiding admin-offered cloud-init extras.** After
v0.6.2 made the cloud-init catalog admin-configurable, an admin could enable new
options (Cockpit, Caddy, Netdata, code-server, …) under **Template Store →
Cloud-init extras → Options offered to tenants**, but tenants creating a VM would
still only see the three original checkboxes (Docker, Tailscale, Superfile). This
release makes the wizard show every offered feature when on-demand snippet writing
is configured.

## What was wrong

The tenant new-VM wizard reads a lightweight status endpoint to decide which
extras to show. That endpoint was never made aware of **on-demand snippet
writing** (`SNIPPET_DIR`/`SNIPPET_STORAGE`): it reported which
`proxmate-<feature>.yaml` files were physically pre-placed on the template's node,
and the wizard then hid any offered feature whose file wasn't already there.

In on-demand mode ProxMate writes the exact snippet at deploy time, so nothing is
pre-placed — only features that happened to have a leftover snippet file on the
node (typically the three original options from earlier use) passed the filter.
Newly offered features were silently filtered out, even though the deploy path
itself fully supported them.

## What changed

- **The status endpoint is now on-demand-aware.** When on-demand snippet writing
  is configured it reports `onDemand: true` and returns every offered feature
  (plus the always-on base), with no per-node file check — and it skips the
  storage/node listing entirely, so it's a cheaper call too.
- **The wizard respects it.** In on-demand mode it renders all offered features
  and treats any combination as deploy-ready (ProxMate writes whatever combo the
  tenant selects). The manual-placement fallback is unchanged: without on-demand
  writing, features still gate on the snippet being present on the node.

No change was needed to the deploy path — it already validated the tenant's
selection against the admin-offered set, layered on the always-on base, and wrote
the combined snippet on demand.

## Upgrade notes

- **No database migrations, no breaking changes, no new environment variables.**
- If you configure on-demand snippet writing (`SNIPPET_DIR` + `SNIPPET_STORAGE`),
  tenants will now see the full set of features you enable under **Template Store →
  Cloud-init extras**. No action required beyond updating.
- Standard update: **Admin → Settings → Updates → Install update**, or pull + rebuild
  (`docker compose up -d --build`).

## Verification

- Backend suite green: **483 tests** (+2) — a new `cloud-init-status` test asserts
  that on-demand mode returns every admin-offered feature with no per-node gating
  and without any Proxmox call (the exact regression), plus a manual-fallback
  sanity check. Typecheck and lint clean on backend and frontend; frontend
  production build green.
- Live-verified on the production cluster: with `SNIPPET_STORAGE` configured, the
  deploy wizard now lists all offered extras (Cockpit / Caddy / Netdata /
  code-server alongside Docker / Tailscale / Superfile) for a tenant account.
