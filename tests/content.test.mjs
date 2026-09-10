import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/content.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  plugins: [
    {
      name: 'content-harness',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/(api|gate)$/ }, (args) => ({
          path: args.path,
          namespace: 'harness',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'harness' }, (args) => ({
          contents:
            args.path === './api'
              ? 'export default globalThis.testBrowser; export const request = globalThis.testRequest;'
              : 'export const mountGate = globalThis.testMountGate;',
        }));
      },
    },
  ],
});
const unlocked = { gate: null, duration: 10, anyUnlocked: true };
const locked = {
  ...unlocked,
  gate: { id: 'global', title: 'Locked', description: 'Hold to unlock' },
  anyUnlocked: false,
};
function harness() {
  const pending = [];
  const mounted = [];
  let refresh;
  class Element {
    isConnected = false;
    style = { setProperty() {} };
    append(child) {
      child.isConnected = true;
    }
    remove() {
      this.isConnected = false;
    }
    focus() {}
  }
  runInNewContext(bundle.outputFiles[0].text, {
    HTMLElement: Element,
    document: {
      documentElement: new Element(),
      activeElement: null,
      createElement: () => new Element(),
      addEventListener() {},
    },
    window: { addEventListener() {} },
    MutationObserver: class {
      observe() {}
    },
    testBrowser: {
      runtime: {
        onMessage: {
          addListener(fn) {
            refresh = () => fn({ kind: 'refresh' });
          },
        },
      },
    },
    testRequest: () =>
      new Promise((resolve, reject) => {
        pending.push({ resolve, reject });
      }),
    testMountGate: (parent, view) => {
      mounted.push({ parent, view });
      return {
        destroy() {
          parent.remove();
        },
        show() {},
      };
    },
  });
  return {
    pending,
    mounted,
    refresh: () => refresh(),
    visible: () => mounted.filter((item) => item.parent.isConnected),
  };
}

test('unlocked pages never mount an overlay, even while the initial check or recheck is pending', async () => {
  const h = harness();
  assert.equal(h.mounted.length, 0);
  h.pending.shift().resolve(unlocked);
  await setImmediate();
  h.refresh();
  assert.equal(h.mounted.length, 0);
  h.pending.shift().resolve(unlocked);
  await setImmediate();
  assert.equal(h.mounted.length, 0);
});
test('confirmed locks appear and remain visible during pending or failed rechecks', async () => {
  const h = harness();
  h.pending.shift().resolve(locked);
  await setImmediate();
  assert.equal(h.mounted.length, 1);
  assert.equal(h.visible()[0].view.gate.id, 'global');
  h.refresh();
  assert.equal(h.visible().length, 1);
  h.pending.shift().reject(new Error('Disconnected'));
  await setImmediate();
  assert.equal(h.mounted.length, 1);
  assert.equal(h.visible()[0].view.gate.id, 'global');
  h.refresh();
  h.pending.shift().resolve(unlocked);
  await setImmediate();
  assert.equal(h.visible().length, 0);
});
test('an initial check failure shows a recovery gate without relocking a known-unlocked page on later failures', async () => {
  const h = harness();
  assert.equal(h.mounted.length, 0);
  h.pending.shift().reject(new Error('Disconnected'));
  await setImmediate();
  assert.equal(h.visible()[0].view.gate.id, 'unavailable');
  h.refresh();
  h.pending.shift().resolve(unlocked);
  await setImmediate();
  assert.equal(h.visible().length, 0);
  h.refresh();
  h.pending.shift().reject(new Error('Disconnected'));
  await setImmediate();
  assert.equal(h.visible().length, 0);
  assert.equal(h.mounted.length, 1);
});
test('late responses cannot flash a stale lock after a newer unlocked result', async () => {
  const h = harness();
  const first = h.pending.shift();
  h.refresh();
  h.pending.shift().resolve(unlocked);
  await setImmediate();
  first.resolve(locked);
  await setImmediate();
  assert.equal(h.mounted.length, 0);
  h.refresh();
  h.pending.shift().resolve(locked);
  await setImmediate();
  assert.equal(h.visible()[0].view.gate.id, 'global');
});
