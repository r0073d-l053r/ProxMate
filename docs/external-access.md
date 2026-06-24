# Secure External Access to ProxMate VMs

> **The rule on this cluster: ZERO port forwarding.**
>
> Do not open any port on the host router or the Proxmox host for tenant VMs.
> If you want to reach a VM from the outside world, use one of the two methods
> in this guide. They are both free, both more secure than port forwarding, and
> both work alongside ProxMate's per-VM firewall.

---

## Why no port forwarding?

Port forwarding pokes a hole in the home/host firewall and exposes that VM
(and, accidentally, anything it can reach) directly to the public internet.
On a shared cluster that:

- creates an attack surface on **your** network, not just the tenant's VM,
- bypasses the per-VM firewall ProxMate adds (which is designed to keep tenants
  off your LAN),
- depends on the host router's NAT rules — easy to misconfigure, hard to audit.

The two alternatives below — **Tailscale** and **Cloudflare Tunnels** — solve
the same problem (reach a private VM from anywhere) without opening any inbound
port on the host network.

---

## Pick the right tool for the job

| You want to…                                            | Use                  | Guide |
|---------------------------------------------------------|----------------------|-------|
| SSH into your VM from your laptop                       | **Tailscale**        | [Tailscale for SSH](./tailscale-ssh.md) |
| Reach a self-hosted dashboard from your own devices only | **Tailscale**        | [Tailscale for SSH](./tailscale-ssh.md) |
| Publish a public website / API / Discord bot webhook    | **Cloudflare Tunnel** | [Cloudflare Tunnels](./cloudflare-tunnels.md) |
| All of the above on the same VM                         | Both — they coexist  | Both guides |

**Rule of thumb:** if only people you specifically authorize need to reach the
service, use Tailscale. If you need a public DNS name with HTTPS that anyone
on the internet can hit, use Cloudflare Tunnel.

---

## How ProxMate's per-VM firewall interacts with these tools

Every VM ProxMate creates gets a firewall that:

- **drops all inbound** by default,
- **drops outbound** to RFC1918 ranges (your LAN, your other tenants, the
  Proxmox host),
- **allows outbound** to the public internet + DNS.

Both Tailscale and Cloudflare Tunnel are **outbound-only** connections from
inside the VM to a control plane on the internet, so they work with the
firewall as-is — nothing extra needed.

You do **not** need to:

- forward any port on the host router,
- punch any inbound rule into the per-VM firewall,
- expose the Proxmox web UI to the internet.

---

## For admins

If you run the cluster, see [Admin guide — cluster + templates](./admin-guide.md)
for first-time setup, the firewall-enforcement step, and how to ship a Linux
template that has Tailscale and `cloudflared` pre-installed so tenants are one
command away from secure remote access.

## For users (tenants)

You only need to set up Tailscale (most common case) — see the
[Tailscale SSH guide](./tailscale-ssh.md). Add the
[Cloudflare Tunnels guide](./cloudflare-tunnels.md) only if you're hosting a
public web service.
