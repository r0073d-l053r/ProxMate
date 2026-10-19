# HTTP API

The backend REST/WebSocket surface: one concept per Express router.

# API

* [ProxMate HTTP API](http-api.md) - Overview of the ProxMate backend HTTP and WebSocket surface under /api, covering middleware order, cookie/JWT/API-token auth, CSRF, rate limits, OpenAPI and every router.

# API Router

* [Admin router](admin.md) - Admin-only platform settings, cluster health and isolation, audit log, quota and passthrough approvals, broadcasts, balancer and self-update endpoints, mounted at /api/admin.
* [API token router](api-token.md) - Lists, creates and revokes the caller's personal API tokens (pm_ prefixed Bearer credentials) under /api/api-tokens.
* [Auth router](auth.md) - Registration, password/2FA/passkey/SSO login, sessions, kiosk exit, account MFA management and password reset, mounted at /api/auth.
* [Broadcast unsubscribe router](broadcast.md) - Public HMAC-token unsubscribe page for admin announcement emails, mounted at /api/broadcast.
* [Console WebSocket relay](console.md) - WebSocket upgrade handler that relays the browser's noVNC and xterm.js consoles to Proxmox vncproxy/termproxy for /api/vms/:id/console and /api/vms/:id/serial.
* [Backup download router](download.md) - Public single-use token endpoint that streams a MateState vzdump backup file, mounted at /api/downloads.
* [IDE LLM gateway router](ide-gateway.md) - OpenAI-compatible LLM proxy that the in-guest AI agent calls with a per-VM gateway Bearer token at /api/ide/:id/llm/v1.
* [IDE router](ide.md) - Session-authed ProxMate IDE endpoints (capability, gateway-token minting, in-guest provisioning, AVX relocation, BYO AI keys) under /api/ide.
* [Invite router](invite.md) - Admin-only creation, emailing, listing and revocation of registration invite tokens, mounted at /api/invites.
* [Passthrough request router](passthrough-request.md) - Tenant endpoints to request GPU/PCI passthrough for a VM and list their own requests, mounted at /api/passthrough-requests.
* [Proxmox introspection router](proxmox.md) - Read-only cluster introspection (resources, nodes, ISOs, storage) for any signed-in user, mounted at /api/proxmox.
* [Quota request router](quota-request.md) - Tenant endpoints to ask an admin for a higher CPU/RAM/storage quota and list their own requests, mounted at /api/quota-requests.
* [Setup wizard router](setup.md) - Unauthenticated first-run wizard (create admin, Proxmox connection, defaults, finalize) that locks itself once setup_complete is set, mounted at /api/setup.
* [SSH key router](ssh-key.md) - Manages the caller's saved OpenSSH public keys (account keychain), mounted at /api/ssh-keys.
* [Template router](template.md) - Template Store listing and deploy for users plus admin management of templates, cloud images and cloud-init extras, mounted at /api/templates.
* [User management router](user.md) - Admin-only listing, quota/access-window edits and deletion of user accounts, mounted at /api/users.
* [VM router](vm.md) - Tenant VM and LXC lifecycle API (create, restore, power, resize, disks, shares, schedules, alerts, snapshots, MateState backups, rescue, console tickets), mounted at /api/vms.
