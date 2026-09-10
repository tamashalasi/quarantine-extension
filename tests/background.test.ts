import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { defaultConfig, lockedSession } from '../src/model.ts';

type Listener = (...args: any[]) => any;
function event() {
  const listeners: Listener[] = [];
  return {
    addListener(fn: Listener) {
      listeners.push(fn);
    },
    fire(...args: any[]) {
      return listeners.map((fn) => fn(...args));
    },
  };
}
function harness() {
  const local: Record<string, unknown> = {
    config: { ...defaultConfig(), duration: 1, globalEnabled: true },
  };
  const session: Record<string, unknown> = { unlocks: lockedSession() };
  const settings = 'chrome-extension://test/settings.html';
  const tabs = [
    { id: 1, url: settings, windowId: 1, active: true, incognito: false },
    { id: 2, url: 'https://example.com', windowId: 1, active: false, incognito: false },
  ];
  const windows = [{ id: 1, focused: true, incognito: false }];
  let title = '';
  let failSave = false;
  const area = (store: Record<string, unknown>) => ({
    get: async (key: string) => ({ [key]: structuredClone(store[key]) }),
    set: async (value: object) => {
      if (store === local && failSave) throw new Error('Disk full');
      Object.assign(store, structuredClone(value));
    },
    setAccessLevel: async () => {},
  });
  const browser = {
    runtime: {
      id: 'test',
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
      sendMessage: async () => {},
      openOptionsPage: async () => {},
    },
    storage: { local: area(local), session: area(session) },
    tabs: {
      query: async () => structuredClone(tabs),
      get: async (id: number) => {
        const tab = tabs.find((t) => t.id === id);
        if (!tab) throw new Error('Missing tab');
        return structuredClone(tab);
      },
      sendMessage: async () => {},
      onCreated: event(),
      onRemoved: event(),
      onUpdated: event(),
      onReplaced: event(),
      onActivated: event(),
    },
    windows: {
      getAll: async () => structuredClone(windows),
      get: async () => structuredClone(windows[0]),
      onRemoved: event(),
      onFocusChanged: event(),
    },
    action: {
      setIcon: async () => {},
      setTitle: async (v: { title: string }) => {
        title = v.title;
      },
      onClicked: event(),
    },
    contextMenus: { onClicked: event(), removeAll: async () => {}, create: () => {} },
    webNavigation: {
      onCommitted: event(),
      onHistoryStateUpdated: event(),
      onReferenceFragmentUpdated: event(),
    },
    scripting: { executeScript: async () => {} },
  };
  async function boot() {
    const result = await build({
      entryPoints: ['src/background.ts'],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'node',
      plugins: [
        {
          name: 'browser-mock',
          setup(b) {
            b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'mock' }));
            b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
              contents: 'export default globalThis.__quarantineTestBrowser;',
            }));
          },
        },
      ],
    });
    (globalThis as any).__quarantineTestBrowser = browser;
    await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}#${crypto.randomUUID()}`
    );
    delete (globalThis as any).__quarantineTestBrowser;
  }
  async function send(
    kind: string,
    extra: Record<string, unknown> = {},
    sender: any = { id: 'test', url: settings },
  ) {
    const responses = browser.runtime.onMessage.fire({ kind, tabId: 1, ...extra }, sender);
    return await responses.find(Boolean);
  }
  return {
    browser,
    tabs,
    windows,
    local,
    session,
    settings,
    boot,
    send,
    title: () => title,
    failSave: () => {
      failSave = true;
    },
  };
}

test('background enforces sender, focus and settings authorization; toolbar and last window clear session', async () => {
  const h = harness();
  await h.boot();
  assert.equal((await h.send('view')).value.gate.id, 'settings');
  assert.match((await h.send('view', {}, { id: 'foreign', url: h.settings })).error, /sender/);
  assert.match(
    (
      await h.send(
        'view',
        {},
        { id: 'test', frameId: 1, tab: h.tabs[1], url: 'https://example.com' },
      )
    ).error,
    /sender/,
  );
  assert.match((await h.send('save', { config: defaultConfig() })).error, /Unlock/);
  h.windows[0]!.focused = false;
  assert.match((await h.send('begin')).error, /focused/);
  h.windows[0]!.focused = true;
  const begin = (await h.send('begin')).value;
  await new Promise((resolve) => setTimeout(resolve, 1020));
  assert.equal((await h.send('complete', { token: begin.token })).error, undefined);
  assert.ok((await h.send('view')).value.config);
  assert.match(h.title(), /something is unlocked/);
  h.failSave();
  assert.match((await h.send('save', { config: defaultConfig() })).error, /Disk full/);
  assert.equal((await h.send('view')).value.config.globalEnabled, true);
  h.browser.action.onClicked.fire();
  assert.equal((await h.send('view')).value.gate.id, 'settings');
  assert.match(h.title(), /all quarantines locked/);
  const next = (await h.send('begin')).value;
  h.browser.tabs.onActivated.fire({ tabId: 2 });
  assert.match((await h.send('complete', { token: next.token })).error, /interrupted/);
  const last = (await h.send('begin')).value;
  await new Promise((resolve) => setTimeout(resolve, 1020));
  await h.send('complete', { token: last.token });
  h.windows.splice(0);
  h.browser.windows.onRemoved.fire(1);
  await h.send('view');
  assert.deepEqual(h.session.unlocks, lockedSession());
});

test('background resumes unlocks from session storage, while browser startup invalidates them', async () => {
  const h = harness();
  h.session.unlocks = { globalUnlocked: true, settingsUnlocked: true, ruleIds: [] };
  await h.boot();
  assert.ok((await h.send('view')).value.config);
  const sender = { id: 'test', frameId: 0, tab: h.tabs[1], url: h.tabs[1]!.url };
  assert.equal((await h.send('view', {}, sender)).value.gate, null);
  assert.match((await h.send('save', { config: defaultConfig() }, sender)).error, /only be edited/);
  h.browser.runtime.onStartup.fire();
  assert.equal((await h.send('view', {}, sender)).value.gate.id, 'global');
  assert.deepEqual(h.session.unlocks, lockedSession());
});
