import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  Coordinator,
  defaultConfig,
  lockedSession,
  matches,
  validateConfig,
  type Rule,
} from '../src/model.ts';
const settings = 'chrome-extension://test/settings.html';
const rule = (type: Rule['type'], text: string, id = 'one'): Rule => ({ type, text, id });
const make = (rules: Rule[] = [], globalEnabled = false) =>
  new Coordinator(
    { ...defaultConfig(), duration: 1, globalEnabled, rules },
    lockedSession(),
    settings,
  );
function unlock(e: Coordinator, tab: number, token = 'token', start = 0) {
  e.begin(tab, start, token);
  e.pulse(token, tab, start + 500);
  e.complete(token, tab, start + 1000);
}

test('selectors distinguish registrable domains, private suffixes, hosts, and lookalikes', () => {
  for (const url of ['https://example.co.uk', 'https://a.b.example.co.uk:8080/path'])
    assert.ok(matches(rule('Base domain', 'example.co.uk'), url));
  assert.equal(matches(rule('Base domain', 'example.co.uk'), 'https://notexample.co.uk'), false);
  assert.equal(matches(rule('Base domain', 'alice.github.io'), 'https://bob.github.io'), false);
  assert.ok(matches(rule('Base domain', 'alice.github.io'), 'https://sub.alice.github.io'));
  assert.ok(matches(rule('Host', 'EXAMPLE.COM.'), 'https://example.com:8443/path'));
  assert.equal(matches(rule('Host', 'example.com'), 'https://sub.example.com'), false);
  assert.ok(matches(rule('Host', 'bücher.de'), 'https://xn--bcher-kva.de'));
  assert.ok(matches(rule('Base domain', 'localhost'), 'http://localhost:8080'));
  assert.ok(matches(rule('Base domain', '127.0.0.1'), 'http://127.0.0.1:8080'));
  assert.ok(matches(rule('Host', '[::1]'), 'http://[::1]:8080'));
});
test('URL selectors include query and fragment, regex is case sensitive, Never is inactive', () => {
  assert.ok(matches(rule('Exact', 'https://example.com'), 'https://example.com/'));
  assert.equal(
    matches(rule('Exact', 'https://example.com/a?q=1#x'), 'https://example.com/a?q=1#y'),
    false,
  );
  assert.ok(matches(rule('Starts with', 'https://example.com/a'), 'https://example.com/abc?q=1'));
  assert.equal(
    matches(rule('Starts with', 'https://example.com/A'), 'https://example.com/a'),
    false,
  );
  assert.ok(
    matches(rule('Regular expression', '^https://example\\.com/(a|b)'), 'https://example.com/b'),
  );
  assert.equal(matches(rule('Regular expression', '['), 'https://example.com'), false);
  for (const type of ['Never', 'Regular expression'] as const)
    assert.equal(matches(rule(type, '.*'), 'about:config'), false);
  assert.equal(matches(rule('Never', 'https://example.com'), 'https://example.com'), false);
});
test('configuration validates duration, IDs, regex and normalized input', () => {
  const config = validateConfig({
    ...defaultConfig(),
    rules: [rule('Base domain', 'Sub.Example.co.uk')],
  });
  assert.equal(config.rules[0]!.text, 'example.co.uk');
  for (const duration of [0, 301, 1.5, NaN, '10'])
    assert.throws(() => validateConfig({ ...defaultConfig(), duration }));
  for (const r of [
    rule('Host', 'https://example.com'),
    rule('Host', 'example.com:8000'),
    rule('Exact', 'about:blank'),
    rule('Regular expression', '['),
    rule('Host', ''),
  ])
    assert.throws(() => validateConfig({ ...defaultConfig(), rules: [r] }));
  assert.throws(() =>
    validateConfig({ ...defaultConfig(), rules: [rule('Host', 'a.com'), rule('Host', 'b.com')] }),
  );
  assert.doesNotThrow(() => validateConfig({ ...defaultConfig(), rules: [rule('Never', '')] }));
});
test('default install quarantines settings only', () => {
  const e = new Coordinator(defaultConfig(), lockedSession(), settings);
  e.reconcile([
    { id: 1, url: settings },
    { id: 2, url: 'https://example.com' },
  ]);
  assert.equal(e.view(1).gate?.id, 'settings');
  assert.equal(e.view(1).config, undefined);
  assert.equal(e.view(2).gate, null);
  assert.equal(e.anyUnlocked(), false);
});
test('global and overlapping page rules each require an independent hold', () => {
  const e = make(
    [rule('Host', 'example.com'), rule('Starts with', 'https://example.com', 'two')],
    true,
  );
  e.reconcile([
    { id: 1, url: 'https://example.com' },
    { id: 2, url: 'https://elsewhere.com' },
  ]);
  assert.equal(e.view(1).gate?.id, 'global');
  unlock(e, 1);
  assert.equal(e.view(2).gate, null);
  assert.equal(e.view(1).gate?.id, 'rule:one');
  unlock(e, 1);
  assert.equal(e.view(1).gate?.id, 'rule:two');
  unlock(e, 1);
  assert.equal(e.view(1).gate, null);
  e.lock();
  assert.equal(e.view(1).gate?.id, 'global');
  assert.equal(e.anyUnlocked(), false);
});
test('rule stays unlocked across matching tabs, reloads and matching navigations', () => {
  const e = make([rule('Host', 'example.com')]);
  e.reconcile([
    { id: 1, url: 'https://example.com/a' },
    { id: 2, url: 'https://example.com/b' },
  ]);
  unlock(e, 1);
  e.reconcile([
    { id: 1, url: 'https://elsewhere.com' },
    { id: 2, url: 'https://example.com/c' },
  ]);
  assert.equal(e.view(2).gate, null);
  e.reconcile([{ id: 2, url: 'https://example.com/c' }]);
  assert.equal(e.view(2).gate, null);
  e.reconcile([{ id: 2, url: 'https://elsewhere.com' }]);
  assert.deepEqual(e.session.ruleIds, []);
  e.reconcile([{ id: 3, url: 'https://example.com/a' }]);
  assert.equal(e.view(3).gate?.id, 'rule:one');
});
test('settings unlock is shared and lasts until the last settings tab leaves', () => {
  const e = make();
  e.reconcile([
    { id: 1, url: settings },
    { id: 2, url: settings },
  ]);
  unlock(e, 1);
  assert.ok(e.view(2).config);
  e.reconcile([{ id: 2, url: settings }]);
  assert.ok(e.view(2).config);
  e.reconcile([{ id: 2, url: 'https://example.com' }]);
  assert.equal(e.session.settingsUnlocked, false);
  e.reconcile([{ id: 2, url: settings }]);
  assert.equal(e.view(2).gate?.id, 'settings');
});
test('global survives last matching tab closure, but not last window closure or fresh session', () => {
  const e = make([], true);
  e.reconcile([{ id: 1, url: 'https://example.com' }]);
  unlock(e, 1);
  e.reconcile([{ id: 2, url: 'about:blank' }]);
  assert.equal(e.session.globalUnlocked, true);
  const resumed = new Coordinator(e.config, structuredClone(e.session), settings);
  resumed.reconcile([{ id: 3, url: 'https://other.com' }]);
  assert.equal(resumed.view(3).gate, null);
  resumed.reconcile([], false);
  assert.equal(resumed.session.globalUnlocked, false);
  const restarted = new Coordinator(e.config, lockedSession(), settings);
  restarted.reconcile([{ id: 1, url: 'https://example.com' }]);
  assert.equal(restarted.view(1).gate?.id, 'global');
});
test('hold is tied to its tab, gate, navigation and duration with heartbeat expiry', () => {
  const e = make([], true);
  e.reconcile([
    { id: 1, url: 'https://example.com' },
    { id: 2, url: 'https://other.com' },
  ]);
  e.begin(1, 0, 'early');
  assert.throws(() => e.complete('early', 1, 999));
  e.begin(1, 0, 'wrong-tab');
  assert.throws(() => e.complete('wrong-tab', 2, 1000));
  e.begin(1, 0, 'stale');
  assert.throws(() => e.complete('stale', 1, 2000));
  e.begin(1, 0, 'navigation');
  e.reconcile([{ id: 1, url: 'https://example.com/new' }]);
  assert.throws(() => e.complete('navigation', 1, 1000));
  e.begin(1, 0, 'cancel');
  e.cancelTab(1);
  assert.throws(() => e.complete('cancel', 1, 1000));
  e.begin(1, 0, 'locked');
  e.lock();
  assert.throws(() => e.complete('locked', 1, 1000));
  assert.equal(e.session.globalUnlocked, false);
});
test('settings writes require an unlocked settings tab and lock all scopes', () => {
  const e = make([], true);
  e.reconcile([
    { id: 1, url: settings },
    { id: 2, url: 'https://example.com' },
  ]);
  assert.throws(() => e.save(defaultConfig(), 1));
  unlock(e, 1);
  unlock(e, 2);
  assert.throws(() => e.save(defaultConfig(), 2));
  e.save({ ...defaultConfig(), duration: 15 }, 1);
  assert.equal(e.config.duration, 15);
  assert.equal(e.anyUnlocked(), false);
});
