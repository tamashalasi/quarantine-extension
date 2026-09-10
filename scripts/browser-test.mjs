import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';

const extension = resolve('dist/chromium');
const output = resolve('dist/browser-tests');
await mkdir(output, { recursive: true });
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><html><head><title>Quarantine fixture</title></head><body><h1>Fixture page</h1><button id="fixture" onclick="this.textContent=\'Clicked\'">Underlying button</button><a href="/pause/next">Next page</a></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), 'quarantine-browser-'));
let context;
const errors = [];
async function waitFor(fn, message) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}
const sessions = new WeakMap();
async function nodes(page) {
  let cdp = sessions.get(page);
  if (!cdp) {
    cdp = await context.newCDPSession(page);
    sessions.set(page, cdp);
    await cdp.send('DOM.enable');
  }
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const all = [];
  const visit = (node) => {
    all.push(node);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child);
  };
  visit(root);
  return { cdp, all };
}
async function holdNode(page) {
  const { cdp, all } = await nodes(page);
  return {
    cdp,
    node: all.find(
      (node) =>
        node.nodeName === 'BUTTON' &&
        node.attributes?.some((a, i) => a === 'class' && node.attributes[i + 1] === 'hold'),
    ),
  };
}
async function text(page) {
  return (await nodes(page)).all
    .filter((node) => node.nodeType === 3)
    .map((node) => node.nodeValue)
    .join(' ');
}
async function gated(page, phrase) {
  await waitFor(async () => (await text(page)).includes(phrase), `Missing gate: ${phrase}`);
}
async function hold(page, ms) {
  await page.bringToFront();
  await waitFor(async () => Boolean((await holdNode(page)).node), 'Hold button not found');
  const { cdp, node } = await holdNode(page);
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
  const [x1, y1, x2, , , y2] = model.border;
  await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
  await page.waitForTimeout(250);
}
async function launch() {
  return chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    ...(process.env.BRAVE_PATH ? { executablePath: process.env.BRAVE_PATH } : {}),
    headless: true,
    viewport: { width: 1100, height: 850 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--no-sandbox',
    ],
  });
}
try {
  context = await launch();
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/settings.html`);
  await gated(options, 'A pause before changing things.');
  await hold(options, 250);
  await gated(options, 'A pause before changing things.');
  await hold(options, 10400);
  await options.locator('#duration').waitFor({ state: 'visible' });
  await options.locator('#duration').fill('1');
  await options.locator('#global').check();
  await options.getByRole('button', { name: 'Add rule', exact: true }).click();
  await options.getByLabel('Rule 1 selector text', { exact: true }).fill('127.0.0.1');
  await options.getByRole('button', { name: 'Add rule', exact: true }).click();
  await options.getByLabel('Rule 2 selector type', { exact: true }).selectOption('Starts with');
  await options.getByLabel('Rule 2 selector text', { exact: true }).fill(`${base}/pause`);
  await options.getByRole('button', { name: 'Save & lock', exact: true }).click();
  await gated(options, 'A pause before changing things.');
  const page = await context.newPage();
  await page.goto(`${base}/pause/a`);
  const second = await context.newPage();
  await second.goto(`${base}/pause/b`);
  await page.bringToFront();
  await gated(page, 'A moment before the internet.');
  await page.screenshot({
    path: join(output, `${process.env.BRAVE_PATH ? 'brave' : 'chromium'}-gate.png`),
  });
  // Keyboard hold must work without repeated keydown events.
  const keyboardTarget = await holdNode(page);
  const remote = await keyboardTarget.cdp.send('DOM.resolveNode', {
    backendNodeId: keyboardTarget.node.backendNodeId,
  });
  await keyboardTarget.cdp.send('Runtime.callFunctionOn', {
    objectId: remote.object.objectId,
    functionDeclaration: 'function() { this.focus(); }',
  });
  await page.keyboard.down('Space');
  await page.waitForTimeout(1300);
  await page.keyboard.up('Space');
  await gated(page, 'Host: 127.0.0.1');
  // Exercise real touch input through Chromium's input protocol.
  const touchTarget = await holdNode(page);
  const touchBox = await touchTarget.cdp.send('DOM.getBoxModel', {
    backendNodeId: touchTarget.node.backendNodeId,
  });
  const [tx1, ty1, tx2, , , ty2] = touchBox.model.border;
  await touchTarget.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
  await touchTarget.cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: (tx1 + tx2) / 2, y: (ty1 + ty2) / 2, id: 1 }],
  });
  await page.waitForTimeout(1300);
  await touchTarget.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchTarget.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
  await gated(page, `Starts with: ${base}/pause`);
  await hold(page, 1300);
  await waitFor(
    async () => !(await holdNode(page)).node && !(await holdNode(second)).node,
    'Matching pages did not share unlocks',
  );
  await page.locator('#fixture').click();
  assert.equal(await page.locator('#fixture').textContent(), 'Clicked');
  // Terminate the MV3 worker; the next request must restore unlocks from session storage.
  const lifecycle = await context.newCDPSession(page);
  let versions = [];
  lifecycle.on('ServiceWorker.workerVersionUpdated', (event) => {
    versions = event.versions;
  });
  await lifecycle.send('ServiceWorker.enable');
  await waitFor(
    () => versions.some((v) => v.scriptURL === worker.url() && v.runningStatus === 'running'),
    'Worker version missing',
  );
  const version = versions.find(
    (v) => v.scriptURL === worker.url() && v.runningStatus === 'running',
  );
  await lifecycle.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await page.reload();
  await waitFor(async () => !(await holdNode(page)).node, 'Reload lost the page unlock');
  await page.goto(`${base}/outside`);
  await second.close();
  await page.goto(`${base}/pause/again`);
  await gated(page, `Starts with: ${base}/pause`);
  await hold(page, 1300);
  await page.evaluate(() => history.pushState({}, '', '/outside'));
  await page.waitForTimeout(400);
  await page.evaluate(() => history.pushState({}, '', '/pause/spa'));
  await gated(page, `Starts with: ${base}/pause`);
  await options.bringToFront();
  await hold(options, 1300);
  await options.locator('#duration').waitFor({ state: 'visible' });
  await options.reload();
  await options.locator('#duration').waitFor({ state: 'visible' });
  const options2 = await context.newPage();
  await options2.goto(options.url());
  await options2.locator('#duration').waitFor({ state: 'visible' });
  await options.close();
  await options2.reload();
  await options2.locator('#duration').waitFor({ state: 'visible' });
  await options2.screenshot({
    path: join(output, `${process.env.BRAVE_PATH ? 'brave' : 'chromium'}-settings.png`),
  });
  await options2.getByRole('button', { name: 'Lock everything', exact: true }).click();
  await gated(options2, 'A pause before changing things.');
  await gated(page, 'A moment before the internet.');
  await hold(options2, 1300);
  await options2.locator('#duration').waitFor({ state: 'visible' });
  const optionsUrl = options2.url();
  await options2.close();
  const reopened = await context.newPage();
  await reopened.goto(optionsUrl);
  await gated(reopened, 'A pause before changing things.');
  // A new browser process must retain configuration and discard all unlocks.
  await page.bringToFront();
  await hold(page, 1300);
  await context.close();
  context = await launch();
  const restarted = await context.newPage();
  await restarted.goto(`${base}/pause/restarted`);
  await gated(restarted, 'A moment before the internet.');
  assert.deepEqual(errors, []);
  await writeFile(
    join(output, `${process.env.BRAVE_PATH ? 'brave' : 'chromium'}-result.json`),
    JSON.stringify(
      {
        browser: context.browser()?.version(),
        result: 'passed',
        scenarios: [
          'hold cancellation',
          'keyboard and touch holds',
          'service worker suspension',
          'browser restart',
          'settings gate',
          'saved configuration',
          'global and overlapping gates',
          'cross-tab unlock',
          'reload',
          'last matching tab',
          'SPA navigation',
          'settings lifetime',
          'lock all',
        ],
        errors,
      },
      null,
      2,
    ),
  );
  console.log('Browser integration tests passed.');
} catch (error) {
  console.error('Page errors:', errors);
  if (context)
    for (const page of context.pages())
      console.error(page.url(), (await text(page).catch(() => '')).slice(-2000));
  throw error;
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
