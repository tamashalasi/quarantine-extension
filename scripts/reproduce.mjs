import { mkdtemp, cp, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const source = process.cwd();
const temporary = await mkdtemp(join(tmpdir(), 'quarantine-reproduce-'));
function run(args, cwd, extraEnv = {}) {
  const result = spawnSync('pnpm', args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv, BUILD_DIR: join(cwd, 'dist'), TZ: 'UTC', CI: 'true' },
  });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed`);
}
try {
  for (const name of ['first', 'second']) {
    const cwd = join(temporary, name);
    await mkdir(cwd);
    for (const entry of [
      'src',
      'scripts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'mise.toml',
      'tsconfig.json',
    ])
      await cp(resolve(source, entry), join(cwd, entry), { recursive: true });
    run(['install', '--frozen-lockfile', '--store-dir', join(temporary, `${name}-store`)], cwd);
    run(['package'], cwd);
  }
  for (const target of ['chromium', 'firefox']) {
    const file = `quarantine-${target}.zip`;
    const a = await readFile(join(temporary, 'first/dist', file));
    const b = await readFile(join(temporary, 'second/dist', file));
    if (!a.equals(b)) throw new Error(`${file} is not reproducible`);
    console.log(`IDENTICAL: ${file} (${a.length} bytes)`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
