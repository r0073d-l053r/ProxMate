---
type: Prisma Model
title: TenantLlmKey
description: A tenant's bring-your-own LLM provider API key, AES-256-GCM encrypted at rest and used only through the ProxMate LLM gateway.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
tags: [proxmate, database, prisma, ide, llm-gateway, secrets]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: schema
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/prisma/schema.prisma
    title: backend/prisma/schema.prisma
  - id: svc
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/tenant-llm-key.service.ts
    title: backend/src/services/tenant-llm-key.service.ts
  - id: gw
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/ide-gateway.service.ts
    title: backend/src/services/ide-gateway.service.ts
  - id: crypto
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/lib/crypto.ts
    title: backend/src/lib/crypto.ts
---

# Purpose

Lets a tenant (or admin) plug their own provider key into the in-guest IDE agent. The gateway is the single egress: it decrypts the key in memory to forward one upstream request and never returns it to a client. Each row exposes exactly one `model`.[^schema] [^gw] See [IDE config](/config/ide.md).

# Schema

| Field | Type | Attributes | Description |
|---|---|---|---|
| id | String | `@id @default(cuid())` | Primary key; surfaced to the model picker as `byo:<id>`.[^gw] |
| userId | String | FK, `@@index` | Owning [User](/database/user.md). |
| label | String | | User label, e.g. "my OpenAI". |
| provider | String | | Service accepts only `openai` or `openai-compatible`.[^svc] |
| model | String | | Upstream model name exposed to the tenant. |
| baseUrl | String? | | Required for `openai-compatible`; forced null for `openai` (fixed `https://api.openai.com/v1`). |
| keyEnc | String | | AES-256-GCM ciphertext (`iv:tag:ciphertext` hex) under `ENCRYPTION_KEY`. Never selected for API responses. |
| createdAt | DateTime | `@default(now())` | |
| lastUsedAt | DateTime? | | Updated by the gateway on use. |

[^schema] [^svc] [^crypto]

# Relationships

- Belongs to [User](/database/user.md), `onDelete: Cascade`.[^schema]

# Invariants

- At most 20 keys per user (`MAX_LLM_KEYS_PER_USER`).[^svc]
- Tenants may only use the preset compatible bases `https://openrouter.ai/api/v1` and `https://api.groq.com/openai/v1`; custom base URLs and private/LAN hosts are admin-only (`allowCustomBase`, `allowPrivate`).[^svc]
- List and create responses use a `SAFE_SELECT` that omits `keyEnc`.[^svc]
- Deletion checks `row.userId === userId`.[^svc]

# Gotchas

- The schema comment lists `"anthropic"` as a provider, but `KNOWN_PROVIDERS` is only `openai` and `openai-compatible`; Anthropic is deliberately not accepted.[^svc]
- `getLlmKeyEndpointById` resolves a key without owner scoping; it is used to serve an admin-sourced shared model to tenants.[^svc]
- Rotating `ENCRYPTION_KEY` makes every `keyEnc` undecryptable.[^crypto]

[^schema]: backend/prisma/schema.prisma
[^svc]: backend/src/services/tenant-llm-key.service.ts
[^gw]: backend/src/services/ide-gateway.service.ts
[^crypto]: backend/src/lib/crypto.ts
