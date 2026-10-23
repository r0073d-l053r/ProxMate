# Runtime configuration

SystemConfig keys, grouped by feature.

# Reference

* [SystemConfig key index](system-config-keys.md) - Alphabetical list of every SystemConfig key the ProxMate backend reads or writes, with its encryption status and the configuration group that documents it.

# Configuration Group

* [Automatic snapshot settings](auto-snapshot.md) - SystemConfig keys turning the automatic snapshot before a resize, data-disk grow or rescue boot on or off and setting how many automatic snapshots each VM keeps.
* [App-database backup settings](appdb-backup.md) - SystemConfig keys configuring the nightly VACUUM INTO snapshot of ProxMate's own SQLite database, namely the target directory and rolling retention.
* [Cloud-init feature selection](cloud-init.md) - SystemConfig keys recording which cloud-init catalog features are offered to tenants as checkboxes and which are always installed on every cloud-init VM.
* [Cluster balancer settings](cluster-balancer.md) - SystemConfig keys configuring the DRS-style memory-load balancer, covering its mode, imbalance threshold, per-pass migration cap and excluded VMIDs.
* [ProxMate IDE settings](ide.md) - SystemConfig keys controlling the in-guest ProxMate IDE (code-server plus the OpenCode agent), covering who may use it, BYO keys, model catalogs, the legacy model gateway, the firewall ingress CIDR and the RAM floor.
* [Event notification settings](notifications.md) - SystemConfig keys configuring admin event notifications, covering the outgoing webhook, the email channel and its recipient, the enabled event list and the event-list schema version.
* [Platform secrets and internal state](platform-secrets.md) - SystemConfig keys for the JWT signing secret, the setup-complete flag, the kiosk exit PIN hash, the public frontend URL override, the ENCRYPTION_KEY backup confirmation and the MateState scheduler markers.
* [Provisioning defaults](provisioning-defaults.md) - SystemConfig keys choosing the disk pool, network, ISO/snippet storage, backup storage and rescue ISO that guest creation, cloning, restores and rescue boot use.
* [Proxmox connection settings](proxmox-connection.md) - SystemConfig keys holding the Proxmox VE API endpoint, API token and TLS-verification flag that every Proxmox client ProxMate builds is created from.
* [SMTP (outgoing email) settings](smtp.md) - SystemConfig keys configuring the nodemailer SMTP transport that ProxMate uses for invites, password resets, notifications, broadcasts and backup-download links.
* [SSO (OIDC) settings](sso.md) - SystemConfig keys configuring OpenID Connect single sign-on, including the issuer, client credentials, scopes, group-to-admin mapping, JIT sign-up and login button text.
* [Template auto-refresh setting](template-refresh.md) - SystemConfig key toggling the monthly job that rebuilds every refreshable cloud-image template so new deploys start from a patched base.
* [Tenant isolation settings](tenant-isolation.md) - SystemConfig keys controlling per-guest firewall isolation, the DNS allow-list and the tenant VLAN tag applied to guest NICs.
* [Weekly usage digest setting](usage-digest.md) - SystemConfig key with the admin on/off switch for the weekly per-tenant usage digest email, which each user also opts in to.
