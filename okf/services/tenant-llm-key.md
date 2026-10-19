---
type: Backend Service
title: Tenant LLM-key service (bring-your-own AI keys)
description: Stores tenant and admin LLM provider keys AES-256-GCM encrypted, enforces provider/base-URL allow-lists and SSRF checks, and resolves keys for the IDE gateway.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/tenant-llm-key.service.ts
tags: [proxmate, ide, llm, encryption, ssrf]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: llm
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/src/services/tenant-llm-key.service.ts
    title: backend/src/services/tenant-llm-key.service.ts
---

# Purpose

BYO LLM keys used ONLY through the ProxMate gateway (single controlled egress + audit). The secret is never returned to any client; it is decrypted in memory only to forward a request.[^llm]

# Key functions

| Function | Signature summary | What it does |
|---|---|---|
| `KNOWN_PROVIDERS` | `['openai', 'openai-compatible']` | Anthropic is intentionally not offered (not OpenAI-wire compatible). |
| `TENANT_ALLOWED_COMPAT_BASES` | `https://openrouter.ai/api/v1`, `https://api.groq.com/openai/v1` | Bases tenants may use; must match `PRESETS` in `frontend/src/components/ide/ai-keys-card.tsx`. |
| `listLlmKeys` | `(userId) => LlmKeyView[]` | Safe view only (`id, label, provider, model, baseUrl, createdAt, lastUsedAt`). |
| `addLlmKey` | `(userId, input, { allowPrivate?, allowCustomBase? })` | Validates, enforces max 20 per user, stores `keyEnc = encrypt(key)`; `baseUrl` null for `openai`. |
| `getLlmKeyEndpoint` | `(userId, id)` | Owner-scoped `{ baseUrl, apiKey, model, label }` for connection tests / admin sourcing. |
| `getLlmKeyEndpointById` | `(id)` | NOT owner-scoped; only for the gateway serving an admin-configured model after a visibility check. |
| `deleteLlmKey` | `(userId, id) => boolean` | Owner-only delete. |

# Data

[TenantLlmKey](/database/tenant-llm-key.md) (`userId, label, provider, model, baseUrl, keyEnc, lastUsedAt`). Encryption via `lib/crypto` keyed by `ENCRYPTION_KEY`.[^llm]

# Gotchas

- Custom openai-compatible base URLs are admin-only (owner decision 2026-07-11); tenants get an error telling them to pick a preset or ask the admin to share a model.[^llm]
- SSRF: tenant base URLs must pass `assertPublicHttpUrlShape`; admins (`allowPrivate`) are exempt so they can point at LAN endpoints like a local Ollama; env `ALLOW_PRIVATE_OUTBOUND_URLS` is the escape hatch.[^llm]
- `openai` always resolves to `https://api.openai.com/v1`.[^llm]
- Losing `ENCRYPTION_KEY` makes every stored key undecryptable.[^llm]

# Relationships

- Called by the [ide router](/api/ide.md) and [admin router](/api/admin.md); used by [ide-gateway](/services/ide-gateway.md).
- See [ide config](/config/ide.md).

[^llm]: backend/src/services/tenant-llm-key.service.ts
