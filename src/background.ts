import browser from './api';
import { Coordinator, defaultConfig, lockedSession, validateConfig, type Session } from './model';
import type { Runtime } from 'webextension-polyfill';

const settingsUrl = browser.runtime.getURL('settings.html');
let engine: Coordinator | undefined;
let queue = Promise.resolve<unknown>(undefined);
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work);
  queue = next.catch((error) => {
    console.error('Quarantine:', error instanceof Error ? error.message : String(error));
  });
  return next;
}
async function getEngine() {
  if (!engine) {
    const [local, session] = await Promise.all([
      browser.storage.local.get('config'),
      browser.storage.session.get('unlocks'),
    ]);
    const config = local.config ? validateConfig(local.config) : defaultConfig();
    const raw = session.unlocks as Partial<Session> | undefined;
    const unlocks = raw
      ? {
          globalUnlocked: raw.globalUnlocked === true,
          settingsUnlocked: raw.settingsUnlocked === true,
          ruleIds: Array.isArray(raw.ruleIds)
            ? raw.ruleIds.filter((id): id is string => typeof id === 'string')
            : [],
        }
      : lockedSession();
    engine = new Coordinator(config, unlocks, settingsUrl);
    // Prevent web content scripts from bypassing the coordinator via local storage.
    const storage = browser.storage.local as typeof browser.storage.local & {
      setAccessLevel?: (value: { accessLevel: string }) => Promise<void>;
    };
    await storage.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  }
  return engine;
}
async function reconcile(override?: { id: number; url: string }) {
  const e = await getEngine();
  const [tabs, windows] = await Promise.all([browser.tabs.query({}), browser.windows.getAll({})]);
  e.reconcile(
    tabs
      .filter((t) => !t.incognito && t.id !== undefined)
      .map((t) => ({
        id: t.id!,
        url: override && override.id === t.id ? override.url : (t.url ?? ''),
      })),
    windows.some((w) => !w.incognito),
  );
  return e;
}
async function persist(e: Coordinator) {
  await browser.storage.session.set({ unlocks: e.session });
  const open = e.anyUnlocked();
  await Promise.all([
    browser.action.setIcon({
      path: Object.fromEntries(
        [16, 32, 48, 128].map((size) => [
          size,
          `icons/${open ? 'unlocked' : 'locked'}-${size}.png`,
        ]),
      ),
    }),
    browser.action.setTitle({
      title: open
        ? 'Quarantine: something is unlocked. Click to lock everything.'
        : 'Quarantine: all quarantines locked. Right-click for settings.',
    }),
  ]);
}
async function notify(e: Coordinator) {
  await persist(e);
  await Promise.allSettled([
    ...e.tabs
      .filter((t) => !e.isSettings(t.url))
      .map((t) => browser.tabs.sendMessage(t.id, { kind: 'refresh' })),
    browser.runtime.sendMessage({ kind: 'refresh' }),
  ]);
}
async function context(
  message: Record<string, unknown>,
  sender: Runtime.MessageSender,
  e: Coordinator,
) {
  if (sender.id !== browser.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0))
    throw new Error('Unsupported message sender.');
  const settings = e.isSettings(sender.url ?? '');
  const tabId =
    sender.tab?.id ?? (settings && typeof message.tabId === 'number' ? message.tabId : undefined);
  if (tabId === undefined) throw new Error('Open settings in a browser tab.');
  const tab = await browser.tabs.get(tabId);
  if (tab.incognito || (settings && !e.isSettings(tab.url ?? '')) || (!settings && !sender.tab))
    throw new Error('Unsupported tab.');
  return { tabId, settings, tab };
}

browser.runtime.onMessage.addListener((raw: unknown, sender: Runtime.MessageSender) => {
  if (!raw || typeof raw !== 'object') return;
  const message = raw as Record<string, unknown>;
  if (message.kind === 'refresh') return;
  return serial(async () => {
    const e = await reconcile();
    const { tabId, settings, tab } = await context(message, sender, e);
    switch (message.kind) {
      case 'view':
        await persist(e);
        return e.view(tabId);
      case 'open-settings':
        await browser.runtime.openOptionsPage();
        return null;
      case 'cancel':
        e.cancelTab(tabId);
        return null;
      case 'begin':
      case 'pulse':
      case 'complete': {
        const window = await browser.windows.get(tab.windowId!);
        if (!tab.active || !window.focused) {
          e.cancelTab(tabId);
          throw new Error('Keep this tab focused while holding.');
        }
        if (message.kind === 'begin') return e.begin(tabId, Date.now(), crypto.randomUUID());
        if (typeof message.token !== 'string') throw new Error('Missing hold token.');
        if (message.kind === 'pulse') {
          e.pulse(message.token, tabId, Date.now());
          return null;
        }
        e.complete(message.token, tabId, Date.now());
        await notify(e);
        return e.view(tabId);
      }
      case 'save':
        if (!settings) throw new Error('Settings can only be edited on the settings page.');
        // Persist configuration before updating runtime state so a failed write does not apply a partial save.
        if (!e.session.settingsUnlocked) throw new Error('Unlock settings before saving.');
        const config = validateConfig(message.config);
        await browser.storage.local.set({ config });
        e.save(config, tabId);
        await notify(e);
        return null;
      case 'lock':
        if (!settings) throw new Error('Use the toolbar to lock all pages.');
        e.lock();
        await notify(e);
        return null;
      default:
        throw new Error('Unknown Quarantine request.');
    }
  }).then(
    (value) => ({ value }),
    (error) => ({ error: error instanceof Error ? error.message : String(error) }),
  );
});

function update(override?: { id: number; url: string }) {
  void serial(async () => notify(await reconcile(override)));
}
browser.tabs.onCreated.addListener(() => update());
browser.tabs.onRemoved.addListener(() => update());
browser.tabs.onReplaced.addListener(() => update());
browser.tabs.onUpdated.addListener((id, change) => {
  if (change.url) update({ id, url: change.url });
});
browser.tabs.onActivated.addListener(({ tabId }) => {
  void serial(async () => {
    const e = await getEngine();
    for (const hold of e.holds.values()) if (hold.tabId !== tabId) e.cancelTab(hold.tabId);
  });
});
browser.windows.onFocusChanged.addListener(() => {
  void serial(async () => {
    const e = await getEngine();
    for (const hold of e.holds.values()) {
      try {
        const tab = await browser.tabs.get(hold.tabId);
        const window = await browser.windows.get(tab.windowId!);
        if (!window.focused || !tab.active) e.cancelTab(hold.tabId);
      } catch {
        e.cancelTab(hold.tabId);
      }
    }
  });
});
for (const event of [
  browser.webNavigation.onCommitted,
  browser.webNavigation.onHistoryStateUpdated,
  browser.webNavigation.onReferenceFragmentUpdated,
]) {
  event.addListener((details) => {
    if (details.frameId === 0) update({ id: details.tabId, url: details.url });
  });
}
browser.windows.onRemoved.addListener(() => update());
browser.action.onClicked.addListener(() => {
  void serial(async () => {
    const e = await reconcile();
    e.lock();
    await notify(e);
  });
});
browser.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'settings') void browser.runtime.openOptionsPage();
});
browser.runtime.onInstalled.addListener(() => {
  void serial(async () => {
    await browser.contextMenus.removeAll();
    browser.contextMenus.create({
      id: 'settings',
      title: 'Quarantine settings',
      contexts: ['action'],
    });
    const e = await reconcile();
    e.lock();
    await notify(e);
    // Cover tabs that were already open when the extension was installed or updated.
    await Promise.allSettled(
      e.tabs
        .filter((t) => /^https?:/.test(t.url))
        .map((t) =>
          browser.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }),
        ),
    );
  });
});
browser.runtime.onStartup.addListener(() => {
  void serial(async () => {
    const e = await reconcile();
    e.lock();
    await notify(e);
  });
});
update();
