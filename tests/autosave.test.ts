import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';
import { autosave } from '../src/autosave.ts';

function harness() {
  let value = 1;
  const writes: { value: number; resolve: () => void; reject: (error: Error) => void }[] = [];
  const statuses: { saving: boolean; error?: unknown }[] = [];
  const saver = autosave({
    delay: 5,
    read: () => {
      if (value < 1) throw new Error('Invalid input');
      return value;
    },
    write: (value) =>
      new Promise<void>((resolve, reject) => writes.push({ value, resolve, reject })),
    status: (saving, error) => statuses.push({ saving, error }),
  });
  return {
    saver,
    writes,
    statuses,
    edit(next: number) {
      value = next;
      saver.change();
    },
  };
}
test('autosave debounces edits and serializes newer changes behind an in-flight write', async (t) => {
  const h = harness();
  t.after(h.saver.dispose);
  h.edit(2);
  h.edit(3);
  await pause(20);
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0]!.value, 3);
  h.edit(4);
  await pause(20);
  assert.equal(h.writes.length, 1);
  h.writes[0]!.resolve();
  await pause(20);
  assert.equal(h.statuses.at(-1)!.saving, true);
  assert.equal(h.writes[1]!.value, 4);
  h.writes[1]!.resolve();
  await pause(0);
  assert.equal(h.statuses.at(-1)!.saving, false);
});
test('invalid input is not written or marked saved; correcting it resumes autosaving', async (t) => {
  const h = harness();
  t.after(h.saver.dispose);
  h.edit(0);
  await pause(20);
  assert.equal(h.writes.length, 0);
  assert.match(String(h.statuses.at(-1)!.error), /Invalid/);
  h.edit(5);
  await pause(20);
  h.writes[0]!.resolve();
  await pause(0);
  assert.equal(h.statuses.at(-1)!.saving, false);
});
test('failed writes show an error and retry without reporting success early', async (t) => {
  const h = harness();
  t.after(h.saver.dispose);
  h.edit(2);
  await pause(20);
  h.writes[0]!.reject(new Error('Disk full'));
  await pause(0);
  assert.equal(h.statuses.at(-1)!.saving, true);
  assert.match(String(h.statuses.at(-1)!.error), /Disk full/);
  await pause(1550);
  assert.equal(h.writes.length, 2);
  h.writes[1]!.resolve();
  await pause(0);
  assert.equal(h.statuses.at(-1)!.saving, false);
});
test('disposing the editor cancels pending edits and ignores in-flight responses', async () => {
  const pending = harness();
  pending.edit(2);
  pending.saver.dispose();
  await pause(20);
  assert.equal(pending.writes.length, 0);
  const h = harness();
  h.edit(2);
  await pause(20);
  h.edit(3);
  h.saver.dispose();
  h.writes[0]!.resolve();
  await pause(20);
  assert.equal(h.writes.length, 1);
  assert.equal(h.statuses.at(-1)!.saving, true);
});
