import 'dotenv/config';
import { prisma } from './src/lib/prisma.js';
import { getClient, getConnectionConfig, buildClient, getNodes, getNextVmId } from './src/services/proxmox.service.js';
import type { AxiosInstance } from 'axios';

// Proof-of-concept: does a Proxmox pool-scoped API token genuinely enforce
// tenant↔tenant isolation? Create two tenant pools each with a VM, mint a token
// scoped (via ACL) to ONLY pool A, then confirm that token can see/touch A's VM
// but is DENIED B's. Everything created here is cleaned up at the end.

const POOL_A = 'proxmate-verify-a';
const POOL_B = 'proxmate-verify-b';
const TOKEN = 'verify-tenant-a';
const PARENT_USER = 'root@pam';

const ignore = () => undefined;

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    return (e as { response?: { status?: number } }).response?.status ?? 0;
  }
}

async function main() {
  const admin = await getClient();
  const conn = await getConnectionConfig();
  const node = (await getNodes(admin)).find((n) => n.status === 'online')!.node;
  console.log(`using node ${node}, parent token ${conn.tokenId}`);

  // Pre-clean any leftovers from a prior run.
  await admin.delete(`/access/users/${PARENT_USER}/token/${TOKEN}`).catch(ignore);

  const vmA = await getNextVmId(admin);
  const vmB = vmA + 1;

  try {
    // 1. Two tenant pools.
    for (const poolid of [POOL_A, POOL_B]) {
      await admin.post('/pools', new URLSearchParams({ poolid, comment: 'ProxMate isolation proof' })).catch(ignore);
    }

    // 2. A minimal VM in each pool (no disk needed for a permission test).
    await admin.post(`/nodes/${node}/qemu`, new URLSearchParams({ vmid: String(vmA), name: 'verify-a', memory: '512', pool: POOL_A }));
    await admin.post(`/nodes/${node}/qemu`, new URLSearchParams({ vmid: String(vmB), name: 'verify-b', memory: '512', pool: POOL_B }));
    console.log(`created VM ${vmA} in ${POOL_A}, VM ${vmB} in ${POOL_B}`);

    // 3. A privilege-separated token (no rights of its own), granted PVEVMUser ONLY on pool A.
    const tokRes = await admin.post<{ data: { value: string } }>(
      `/access/users/${PARENT_USER}/token/${TOKEN}`,
      new URLSearchParams({ privsep: '1', comment: 'ProxMate scoped-token proof' }),
    );
    const secret = tokRes.data.data.value;
    await admin.put('/access/acl', new URLSearchParams({ path: `/pool/${POOL_A}`, roles: 'PVEVMUser', tokens: `${PARENT_USER}!${TOKEN}`, propagate: '1' }));
    console.log(`minted scoped token ${PARENT_USER}!${TOKEN} → PVEVMUser on /pool/${POOL_A}`);

    // 4. Build a client that authenticates AS the scoped token.
    const tenant: AxiosInstance = buildClient(conn.host, `${PARENT_USER}!${TOKEN}`, secret, conn.verifySsl);

    // 5. The enforcement checks.
    const visible = (await tenant.get<{ data: Array<{ type: string; vmid?: number }> }>('/cluster/resources')).data.data
      .filter((r) => r.type === 'qemu')
      .map((r) => r.vmid);
    const seesA = visible.includes(vmA);
    const seesB = visible.includes(vmB);
    const readBConfig = await status(tenant.get(`/nodes/${node}/qemu/${vmB}/config`));
    const startB = await status(tenant.post(`/nodes/${node}/qemu/${vmB}/status/start`));
    const readAConfig = await status(tenant.get(`/nodes/${node}/qemu/${vmA}/config`));

    console.log('\n── enforcement results (scoped token) ──');
    console.log(`  /cluster/resources shows own VM ${vmA}: ${seesA}`);
    console.log(`  /cluster/resources shows OTHER VM ${vmB}: ${seesB}   (want false)`);
    console.log(`  read own VM ${vmA} config: HTTP ${readAConfig}   (want 200)`);
    console.log(`  read OTHER VM ${vmB} config: HTTP ${readBConfig}   (want 403)`);
    console.log(`  start OTHER VM ${vmB}: HTTP ${startB}   (want 403)`);

    const pass = seesA && !seesB && readAConfig === 200 && readBConfig === 403 && startB === 403;
    console.log(`\nRESULT ${JSON.stringify({ seesA, seesB, readAConfig, readBConfig, startB, pass })}`);
  } finally {
    // Cleanup — order matters: VMs before pools, ACL+token regardless.
    await admin.put('/access/acl', new URLSearchParams({ path: `/pool/${POOL_A}`, roles: 'PVEVMUser', tokens: `${PARENT_USER}!${TOKEN}`, delete: '1' })).catch(ignore);
    await admin.delete(`/access/users/${PARENT_USER}/token/${TOKEN}`).catch(ignore);
    await admin.delete(`/nodes/${node}/qemu/${vmA}`).catch(ignore);
    await admin.delete(`/nodes/${node}/qemu/${vmB}`).catch(ignore);
    // pools delete only once empty; give the VM deletes a moment.
    await new Promise((r) => setTimeout(r, 3000));
    await admin.delete(`/pools/${POOL_A}`).catch(ignore);
    await admin.delete(`/pools/${POOL_B}`).catch(ignore);
    console.log('cleaned up pools/VMs/token/ACL');
  }
}

main().catch((e) => console.error('ERR', e?.response?.data ?? e?.message ?? e)).finally(() => prisma.$disconnect());
