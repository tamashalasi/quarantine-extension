import { build, context } from 'esbuild';
import { watch as watchFiles } from 'node:fs';
import { mkdir, readFile, writeFile, copyFile, rm, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { zlibSync } from 'fflate';
import { crc32 } from 'node:zlib';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const root = resolve(process.env.BUILD_DIR ?? 'dist');
const watch = process.argv.includes('--watch');
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function icon(size, unlocked) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / size,
        py = (y + 0.5) / size;
      const body = px > 0.19 && px < 0.81 && py > 0.43 && py < 0.87;
      const dx = px - (unlocked ? 0.64 : 0.5),
        dy = py - 0.37;
      const ring =
        dx * dx + dy * dy < 0.22 ** 2 &&
        dx * dx + dy * dy > 0.125 ** 2 &&
        py < 0.46 &&
        (!unlocked || px > 0.56 || py < 0.27);
      const hole =
        (px - 0.5) ** 2 + (py - 0.61) ** 2 < 0.045 ** 2 ||
        (px > 0.48 && px < 0.52 && py > 0.61 && py < 0.73);
      const on = (body || ring) && !hole;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      raw.set(on ? (unlocked ? [190, 109, 32, 255] : [65, 111, 81, 255]) : [0, 0, 0, 0], offset);
    }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', Buffer.from(zlibSync(raw, { level: 9 }))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
for (const target of ['chromium', 'firefox']) {
  const outdir = join(root, target);
  await rm(outdir, { recursive: true, force: true });
  await mkdir(join(outdir, 'icons'), { recursive: true });
  const icons = Object.fromEntries(
    [16, 32, 48, 128].map((size) => [size, `icons/locked-${size}.png`]),
  );
  const manifest = {
    manifest_version: 3,
    name: 'Quarantine',
    version: pkg.version,
    description:
      'A deliberate pause before browsing. Hold to unlock your browser, selected pages, or settings.',
    permissions: ['storage', 'tabs', 'webNavigation', 'contextMenus', 'scripting'],
    host_permissions: ['http://*/*', 'https://*/*'],
    incognito: 'not_allowed',
    icons,
    action: {
      default_icon: icons,
      default_title: 'Quarantine: all quarantines locked. Right-click for settings.',
    },
    options_ui: { page: 'settings.html', open_in_tab: true },
    background:
      target === 'chromium' ? { service_worker: 'background.js' } : { scripts: ['background.js'] },
    content_scripts: [
      {
        matches: ['http://*/*', 'https://*/*'],
        js: ['content.js'],
        run_at: 'document_start',
        all_frames: false,
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'",
    },
    ...(target === 'chromium'
      ? { minimum_chrome_version: '120' }
      : {
          browser_specific_settings: {
            gecko: {
              id: 'quarantine@quarantine.extension',
              strict_min_version: '140.0',
              data_collection_permissions: { required: ['none'] },
            },
          },
        }),
  };
  await writeFile(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await copyFile('src/settings.html', join(outdir, 'settings.html'));
  await copyFile('src/ui.css', join(outdir, 'ui.css'));
  for (const size of [16, 32, 48, 128])
    for (const state of ['locked', 'unlocked'])
      await writeFile(join(outdir, `icons/${state}-${size}.png`), icon(size, state === 'unlocked'));
  const options = {
    entryPoints: ['src/background.ts', 'src/content.ts', 'src/settings.ts'],
    tsconfig: 'tsconfig.json',
    bundle: true,
    outdir,
    format: 'iife',
    target: ['chrome120', 'firefox140'],
    charset: 'utf8',
    legalComments: 'eof',
    sourcemap: false,
    minify: false,
    loader: { '.css': 'text' },
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else await build(options);
  const licenses = await Promise.all(
    ['tldts', 'tldts-core', 'webextension-polyfill'].map(async (name) => {
      const location =
        name === 'tldts-core'
          ? join(await realpath('node_modules/tldts'), '../tldts-core/LICENSE')
          : `node_modules/${name}/LICENSE`;
      let license;
      try {
        license = await readFile(location, 'utf8');
      } catch {
        license = await readFile(new URL('../LICENSE', import.meta.resolve(name)), 'utf8');
      }
      return `${name}\n${license}`;
    }),
  );
  await writeFile(join(outdir, 'THIRD-PARTY-LICENSES.txt'), licenses.join('\n\n'));
}

if (watch) {
  watchFiles('src', async (_event, name) => {
    if (name === 'ui.css' || name === 'settings.html') {
      for (const target of ['chromium', 'firefox'])
        await copyFile(join('src', name), join(root, target, name));
    }
  });
}
