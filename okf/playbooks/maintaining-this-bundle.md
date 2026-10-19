---
type: Playbook
title: Maintaining this OKF bundle
description: How to keep the okf/ knowledge bundle conformant and in sync when the ProxMate code changes.
resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/test/okf-bundle.test.ts
tags: [proxmate, playbook, okf, documentation]
generated: { by: okf-bootstrap/0.1, at: 2026-10-19T12:00:00Z }
sources:
  - id: test
    resource: https://github.com/r0073d-l053r/ProxMate/blob/main/backend/test/okf-bundle.test.ts
    title: backend/test/okf-bundle.test.ts
  - id: spec
    resource: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
    title: Open Knowledge Format specification v0.2
---

# Trigger

You added, renamed or removed a Prisma model, an API router, a `SystemConfig` key or a
service, or you changed behaviour that a concept describes.

# Rules the CI test enforces

`backend/test/okf-bundle.test.ts` runs as part of `npm test` in `backend/`.[^test]

| Check | Source of the rule |
|-------|--------------------|
| Every non-reserved `.md` has YAML frontmatter with a non-empty `type` | OKF §11[^spec] |
| Only the root `index.md` has frontmatter (`okf_version: "0.2"`) | OKF §8, §12 |
| `log.md` headings are `## YYYY-MM-DD`, newest first | OKF §9 |
| Every concept has `title`, a one-line `description` and `generated: { by, at }` | house style |
| `generated.by` / `verified[].by` follow the actor convention (`human:<id>`, `process:<id>`, `<producer>/<version>`) | OKF §7 |
| Every footnote label matches a `sources[].id` | OKF §5.1 |
| Every `sources[]` entry has a non-empty `resource` | house style |
| Every internal markdown link resolves to a file in the bundle | house style (stricter than §6.1) |
| Every directory has an `index.md` linking each concept and subdirectory in it | house style |
| The bundle holds more than 50 concepts | house style |
| Every Prisma model has `database/<kebab-name>.md` | sync |
| Every `*.routes.ts` has `api/<name>.md` | sync |
| Every `*.service.ts` has `services/<name>.md` | sync |
| Every `getConfig('…')` / `setConfig('…')` key appears in `config/system-config-keys.md` | sync |

# Steps

1. Edit or add the concept. One concept per file, kebab-case filename, never `index.md`
   or `log.md`.
2. Update `generated.at` when the content meaningfully changes. When a person has checked
   it, add `verified: { by: human:<github-login>, at: <ISO datetime> }`; that raises the
   concept to the *human-reviewed* trust tier (OKF §5.3).[^spec]
3. List the concept in its directory's `index.md` with its description.
4. Add a dated entry at the top of [the bundle log](/log.md).
5. Run `cd backend && npx vitest run test/okf-bundle.test.ts`.

[^test]: backend/test/okf-bundle.test.ts
[^spec]: Open Knowledge Format specification v0.2
