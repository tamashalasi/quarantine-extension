import { Builder, By } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import assert from 'node:assert/strict';

const output = resolve('dist/browser-tests');
await mkdir(output, { recursive: true });
const uuid = '86e1d3aa-226b-40b4-acdf-f1f9b2d1c810';
const options = new firefox.Options()
  .addArguments('-headless')
  .setPreference(
    'extensions.webextensions.uuids',
    JSON.stringify({ 'quarantine@quarantine.extension': uuid }),
  );
if (process.env.FIREFOX_PATH) options.setBinary(process.env.FIREFOX_PATH);
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(
    '<!doctype html><html><body><h1>Fixture page</h1><button id="fixture">Underlying content</button></body></html>',
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let driver;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function gateRoot() {
  for (const host of await driver.findElements(By.css('quarantine-overlay, body > div'))) {
    try {
      const root = await host.getShadowRoot();
      if ((await root.findElements(By.css('.hold'))).length) return root;
    } catch {
      /* Ordinary divs have no shadow root. */
    }
  }
}
async function gated(phrase) {
  await driver.wait(
    async () => {
      try {
        const root = await gateRoot();
        return (
          root &&
          (await (await root.findElement(By.css('h1, .description'))).getText()).includes(phrase)
        );
      } catch (error) {
        if (
          ['StaleElementReferenceError', 'NoSuchElementError', 'DetachedShadowRootError'].includes(
            error.name,
          )
        )
          return false;
        throw error;
      }
    },
    10000,
    `Missing gate ${phrase}`,
  );
}
async function hold(ms) {
  const root = await driver.wait(gateRoot, 10000);
  const button = await root.findElement(By.css('.hold'));
  await driver.actions({ async: true }).move({ origin: button }).press().perform();
  await pause(ms);
  await driver.actions({ async: true }).release().perform();
  await pause(300);
}
async function editor() {
  await driver.wait(
    async () => {
      const inputs = await driver.findElements(By.id('duration'));
      return inputs.length && (await inputs[0].isDisplayed());
    },
    10000,
    'Settings did not unlock',
  );
}
try {
  driver = await new Builder()
    .forBrowser('firefox')
    .setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder().addArguments('--allow-system-access'))
    .build();
  await driver.manage().window().setRect({ width: 1100, height: 900 });
  await driver.installAddon(resolve('dist/quarantine-firefox.zip'), true);
  const settings = `moz-extension://${uuid}/settings.html`;
  await driver.get(settings);
  await gated('A pause before changing things.');
  await hold(250);
  await gated('A pause before changing things.');
  await hold(10400);
  await editor();
  const duration = await driver.findElement(By.id('duration'));
  await duration.clear();
  await duration.sendKeys('1');
  await driver.findElement(By.id('global')).click();
  await driver.findElement(By.id('add')).click();
  await driver
    .findElement(By.css('input[aria-label="Rule 1 selector text"]'))
    .sendKeys('127.0.0.1');
  await driver.wait(
    async () =>
      (await driver.findElement(By.id('save-status')).getText()) === 'All changes are saved',
    10000,
  );
  assert.equal((await driver.findElements(By.css('button[type="submit"], #lock'))).length, 0);
  await driver.navigate().refresh();
  await editor();
  assert.equal(await driver.findElement(By.id('duration')).getAttribute('value'), '1');
  const settingsHandle = await driver.getWindowHandle();
  await driver.switchTo().newWindow('tab');
  await driver.get(`${base}/one`);
  const first = await driver.getWindowHandle();
  await gated('A moment before the internet.');
  await hold(1300);
  await gated('Is this where you want to be?');
  await hold(1300);
  await driver.wait(async () => !(await gateRoot()), 10000);
  await driver.switchTo().newWindow('tab');
  await driver.get(`${base}/two`);
  const second = await driver.getWindowHandle();
  await pause(500);
  assert.equal(await gateRoot(), undefined);
  await driver.switchTo().window(first);
  await driver.close();
  await driver.switchTo().window(second);
  await driver.navigate().refresh();
  await pause(500);
  assert.equal(await gateRoot(), undefined);
  await driver.get('about:blank');
  await pause(500);
  await driver.get(`${base}/three`);
  await gated('Is this where you want to be?');
  await writeFile(join(output, 'firefox-gate.png'), await driver.takeScreenshot(), 'base64');
  await driver.switchTo().window(settingsHandle);
  await editor();
  await driver.navigate().refresh();
  await editor();
  await driver.setContext('chrome');
  await driver.executeScript(
    `const { CustomizableUI } = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs'); CustomizableUI.addWidgetToArea('quarantine_quarantine_extension-browser-action', CustomizableUI.AREA_NAVBAR);`,
  );
  await driver.findElement(By.id('quarantine_quarantine_extension-BAP')).click();
  await driver.setContext('content');
  await gated('A pause before changing things.');
  await driver.switchTo().window(second);
  await gated('A moment before the internet.');
  await hold(1300);
  await gated('Is this where you want to be?');
  // Pin and click the actual browser toolbar action, through Firefox's test-only chrome context.
  await driver.setContext('chrome');
  await driver.executeScript(
    `const { CustomizableUI } = ChromeUtils.importESModule('moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs'); CustomizableUI.addWidgetToArea('quarantine_quarantine_extension-browser-action', CustomizableUI.AREA_NAVBAR);`,
  );
  await driver.findElement(By.id('quarantine_quarantine_extension-BAP')).click();
  await driver.setContext('content');
  await gated('A moment before the internet.');
  await writeFile(
    join(output, 'firefox-result.json'),
    JSON.stringify(
      {
        browser: (await driver.getCapabilities()).get('browserVersion'),
        result: 'passed',
        scenarios: [
          'hold cancellation',
          'settings gate',
          'save',
          'separate global and page gates',
          'cross-tab unlock',
          'reload',
          'last matching tab navigation',
          'settings reload',
          'lock all',
          'toolbar click',
        ],
      },
      null,
      2,
    ),
  );
  console.log('Firefox integration tests passed.');
} finally {
  await driver?.quit();
  server.close();
}
