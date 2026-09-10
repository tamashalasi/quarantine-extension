import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle = await build({
  entryPoints: ['src/hold.ts'],
  bundle: true,
  write: false,
  format: 'iife',
  globalName: 'hold',
  plugins: [
    {
      name: 'hold-harness',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'harness' }));
        builder.onLoad({ filter: /.*/, namespace: 'harness' }, () => ({
          contents: 'export const request = globalThis.testRequest;',
        }));
      },
    },
  ],
});
function harness() {
  const listeners = new Map();
  const frames = new Map();
  const timers = new Map();
  const pending = [];
  const unlocked = [];
  let now = 0;
  let id = 0;
  let progress = 0;
  const button = {
    style: {
      setProperty: (_, value) => {
        progress = Number(value);
      },
    },
    setAttribute() {},
    setPointerCapture() {},
    focus() {},
    addEventListener: (name, listener) => listeners.set(name, listener),
  };
  const context = {
    AbortController,
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    performance: { now: () => now },
    requestAnimationFrame: (fn) => {
      frames.set(++id, fn);
      return id;
    },
    cancelAnimationFrame: (key) => frames.delete(key),
    setTimeout: (fn) => {
      timers.set(++id, fn);
      return id;
    },
    clearTimeout: (key) => timers.delete(key),
    testRequest: (message) =>
      new Promise((resolve, reject) => pending.push({ ...message, resolve, reject })),
  };
  runInNewContext(bundle.outputFiles[0].text, context);
  const dispose = context.hold.holdButton(button, {}, 10, undefined, (view) => unlocked.push(view));
  return {
    button,
    pending,
    unlocked,
    frames,
    dispose,
    progress: () => progress,
    press: () => listeners.get('pointerdown')({ button: 0, pointerId: 1, isTrusted: true }),
    release: () => listeners.get('pointerup')(),
    frame(time) {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((fn) => fn(time));
    },
    tick() {
      const callbacks = [...timers.values()];
      timers.clear();
      callbacks.forEach((fn) => fn());
    },
  };
}
test('progress advances every frame during a delayed heartbeat without displaying remaining seconds', async () => {
  const h = harness();
  h.press();
  h.pending.shift().resolve({ token: 'hold', duration: 1 });
  await setImmediate();
  assert.equal(h.pending[0].kind, 'pulse');
  for (const time of [16, 32, 48, 64, 80]) {
    h.frame(time);
    assert.equal(h.progress(), time / 1000);
    assert.equal(h.button.textContent, 'Keep holding');
  }
  h.frame(1100);
  assert.equal(h.progress(), 1);
  assert.equal(h.frames.size, 0);
  assert.equal(h.unlocked.length, 0, 'animation alone cannot unlock');
  h.pending.shift().resolve({});
  await setImmediate();
  h.tick();
  assert.equal(h.pending[0].kind, 'complete');
  assert.equal(h.unlocked.length, 0);
  h.pending.shift().resolve({ gate: null });
  await setImmediate();
  assert.equal(h.unlocked.length, 1);
  assert.equal(h.progress(), 0);
});
for (const action of ['release', 'dispose']) {
  test(`${action} stops animation and resets progress even with a pending heartbeat`, async () => {
    const h = harness();
    h.press();
    h.pending.shift().resolve({ token: 'hold', duration: 10 });
    await setImmediate();
    h.frame(500);
    assert.equal(h.progress(), 0.05);
    h[action]();
    assert.equal(h.frames.size, 0);
    assert.equal(h.progress(), 0);
    h.pending.shift().resolve({});
    await setImmediate();
    h.frame(10000);
    h.tick();
    assert.equal(h.progress(), 0);
    assert.equal(h.unlocked.length, 0);
  });
}
test('releasing before begin responds never starts an animation', async () => {
  const h = harness();
  h.press();
  h.release();
  h.pending.shift().resolve({ token: 'late', duration: 10 });
  await setImmediate();
  assert.equal(h.frames.size, 0);
  assert.equal(h.progress(), 0);
});
