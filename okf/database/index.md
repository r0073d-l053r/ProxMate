# Database

The Prisma/SQLite schema: one concept per model.

# Database

* [ProxMate database](proxmate-database.md) - The single Prisma-managed SQLite database behind the ProxMate backend, with its 22 core models, migration history and the module schema seam.

# Prisma Model

* [AlertRule](alert-rule.md) - A tenant-defined threshold alert on one VM (cpu, memory, disk or down), evaluated every 5 minutes and delivered by email and admin webhook.
* [ApiToken](api-token.md) - A personal API token (pm_ prefix) for CLI, Terraform or script access that acts as its owning user.
* [AuditLog](audit-log.md) - An append-only record of who did what, deliberately not foreign-keyed to User so the trail outlives deleted accounts.
* [DownloadToken](download-token.md) - A single-use one-hour token, emailed to a tenant, that streams one MateState backup file off an admin-mounted backup share.
* [IdeGatewayToken](ide-gateway-token.md) - Per-user per-VM token (pmide_ prefix) that authenticates the in-guest IDE AI agent to the ProxMate LLM gateway.
* [IdeGuestSecret](ide-guest-secret.md) - Per-VM encrypted credential that the IDE reverse proxy uses to prove a guest's code-server is that VM's own install and to authenticate every proxied request.
* [InviteToken](invite-token.md) - An admin-minted registration link that carries the new tenant's quotas, 2FA requirement and compute access duration.
* [MateState](mate-state.md) - A point-in-time Proxmox vzdump backup of a VM ("MateState"), with rolling per-VM retention.
* [Passkey](passkey.md) - A WebAuthn credential that serves as a passwordless login and counts as a second factor.
* [PassthroughRequest](passthrough-request.md) - A tenant's request to attach a GPU or PCI device to their VM, with the admin's chosen Proxmox mapping and background-apply progress.
* [PasswordResetRequest](password-reset-request.md) - A "contact admin" password-reset request filed when no SMTP is configured, resolved by an admin setting a new password.
* [PasswordResetToken](password-reset-token.md) - A single-use one-hour email password-reset token, stored only as a SHA-256 hash.
* [QuotaRequest](quota-request.md) - A tenant's request for higher resource caps, approved or denied by an admin.
* [ResourceSample](resource-sample.md) - A periodic CPU and memory usage sample of one running VM, kept for a rolling window to power the admin per-tenant usage view.
* [Session](session.md) - A server-side login session backing the 24h session JWT cookie, carrying the double-submit CSRF token.
* [SshKey](ssh-key.md) - A reusable SSH public key saved on a user's profile so cloud-init deploys can pick it from a list.
* [SystemConfig](system-config.md) - The key/value store for all runtime settings and platform secrets, with optional per-row AES-256-GCM encryption.
* [Template](template.md) - A published, cloneable OS build in the Template Store, mapped one-to-one to a Proxmox template VM.
* [TenantLlmKey](tenant-llm-key.md) - A tenant's bring-your-own LLM provider API key, AES-256-GCM encrypted at rest and used only through the ProxMate LLM gateway.
* [TwoFactorRecoveryCode](two-factor-recovery-code.md) - One of ten single-use TOTP backup codes issued when a user enables 2FA, stored only as a SHA-256 hash.
* [User](user.md) - A ProxMate account (admin or tenant) holding credentials, 2FA state, lockout counters, resource quotas and the compute access window.
* [VirtualMachine](virtual-machine.md) - ProxMate's record of a tenant-owned Proxmox guest (QEMU VM or LXC container) with sizing, status, lifecycle locks, schedules and quota flags.
* [VmShare](vm-share.md) - Grants another user access to a VM they do not own at a preset level of viewer, operator or manager.
