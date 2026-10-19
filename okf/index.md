---
okf_version: "0.2"
---

# ProxMate knowledge bundle

An [Open Knowledge Format](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
(OKF v0.2) bundle describing ProxMate, the self-service cloud dashboard for Proxmox VE: its data model,
configuration, HTTP API, service layer and Proxmox integration. It is written for agents and people who
operate or change ProxMate. Each concept is one markdown file with YAML frontmatter; the path is its ID.

Every concept here was generated from the source code and is **unverified** (OKF trust tier) until a
maintainer adds a `verified` entry. Facts are cited to source files with footnotes keyed to `sources`.

# Sections

* [Architecture](services/architecture.md) - Start here: how the backend, frontend, IDE and deployment fit together
* [Database](database/) - The Prisma/SQLite schema, one concept per model
* [Runtime configuration](config/) - SystemConfig keys grouped by feature, plus an alphabetical key index
* [Environment](env/) - Backend process environment and the Docker deployment
* [HTTP API](api/) - Every Express router and endpoint, with auth and gotchas
* [Backend services](services/) - The service layer under backend/src/services
* [Proxmox VE integration](proxmox/) - API surface, privilege matrix, storage, networking, guest lifecycle
* [Playbooks](playbooks/) - Procedures, including setting up an SDN-only cluster

# Common entry points

* [All SystemConfig keys](config/system-config-keys.md) - Alphabetical index of every key with its group
* [Proxmox privilege matrix](proxmox/privileges.md) - What the API token needs and what breaks without each privilege
* [Guest networking](proxmox/networking.md) - Bridge/OVS/SDN VNet discovery and the default network
* [Maintaining this bundle](playbooks/maintaining-this-bundle.md) - Rules the conformance test enforces
