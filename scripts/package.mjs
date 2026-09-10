import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { zipSync } from 'fflate';

const root = resolve(process.env.BUILD_DIR ?? 'dist');
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unexpected package entry: ${path}`);
  }
  return result.sort();
}
await mkdir(root, { recursive: true });
const hashes = {};
for (const target of ['chromium', 'firefox']) {
  const dir = join(root, target);
  const entries = {};
  for (const path of await files(dir))
    entries[relative(dir, path).replaceAll('\\', '/')] = [
      new Uint8Array(await readFile(path)),
      { mtime: new Date(2000, 0, 1), os: 3, attrs: 0o100644 << 16 },
    ];
  const bytes = zipSync(entries, { level: 9 });
  const filename = `quarantine-${target}.zip`;
  await writeFile(join(root, filename), bytes);
  hashes[filename] = sha(bytes);
}
let commit = process.env.SOURCE_COMMIT;
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    commit = 'uncommitted';
  }
}
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
await writeFile(
  join(root, 'SHA256SUMS'),
  Object.entries(hashes)
    .map(([name, hash]) => `${hash}  ${name}\n`)
    .join(''),
);
await writeFile(
  join(root, 'build-info.json'),
  JSON.stringify(
    {
      version: pkg.version,
      source_commit: commit,
      node: process.version,
      package_manager: pkg.packageManager,
      lockfile_sha256: sha(await readFile('pnpm-lock.yaml')),
      artifacts: hashes,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Packaged extensions in ${root}`);
