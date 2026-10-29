# Backend services

The service layer under backend/src/services.

# Architecture

* [ProxMate backend and system architecture](architecture.md) - How ProxMate is put together - Express 5 + Prisma/SQLite backend entrypoints and middleware order, route → service → proxmox.service/Prisma layering, scheduler jobs, the optional module seam, the Next.js frontend route groups, the in-guest IDE, and Docker Compose deployment.

# Backend Service

* [Access-sweep service (access-window warnings and suspension)](access-sweep.md) - Hourly sweep that emails tenants 7 and 1 days before their compute-access window closes and powers off lapsed tenants' guests, latching a suspension and notifying admins.
* [Access service (tenant compute-access windows)](access.md) - Pure helpers that decide whether a tenant's compute-access window has lapsed and build the refusal returned by every session-minting login path.
* [Account-lockout service](account-lockout.md) - Per-account brute-force protection that temporarily locks a user after a configurable number of consecutive failed passwords and alerts admins.
* [Activity-mail service (deploy-for-tenant and share emails)](activity-mail.md) - Best-effort emails to a tenant about their own machines - an admin set a VM up in their account, or a VM was shared with them or their share level changed - sent after the request is answered.
* [Alert service (per-VM resource alerts)](alert.md) - Evaluates tenant-defined per-VM alert rules (cpu, memory, disk, down) against a live cluster sample every 5 minutes and emails the owner plus the admin webhook when a sustained breach fires.
* [API-token service (personal access tokens)](api-token.md) - Mints, lists, revokes and verifies `pm_`-prefixed personal API tokens stored only as an HMAC-SHA256 hash peppered with ENCRYPTION_KEY.
* [App-DB backup service](appdb-backup.md) - Nightly `VACUUM INTO` snapshot of ProxMate's own SQLite database into an admin-configured directory with filename-scoped rolling retention.
* [Auto-snapshot service (snapshot before risky changes)](auto-snapshot.md) - Takes a `pm-auto-<op>-<timestamp>` Proxmox snapshot of a VM before a resize, data-disk grow or rescue boot, refuses the change when it can't, and keeps only the newest N automatic snapshots per VM without ever deleting a user's.
* [Audit service](audit.md) - Never-throwing append-only audit log writer plus paginated and per-target readers, with real-client-IP extraction behind a proxy.
* [Auth service (passwords, JWT sessions, challenge tokens)](auth.md) - Bcrypt password hashing, HS256 JWT session minting backed by a Session row with a CSRF token, session verification, and short-lived 2FA challenge and enrollment tokens.
* [Broadcast opt-out service](broadcast-optout.md) - Stateless HMAC unsubscribe tokens for admin broadcast emails and the per-user `broadcastOptOut` flag they toggle.
* [Cluster-balancer service (DRS-style balancing and node drain)](cluster-balancer.md) - Pure memory-load balancing and node-drain planners plus orchestrators that gather a live cluster snapshot and live-migrate ProxMate-managed VMs, optionally on a 15-minute auto schedule.
* [Config service (SystemConfig key/value store)](config.md) - Thin get/set wrapper over the SystemConfig table that transparently encrypts and decrypts rows flagged sensitive.
* [Deploy-lock service (cloud-init deploy lock)](deploy-lock.md) - Tracks a freshly deployed guest as `deploying` until the guest agent reports cloud-init finished (or 8 minutes pass), then sets the pending login password in-guest and unlocks.
* [Disk service (extra data disks)](disk.md) - Lists, attaches, grows and removes a VM's extra data disks on the root disk's bus and storage, keeping `VirtualMachine.storage` and the owner's storage quota in step.
* [Download service (tenant backup downloads)](download.md) - Emails tenants a single-use, one-hour link that streams a MateState vzdump file straight off an admin-mounted backup share, with path-traversal-hardened file resolution.
* [Guest-file service (push a file, read the IDE install log)](guest-file.md) - Pushes a small file into a running QEMU guest through the guest agent (strict path checks, base64 parts, fixed assemble script) and reads the cleaned tail of the ProxMate IDE install log.
* [Guest-import service (bring an existing Proxmox guest under management)](guest-import.md) - Lists Proxmox guests ProxMate doesn't manage and imports one for a chosen owner - writes its ownership tag, applies the default bridge and isolation firewall, and counts it toward the owner's quota unless marked exempt.
* [Guest-pool service (pool-scoped token support)](guest-pool.md) - The connection test's resource-pool checks and the admin action that moves guests carrying a ProxMate ownership marker into the configured `proxmox_pool`.
* [IDE-gateway service (ProxMate LLM gateway policy)](ide-gateway.md) - Per-VM `pmide_` bearer tokens and the model-routing policy behind the OpenAI-compatible `/api/ide/:id/llm/v1` endpoint used by the in-guest OpenCode agent.
* [IDE guest-auth service (per-VM code-server credential)](ide-guest-auth.md) - Generates, stores and checks the per-VM secret that a guest's code-server must prove before the IDE proxy relays to it, and that authenticates every proxied request.
* [IDE-provision service (in-guest install and AVX relocate)](ide-provision.md) - Installs pinned code-server and OpenCode natively into a tenant VM through the QEMU guest agent under an `installing` lock, and relocates VMs on non-AVX nodes to an AVX-capable node.
* [IDE-proxy service (code-server reverse proxy)](ide-proxy.md) - HTTP and WebSocket reverse proxy that serves a guest's code-server at `/api/ide/:id/proxy/`, authenticated by session cookie, VM `ide` capability and the admin IDE policy.
* [IDE service (ProxMate IDE admin policy)](ide.md) - Config-only admin policy for the in-guest ProxMate IDE - availability tier, BYO-key switch, admin-sourced local models with visibility, legacy shared models and the ingress CIDR - and per-user capability resolution.
* [Invite service (token and expiry helpers)](invite.md) - Two pure helpers used by the invite router to generate a random invite token and parse a `7d`/`24h`/`60m` style expiry.
* [Key-backup service (ENCRYPTION_KEY backup confirmation)](key-backup.md) - Records which admin confirmed, and when, that ENCRYPTION_KEY is backed up off the host, tied to a non-reversible fingerprint of the key so a changed key brings the admin warning back.
* [Kiosk service (exit PIN)](kiosk.md) - Stores and verifies the bcrypt-hashed 4-12 digit PIN required to leave the unattended full-screen kiosk admin panel.
* [Live-stats service](live-stats.md) - Cached, request-coalesced live CPU/memory/disk/network stats for every guest from `/cluster/resources`, plus a single server-side SSE fan-out loop for admin monitors.
* [Mail service (SMTP)](mail.md) - Reads and saves SMTP settings from SystemConfig (password encrypted) and sends mail through a fresh nodemailer transport per message.
* [MateState service (VM backups)](matestate.md) - Creates, prunes, restores and deletes MateState vzdump backups of guests, runs the weekly cluster-wide backup and the per-minute per-VM backup schedules.
* [MFA service (second-factor presence checks)](mfa.md) - Answers whether a user already has a second factor (TOTP or passkey) and whether an invite-mandated 2FA setup is still outstanding.
* [Notify service (admin event notifications)](notify.md) - Best-effort fan-out of admin event notifications to an SSRF-guarded outgoing webhook and/or email, with per-event toggles.
* [Passkey service (WebAuthn)](passkey.md) - WebAuthn passkey registration, usernameless authentication and management using @simplewebauthn/server with an RP derived from FRONTEND_URL.
* [Passthrough-request service (PCI/GPU passthrough workflow)](passthrough-request.md) - Tenant requests for PCI/GPU passthrough and the admin two-phase approval that places the VM on a node hosting the Proxmox PCI mapping, attaches `hostpci0`, and recovers interrupted applies on startup.
* [Password-reset service](password-reset.md) - Forgot-password flow that emails a single-use one-hour reset link when SMTP is on, or queues a request for an admin otherwise, without revealing whether the email exists.
* [Power-schedule service (auto start/stop and cron evaluator)](power-schedule.md) - Minimal 5-field cron evaluator plus the per-minute tick that auto-starts and gracefully stops VMs whose `startCron`/`stopCron` fires.
* [Proxmox service](proxmox.md) - The single Proxmox VE REST client and every guest, storage, network, backup, firewall and cluster operation built on it.
* [Project service (project tags and rollups)](project.md) - Treats a `project:<name>` VM tag as the VM's project, builds the scoped Projects view with allocation and usage rollups from the DB alone, and moves owned VMs between projects.
* [Quota-request service](quota-request.md) - Tenant requests for higher absolute CPU/RAM/storage caps and the admin approve/deny queue that applies them.
* [Resource-history service (per-tenant usage samples)](resource-history.md) - Samples every running managed VM's CPU and memory every 5 minutes into ResourceSample, prunes a rolling window, and aggregates usage per owner for the admin usage view.
* [Restore-upload service (restore a guest from an uploaded vzdump)](restore-upload.md) - Restores a tenant-uploaded vzdump archive, written into the mounted backup share, as a brand-new quota-checked and isolated guest, then deletes the archive.
* [Scheduler service (node-cron jobs)](scheduler.md) - Starts every in-process node-cron job after the HTTP server listens, each guarded by its own in-memory running flag, with env-overridable schedules and boot-time catch-up for weekly backups and access expiry.
* [Setup service](setup.md) - First-run wizard logic, covering the admin account, Proxmox connection and privilege test, resource discovery, defaults and completion.
* [SSH-key service](ssh-key.md) - Validates single-line OpenSSH public keys and manages a user's saved keys (max 25, de-duplicated) for injection into guest cloud-init.
* [SSO service (OpenID Connect)](sso.md) - OIDC authorization-code + PKCE login via openid-client, cached discovery, and mapping of ID-token claims to a local user with optional JIT provisioning and admin-group promotion.
* [Task-reconcile service (interrupted operations)](task-reconcile.md) - Startup and 5-minute pass that settles rows a backend restart left `creating` or `restoring` from what Proxmox shows, never touching an operation that is still running and never deleting a guest or a backup.
* [Template service (Template Store and cloud-image builder)](template.md) - Manages the Template Store (register, discover, convert, unregister), builds cloud-init templates from cloud-image URLs with a guest-agent bake, refreshes them monthly, and holds the admin cloud-init feature/snippet configuration.
* [Tenant LLM-key service (bring-your-own AI keys)](tenant-llm-key.md) - Stores tenant and admin LLM provider keys AES-256-GCM encrypted, enforces provider/base-URL allow-lists and SSRF checks, and resolves keys for the IDE gateway.
* [Two-factor service (TOTP and recovery codes)](twofactor.md) - TOTP enrollment with an encrypted secret and QR code, login verification with one step of clock skew, and ten single-use SHA-256-hashed recovery codes.
* [Update service (self-update check and host-mediated apply)](update.md) - Compares the running version with the latest GitHub Release and, when enabled, queues an update by writing a request file into a bind-mounted control directory watched by a host-side updater.
* [Usage-digest service (weekly per-tenant usage email)](usage-digest.md) - Builds and sends the weekly opt-in email listing a user's own machines, their running hours and average CPU/RAM from ResourceSample, and their quota in use.
* [VM-share service (share presets and capabilities)](vm-share.md) - Shares a VM with another existing user at a preset level (viewer, operator, manager) and defines the capability set each preset grants.
* [VM service (guest lifecycle orchestration)](vm.md) - Central orchestration for tenant guests - quota checks, create (ISO, LXC, template deploy, duplicate, rebuild), access/capability resolution, power actions with owner access-window guard, migration, resize, rescue mode, guest-agent helpers and the storage-pinning report.
* [VNC-proxy service (console tickets and WebSocket relay)](vnc-proxy.md) - Obtains Proxmox vncproxy/termproxy tickets and relays browser WebSockets to the node's vncwebsocket endpoint using the stored API token, for graphical and serial consoles.
