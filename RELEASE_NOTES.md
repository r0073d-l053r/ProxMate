## Highlights

ProxMate gets a real installer, and a long-standing bug that made plain-HTTP
deployments unusable is fixed.

- **`install.sh` — one command from a clean machine to the setup wizard.**
  Preflight checks, a generated `ENCRYPTION_KEY`, a correct `.env` for either an
  HTTP trial or an HTTPS domain, and the build. It stops at the browser wizard on
  purpose.
- **Fixed: plain-HTTP deployments could not load the UI.** Every release since
  v0.6.8 sent `upgrade-insecure-requests` unconditionally, which made the browser
  rewrite the application's own CSS and JavaScript to `https://`. Without an HTTPS
  reverse proxy in front, the interface never rendered.
- **The migrate dialog now says why a VM cannot move**, instead of showing an
  empty list, and a new admin diagnostic explains why automatic placement keeps
  choosing the same node.
- **Optional settings documented in `.env` now actually take effect** under Docker.

No breaking changes. Upgrading from v0.8.6 is a normal update.

## A real installer

Until now there were two documented paths: edit `.env` by hand and run
`docker compose up -d --build`, or point an agent at `DEPLOY_WITH_CLAUDE.md`. The
hand-editing is where installs break, and it is easy to get wrong in ways that are
expensive to undo.

```bash
curl -fsSLO https://raw.githubusercontent.com/r0073d-l053r/ProxMate/main/install.sh
less install.sh
bash install.sh
```

One question — HTTP trial, or HTTPS domain — and it handles the rest:

- **Preflight that checks what actually fails.** Not merely whether Docker is
  installed, but whether the daemon is reachable at all (being outside the
  `docker` group is the most common first-run failure), whether Compose is v2, and
  whether there is enough memory for the frontend build, which otherwise gets
  OOM-killed and surfaces as an unrelated-looking Compose error.
- **`--local` detects your LAN address** instead of assuming `localhost`, because
  a headless server is almost always browsed from a different machine.
- **`--domain` validates the hostname.** A URL, a `host:port`, or a bare IP is
  rejected with an explanation — certificates and passkeys both need a real DNS
  name, and an IP would otherwise fail much later with an opaque browser error.
- **It never overwrites an existing `.env`,** so your `ENCRYPTION_KEY` is
  preserved. Pointing an existing install at a different origin stops with
  instructions rather than proceeding, because `NEXT_PUBLIC_*` values are baked
  into the frontend at build time and a silent rebuild would produce a stack still
  calling the old origin.
- **It stops at the setup wizard.** The Proxmox API token is entered in the
  browser, never as a shell argument where it would land in shell history and the
  process list.

It is deliberately **not** a `curl | sudo bash` one-liner. ProxMate ends up
holding a Proxmox token that is effectively root on your cluster, so "download,
read, then run" is the right habit for this particular software.

Flags: `--local`, `--host`, `--domain`, `--dir`, `--ref`, `--no-start`, `--yes`.

**`DEPLOY_WITH_CLAUDE.md` is unchanged and still supported.** If you would rather
have a coding agent walk your deployment — reading your environment, adapting as
it goes — that route remains a first-class option. The installer is for people who
want the same result every time; the runbook is for people who want a
conversation. Neither replaces the other.

## Fixed: the interface could not load over plain HTTP

The Content-Security-Policy included `upgrade-insecure-requests` on every
response. On an HTTPS deployment that is useful hardening. On a plain-HTTP one it
is fatal: the browser rewrites **the page's own** script, style, and font URLs to
`https://`, nothing is listening on port 3000 over TLS, and every asset fails with
`ERR_SSL_PROTOCOL_ERROR` before the application can render.

This affected every release from **v0.6.8 through v0.8.6**. It was invisible to
anyone running behind an HTTPS reverse proxy, which is the documented production
setup — but it meant a quick HTTP trial on a LAN address could never work at all.

The directive is now sent only when the public origin really is HTTPS, determined
from `NEXT_PUBLIC_SITE_URL` (which the operator controls, so a client cannot forge
it) and falling back to `X-Forwarded-Proto` or the request scheme when that is
unset. `NEXT_PUBLIC_SITE_URL` is now also passed to the frontend at runtime, not
only as a build argument.

**If you pin `CSP_CONNECT_SRC` in `.env`, wrap the whole value in double quotes:**

```
CSP_CONNECT_SRC="'self' https://proxmate.example.com wss://proxmate.example.com"
```

Docker Compose ends a value at the closing quote it opened, so the previously
documented unquoted form collapsed to just `self` — dropping your API origin, and
dropping the quotes that make `'self'` a CSP keyword rather than a hostname. The
example in `.env.docker.example` showed the broken form and has been corrected.

## Why a VM cannot migrate, and why placement keeps picking one node

Proxmox reports a per-node reason when it refuses a migration, but ProxMate read
only the list of allowed targets and discarded the explanations. When that list
came back empty — which is common — the dialog could only say "no eligible
nodes": true, and useless.

The migrate dialog now shows the actual reason per node, for example
*"pve-1 — storage not available there: tank"*. Containers and guests with PCI
passthrough now explain why they are ineligible instead of presenting an empty
list.

Alongside it, **`GET /admin/placement-diagnostics`** reports which nodes actually
hold your configured ISO storage and disk pool, the resulting candidate set, and
whether placement is effectively **pinned** to a single node — with the remedy.

This matters more than it sounds. Automatic placement filters candidates to nodes
that have both the install image and the configured disk pool. If either lives on
node-local storage, the candidate set silently collapses to one node and the
scheduler never gets to compare load at all — so a cluster can look like it is
ignoring its own balancing while the scoring code is working perfectly. That
condition is now visible from the admin API instead of requiring an SSH session.

## Administrative settings changes are now recorded

`PUT /admin/settings/defaults` wrote no audit entry — the only admin route without
one. The default storage set there decides where every future VM is placed, so it
could be changed with no record of who did it or when. It now writes an audit
entry with a before-and-after diff.

## Docker: documented settings now actually work

`docker-compose.yml` never forwarded several variables the documentation told you
to set, so under Docker they silently did nothing:

- `SNIPPET_DIR`, `SNIPPET_STORAGE` — on-demand cloud-init snippet writing
- `BACKUP_DOWNLOAD_DIR`, `RESTORE_UPLOAD_MAX_GB` — guest backup download and restore
- `MATESTATE_CRON`, `ACCESS_EXPIRY_CRON` — background job schedules

All six are now passed through, with commented mount stubs for the two that are
**container** paths. A folder created on the host is unreachable unless it is
mounted in, and changing a mount requires `docker compose up -d backend` rather
than a plain restart.

## Documentation corrections

A read-through of the deployment documentation against the actual code found a
number of claims that had drifted:

- The quickstart implied `cp .env.docker.example .env` and straight on to
  `docker compose up`. The example ships with its **production** block active,
  pointing at `proxmate.example.com` and bound to `127.0.0.1`, so following it
  verbatim builds a frontend that calls a domain you do not own, on ports only
  reachable from the machine itself. This is now called out explicitly.
- Tenant network isolation was described as unconditional. It does nothing until
  the **Proxmox cluster firewall is enabled**, which is now stated everywhere it
  appears.
- Kiosk mode was still documented as having power controls. It has been
  monitoring-only since v0.8.6.
- Share levels were documented under old internal names rather than the shipped
  **Viewer / Operator / Manager**.
- The cloud image count was wrong — 20 ship, 16 x86-64 and 4 ARM64 — and
  Share-a-VM, compute access windows, app-database backups, personal API tokens,
  and admin deploy-for-tenant were missing from the feature list entirely.
- `ENCRYPTION_KEY` guidance now states plainly that a database backup without an
  off-host copy of the key restores nothing.

## Also in this release

- **`.gitattributes`** pins LF line endings for shell scripts, container
  entrypoints, Dockerfiles and YAML. There was none, so the bytes committed for
  `install.sh` depended on each contributor's local git configuration — and a CRLF
  copy dies on its first executable line with
  `set: pipefail: invalid option name`, where the stray carriage return is
  invisible in the error message.
- The README banner was redrawn to match the application's actual aesthetic.

## Upgrade notes

Upgrading from v0.8.6 is a normal update. There are no schema changes beyond what
the backend applies automatically on boot, and no configuration changes are
required.

```bash
git pull
docker compose up -d --build
```

Two things worth checking:

1. **If you set `CSP_CONNECT_SRC` in `.env`,** wrap the value in double quotes as
   shown above. If you previously used the unquoted form it was silently reduced
   to `self`, so this is a repair rather than a change in behaviour.
2. **If you run over plain HTTP,** the interface should now load. It could not
   before.

## Verification

- Backend: 730 tests across 84 files, plus typecheck and lint.
- Frontend: lint, production build, and the Playwright smoke suite.
- CodeQL, Trivy, `npm audit`, and SBOM generation all pass.
- `install.sh` was run end to end on a clean Ubuntu 24.04.4 machine with Docker
  29.7.1 and Compose 5.3.1: preflight, LAN address detection, clone and ref
  resolution, `.env` generation at mode 600, both image builds, database
  migrations, the health wait, and the served interface and API were all verified,
  including asset loading and CORS from a second machine.

Stated plainly, because it is worth knowing: the `--domain` path has **not** yet
been exercised against a real reverse proxy and certificate, and re-running the
installer over an install that already holds data has not been tested.
