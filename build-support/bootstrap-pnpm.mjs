// Bootstrap only the package-manager executable. Project dependencies always use pnpm.
import { createHash } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const version = '12.3.4';
const checksum = '08a3d2d539b377a6b7ea2469b612672255ca71c30a62698530582cb9d35c268f';
const response = await fetch(`https://registry.npmjs.org/pnpm/-/pnpm-${version}.tgz`);
if (!response.ok) throw new Error(`pnpm download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== checksum)
  throw new Error('pnpm checksum mismatch');
const file = '/tmp/quarantine-pnpm.tgz';
await writeFile(file, archive);
try {
  const result = spawnSync('npm', ['install', '--global', '--ignore-scripts', file], {
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error('pnpm bootstrap failed');
} finally {
  await rm(file, { force: true });
}
