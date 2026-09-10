import browser, { request } from './api';
import { mountGate } from './gate';
import type { View } from './model';

// Installation injection and declarative injection may both run on the same document.
const marker = '__quarantineContentLoaded';
const scope = globalThis as typeof globalThis & Record<string, unknown>;
if (!scope[marker]) {
  scope[marker] = true;
  let current: ReturnType<typeof mountGate> | undefined;
  let host: HTMLElement | undefined;
  let gateKey: string | undefined;
  let requestId = 0;
  let hasState = false;
  let previousFocus: HTMLElement | null = null;
  function render(view: View) {
    const key = view.gate ? `${view.gate.id}:${view.duration}` : undefined;
    if (key === gateKey) return;
    current?.destroy();
    current = undefined;
    host = undefined;
    gateKey = key;
    if (!key) {
      previousFocus?.focus({ preventScroll: true });
      previousFocus = null;
      return;
    }
    previousFocus ??= document.activeElement instanceof HTMLElement ? document.activeElement : null;
    host = document.createElement('quarantine-overlay');
    host.style.setProperty('all', 'initial', 'important');
    document.documentElement.append(host);
    current = mountGate(
      host,
      view,
      undefined,
      () => {
        void refresh();
      },
      () => {
        void request({ kind: 'open-settings' });
      },
    );
  }
  async function refresh() {
    const id = ++requestId;
    try {
      const view = await request<View>({ kind: 'view' });
      if (id === requestId) {
        hasState = true;
        render(view);
      }
    } catch {
      // Keep an existing gate closed while the extension is unavailable.
      if (id === requestId && !hasState && !gateKey) {
        const view: View = {
          gate: {
            id: 'unavailable',
            title: 'Quarantine needs a refresh.',
            description: 'Reload this page to reconnect to the extension.',
          },
          duration: 10,
          anyUnlocked: false,
        };
        render(view);
      }
    }
  }
  function start() {
    // Mount nothing until the coordinator confirms a gate, so unlocked pages never flash one.
    void refresh();
    new MutationObserver(() => {
      if (host && !host.isConnected) {
        document.documentElement.append(host);
        current?.show();
      }
    }).observe(document.documentElement, { childList: true });
  }
  if (document.documentElement) start();
  else {
    const observer = new MutationObserver(() => {
      if (document.documentElement) {
        observer.disconnect();
        start();
      }
    });
    observer.observe(document, { childList: true });
  }
  browser.runtime.onMessage.addListener((message: unknown) => {
    if ((message as { kind?: string })?.kind === 'refresh') void refresh();
  });
  window.addEventListener('pageshow', () => {
    void refresh();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void refresh();
  });
  document.addEventListener('fullscreenchange', () => current?.show());
}
