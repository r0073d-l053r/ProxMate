## Highlights

A fix release, and one of the fixes is the kind worth reading about: on some
installs the nightly backup of ProxMate's own database had never once succeeded,
and nothing said so.

- **The installer now installs what your machine is missing** — Docker, Compose
  v2, git, curl, openssl — after asking. Declining changes nothing.
- **Fixed: app-database backups could fail silently, forever.** Any install done
  with `sudo` left the backup directory unwritable by the container. The job ran
  every night at 02:30, failed, and reported nothing.
- **Fixed: migrations that Proxmox permits but the guest cannot survive** are now
  refused, with the reason and the way round it.
- **Fixed: an HTTPS deployment could silently lose `upgrade-insecure-requests`**
  depending on how its image was built.

No breaking changes. Upgrading from v0.9.0 is a normal update.

## The installer installs what's missing

Previously it stopped at "docker is not installed" with a link to Docker's
documentation. For a command shared publicly that is the most likely first
failure, and it handed a newcomer three more guides to read before they could
try the product.

It now detects everything missing in one pass, explains what each piece is for,
and offers to install it:

```
! ProxMate needs some things this machine doesn't have yet:

    Docker engine        runs ProxMate's two containers
    Docker Compose v2    builds and orchestrates them
    git                  fetches the ProxMate source

  These are required — ProxMate is a containerised application and cannot
  run without them. Nothing here is optional or cosmetic.

  Install them now? [y/N]:
```

Declining is a first-class outcome, not an error path: it says why they are
required, confirms **nothing on the machine was changed**, points at the official
documentation, and exits.

Docker is installed through Docker's own `get.docker.com`, downloaded to a file
whose path is printed before it runs — never piped into a root shell. That is the
same reasoning that keeps the installer from being a `curl | sudo bash` one-liner,
and it matters more here than usual, because ProxMate ends up holding a Proxmox
token that is effectively root on your cluster.

Debian, Ubuntu, Fedora, RHEL, CentOS and Rocky go through `get.docker.com`.
openSUSE and Alpine use their own repositories, because `get.docker.com` rejects
them outright. **Arch deliberately stops** and prints the two commands to run:
installing there without a full system upgrade is the partial-upgrade state Arch
declares unsupported, and turning the installer into an unattended `pacman -Syu`
of someone else's machine is not acceptable.

Installing Docker guarantees the very next check fails, because group membership
only applies to new sessions. The installer adds you to the `docker` group and
continues in the same session rather than telling you to log out and back in.

## Fixed: app-database backups could fail silently, forever

**Check this one if you installed with `sudo`.**

ProxMate backs up its own database nightly. The backup directory is bind-mounted
into the backend container, which drops to the unprivileged `node` user before it
runs anything. If that directory was created by root — which is exactly what
`sudo bash install.sh`, or a hand-rolled `mkdir`, produces — `node` cannot write
to it.

What made this bad is how quiet it was. The backup service logs a warning and
returns; the scheduler only logs successes; the admin API reports the configured
directory with no last-run status. So the job failed at 02:30 every night and
nothing surfaced it. Meanwhile the installer printed a cheerful
`+ created ./backups`.

The fix is in the container entrypoint, which already runs as root to make the
data volume writable: it now does the same for the backup directory. That covers
**every** install path, including hand-rolled ones, not just the installer's.
It is deliberately non-recursive — the directory holds your existing snapshots
and a recursive `chown` of someone's backup archive is not ours to perform — and
non-fatal, since a read-only (`:ro`) mount is a legitimate deliberate setup.

The installer additionally works out who is really running it (via `SUDO_USER`)
and hands back the checkout, the `.env` and the backup directory, so you can read
the `ENCRYPTION_KEY` you are told to back up, and run the compose commands it
prints, without `sudo`.

**After upgrading, confirm a backup actually lands.** If the directory is still
root-owned from before, the entrypoint corrects it on the next container start.

## Fixed: migrations that crash the guest

Proxmox will happily permit two migrations that break the guest. Both are now
refused, with the reason.

**A running guest configured `cpu: host` cannot cross CPU models.** That setting
hands the guest the host's CPUID verbatim. Live-migrating it to a node with a
different CPU pulls features out from under a kernel already running on them, and
the next instruction needing a missing one takes a fatal exception. On a mixed
cluster this kills the guest mid-flight. The migrate dialog now says:

> different CPU model (…) and this guest uses cpu=host — a live migration would
> crash it. Stop the guest first, then it can move here safely.

Note the second sentence: this is refused **only while the guest is running**. A
stopped guest cold-boots on the target perfectly happily, so the restriction
lifts rather than pretending the node is permanently ineligible.

**A guest whose cloud-init `cicustom` snippet lives on a node-restricted storage
migrates fine and then cannot be started.** A running guest never re-reads that
file, so Proxmox sees no obstacle — and the damage stays invisible until someone
stops the guest, possibly weeks later, with no apparent connection to the move.
Proxmox's own preflight does not consider `cicustom` at all.

Both checks **fail open**: an unreadable config, an undetectable CPU model, or a
storage the cluster does not report all leave the node allowed. Wrongly pinning a
guest is worse than a warning that was not given.

Because the cluster balancer and node-drain resolve their targets through the
same code, they inherit this automatically — which is the point. With the
balancer in automatic mode, these migrations would otherwise have been performed
on tenant VMs on a schedule, unattended.

## Fixed: HTTPS deployments could lose `upgrade-insecure-requests`

v0.9.0 stopped sending this directive on plain-HTTP deployments, which was
correct — it rewrites the page's own CSS and JavaScript to `https://` and nothing
is listening there. But it decided that from `NEXT_PUBLIC_SITE_URL`, and Next
**inlines** `NEXT_PUBLIC_*` at build time. The value in play was therefore
whatever was baked in as a build argument, and `docker-compose.yml` defaults that
to `http://localhost:3000`. An operator running HTTPS who never set the build
argument got an image that silently omitted the directive — and could not fix it
by editing `.env`, only by rebuilding.

It is now decided per request from the scheme the browser actually used:
`X-Forwarded-Proto` first (set by any reverse proxy, and correct regardless of
build arguments), then `NEXT_PUBLIC_SITE_URL`, then the request's own scheme.

## Also in this release

- **`.env.*` is now ignored.** The installer writes its new `.env` through
  `mktemp .env.XXXXXX` inside the checkout it just cloned, and that temp file
  holds a freshly generated `ENCRYPTION_KEY`. The cleanup trap removes it on any
  ordinary exit, but a `SIGKILL`, an out-of-memory kill or a power loss left it
  behind — untracked, in a git tree, one `git add -A` from being published.
- **Better failure messages** for the situations people actually hit: `usermod`
  lives in `/usr/sbin` and is missing from some users' `PATH`, which produced
  Alpine advice on an Ubuntu box; `sudo` being installed is not the same as being
  allowed to use it, which is now checked immediately after you consent rather
  than partway through; and a low-disk warning that printed "only 0 GB free" now
  reports "only 99 MB free in /srv" and names the directory it measured.
- **The README leads with installing ProxMate** rather than a two-terminal
  development setup. `DEPLOY_WITH_CLAUDE.md` is presented as a supported
  alternative — some people would rather have an agent walk the deploy with them,
  and that route is not going away.
- **CI writes its Docker build cache only from `main`.** Exporting every
  intermediate layer from every branch filled the 10 GB Actions cache quota, at
  which point builds fail with `error writing layer blob: failed to reserve cache`
  on code that is perfectly fine. Pull requests still read the cache.

## Upgrade notes

Standard update. No database migration beyond what the backend applies on boot,
and no configuration changes required.

```bash
git pull
docker compose up -d --build
```

Two things worth checking afterwards:

1. **If you ever installed or created directories with `sudo`**, confirm the next
   nightly app-database backup actually produces a file. The entrypoint fixes the
   ownership on container start, but it is worth seeing a snapshot appear.
2. **If you migrate guests between nodes**, expect the migrate dialog to offer
   fewer targets than before on a mixed-CPU cluster. That is the guardrail, not a
   regression — and the message tells you how to move the guest anyway.

## Verification

- Backend: 740 tests across 84 files, plus typecheck and lint.
- Frontend: lint, production build, Playwright smoke.
- CodeQL, Trivy, `npm audit` and SBOM all pass.
- The installer was exercised end to end on a clean Ubuntu 24.04 host: with
  Docker present, with Docker **absent** (installed from scratch in 6m39s), as
  **root via sudo** (ownership handed back, and the backup directory confirmed
  writable by the unprivileged container user), in `--domain` mode behind Caddy
  over HTTPS, and re-run over a live install holding real data — where the
  `ENCRYPTION_KEY` survived and an existing session still authenticated.
- Failure paths were provoked deliberately rather than reasoned about: a real
  account with no sudo rights, a real 100 MB filesystem, a `PATH` with no package
  manager, and a `PATH` with `/usr/sbin` stripped.

Stated plainly, because it is worth knowing: the `dnf`/`yum`, pacman, zypper and
apk paths are verified by inspection and package metadata, not by a completed
install on those distributions. The Caddy configuration was tested with an
internal certificate, so the automatic-HTTPS path against a public domain remains
unexercised.
