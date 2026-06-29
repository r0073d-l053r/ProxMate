/**
 * OpenAPI 3.1 description of ProxMate's public REST API — the surface a CLI, a
 * Terraform provider, or a script would use with a personal API token. Served at
 * `GET /api/openapi.json`. It documents the stable, tenant-facing endpoints; the
 * admin/setup surface is intentionally omitted.
 */
const bearer = [{ bearerAuth: [] }];

const vmSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    cpu: { type: 'integer' },
    ram: { type: 'integer', description: 'MB' },
    storage: { type: 'integer', description: 'GB' },
    os: { type: 'string' },
    status: { type: 'string', enum: ['creating', 'running', 'stopped', 'error'] },
    ipAddress: { type: 'string', nullable: true },
    proxmoxNode: { type: 'string' },
    proxmoxVmId: { type: 'integer' },
  },
} as const;

export const openApiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'ProxMate API',
    version: '0.2.6',
    description:
      'Tenant-facing REST API for ProxMate. Authenticate with a personal API token ' +
      '(Authorization: Bearer <token>), created under Security in the app. The same ' +
      'endpoints also accept the browser session cookie.',
  },
  servers: [{ url: '/api' }],
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'A ProxMate personal API token.' },
    },
    schemas: {
      Vm: vmSchema,
      VmCreate: {
        type: 'object',
        required: ['name', 'cpu', 'ram', 'storage', 'os'],
        properties: {
          name: { type: 'string', pattern: '^[a-zA-Z0-9-]+$' },
          cpu: { type: 'integer', minimum: 1 },
          ram: { type: 'integer', minimum: 1, description: 'MB' },
          storage: { type: 'integer', minimum: 1, description: 'GB' },
          os: { type: 'string', description: 'ISO/IMG filename' },
          node: { type: 'string', description: 'Optional pinned node' },
        },
      },
      Error: { type: 'object', properties: { error: { type: 'string' } } },
    },
  },
  security: bearer,
  paths: {
    '/auth/me': {
      get: { summary: 'Current user + quota usage', security: bearer, responses: { 200: { description: 'OK' } } },
    },
    '/vms': {
      get: {
        summary: "List the caller's VMs",
        security: bearer,
        responses: {
          200: { description: 'OK', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Vm' } } } } },
        },
      },
      post: {
        summary: 'Create a VM from an ISO',
        security: bearer,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/VmCreate' } } } },
        responses: { 201: { description: 'Created' }, 403: { description: 'Quota exceeded' } },
      },
    },
    '/vms/{id}': {
      get: { summary: 'VM detail + live status', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' }, 404: { description: 'Not found' } } },
      patch: { summary: 'Update notes/name or resize (cpu/ram/storage)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
      delete: { summary: 'Destroy a VM', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } },
    },
    '/vms/{id}/start': { post: { summary: 'Start', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/vms/{id}/stop': { post: { summary: 'Stop (graceful; ?force=true to kill)', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/vms/{id}/restart': { post: { summary: 'Restart', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/vms/{id}/rebuild': { post: { summary: 'Re-image from an ISO or template', security: bearer, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'OK' } } } },
    '/templates': { get: { summary: 'List published templates', security: bearer, responses: { 200: { description: 'OK' } } } },
    '/templates/deploy': { post: { summary: 'Deploy a VM from a template', security: bearer, responses: { 201: { description: 'Created' } } } },
    '/proxmox/isos': { get: { summary: 'List installable ISOs', security: bearer, responses: { 200: { description: 'OK' } } } },
  },
} as const;
