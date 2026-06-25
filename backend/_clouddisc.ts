import 'dotenv/config';
import { prisma } from './src/lib/prisma.js';
import { getClient, getTemplates, getVmConfig, getStorages } from './src/services/proxmox.service.js';

async function main() {
  const client = await getClient();

  const templates = await getTemplates(client);
  console.log('=== TEMPLATES (template=1) ===');
  for (const t of templates) {
    console.log(`\n#${t.vmid} "${t.name}" on ${t.node} (maxdisk=${t.maxdisk ?? '?'})`);
    try {
      const cfg = await getVmConfig(t.node, t.vmid, client);
      // Print the config keys that matter for cloud-init readiness.
      const keys = Object.keys(cfg).sort();
      for (const k of keys) {
        if (/^(scsi|sata|ide|virtio)\d+$|^net\d+$|^scsihw$|^boot$|^ostype$|^agent$|^ciuser$|^cipassword$|^sshkeys$|^ipconfig\d+$|^serial\d+$|^vga$|^name$|^cores$|^memory$|^bios$|^machine$/.test(k)) {
          console.log(`   ${k} = ${cfg[k]}`);
        }
      }
      const hasCloudInitDrive = keys.some((k) => /^(ide|sata|scsi)\d+$/.test(k) && /cloudinit/i.test(cfg[k] ?? ''));
      console.log(`   --> cloud-init drive present: ${hasCloudInitDrive}`);
    } catch (e) {
      console.log('   (config read failed:', (e as Error).message, ')');
    }
  }

  console.log('\n=== STORAGES ===');
  const storages = await getStorages(client);
  for (const s of storages) {
    console.log(`   ${s.storage} type=${s.type} content=${s.content} nodes=${(s as { nodes?: string }).nodes ?? 'all'}`);
  }
}

main()
  .catch((e) => console.error('ERR', e.message))
  .finally(() => prisma.$disconnect());
