# Proxmox VE integration

How ProxMate talks to Proxmox: API surface, privileges, storage, networking, guest lifecycle.

# Proxmox API Dependency

* [Proxmox VE API surface](pve-api-surface.md) - How ProxMate's backend builds its Proxmox VE REST client (API-token auth, TLS, retries, credential redaction, task polling, error mapping) and every Proxmox path it calls.

# Proxmox Privilege Matrix

* [Proxmox token privileges](privileges.md) - Which Proxmox VE privileges ProxMate's connection test checks, how it reads the token's effective permissions, what breaks without each privilege, and the documented token/ACL setup.

# Proxmox Integration

* [Guest lifecycle on Proxmox](guest-lifecycle.md) - How ProxMate creates, clones, templates, powers, migrates, backs up, restores, deletes and consoles QEMU VMs and LXC containers on Proxmox VE, including VMID allocation, bridge/VLAN application and tenant firewall isolation.
* [Guest networking and network discovery](networking.md) - How ProxMate discovers the bridges and SDN VNets a guest NIC can attach to, stores the default, and applies it to every new guest.
* [Proxmox storage usage](storage.md) - How ProxMate discovers Proxmox storages by content type and uses them for VM disks, ISOs, LXC templates, cloud images, cloud-init snippets, vzdump backups and data disks.
