import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, release, nextVersion } from '../scripts/release.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'quarantine-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'source');
  const remote = join(root, 'remote.git');
  await mkdir(cwd);
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('init', '--bare', remote);
  git('config', 'user.name', 'Quarantine test');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  await writeFile(join(cwd, 'package.json'), JSON.stringify({ version: '0.1.0' }) + '\n');
  git('add', '.');
  git('commit', '-m', 'Test fixture');
  git('remote', 'add', 'origin', remote);
  return { cwd, remote, git };
}

const patch = async () => 'patch';
const quiet = () => {};
const versionAt = async (cwd) =>
  JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')).version;

test('Commander parses supported flags and rejects conflicting modes and positional versions', () => {
  assert.equal(parseArgs([]).remote, 'origin');
  assert.equal(parseArgs(['--skip-tests', '--remote=upstream']).skipTests, true);
  assert.equal(parseArgs(['--help']).help, true);
  for (const args of [
    ['--tests-only', '--skip-tests'],
    ['--remote'],
    ['--remote', '--bad'],
    ['--bogus'],
    ['v1.0.0'],
    ['patch'],
  ])
    assert.throws(() => parseArgs(args));
});
test('semver increments patch, minor, major and enforces browser version limits', () => {
  assert.equal(nextVersion('1.2.3', 'patch'), '1.2.4');
  assert.equal(nextVersion('1.2.3', 'minor'), '1.3.0');
  assert.equal(nextVersion('1.2.3', 'major'), '2.0.0');
  assert.equal(nextVersion('1.2.65535', 'minor'), '1.3.0');
  for (const [version, bump] of [
    ['1.2.3', 'invalid'],
    ['01.2.3', 'patch'],
    ['1.2.3-beta.1', 'patch'],
    ['1.2.65535', 'patch'],
    ['65535.2.3', 'major'],
  ])
    assert.throws(() => nextVersion(version, bump));
});
test('tests-only runs checks without Git, version edits, or a prompt', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'quarantine-tests-only-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let checked = false;
  await release(parseArgs(['--tests-only']), {
    cwd,
    choose: async () => assert.fail('Must not prompt'),
    log: quiet,
    test: async (dir) => {
      assert.equal(dir, cwd);
      checked = true;
    },
  });
  assert.ok(checked);
});
for (const [bump, expected] of [
  ['patch', '0.1.1'],
  ['minor', '0.2.0'],
  ['major', '1.0.0'],
]) {
  test(`${bump} selection updates the version before testing, then commits and pushes the annotated tag`, async (t) => {
    const { cwd, git } = await fixture(t);
    const initialHead = git('rev-parse', 'HEAD');
    const messages = [];
    let checked = false;
    await release(parseArgs([]), {
      cwd,
      log: (message) => messages.push(message),
      choose: async (old) => {
        assert.equal(old, '0.1.0');
        return bump;
      },
      test: async () => {
        assert.equal(await versionAt(cwd), expected);
        assert.equal(git('rev-parse', 'HEAD'), initialHead);
        assert.equal(git('tag', '--list'), '');
        assert.equal(git('ls-remote', 'origin'), '');
        checked = true;
      },
    });
    assert.ok(checked);
    assert.ok(messages.includes(`Version: 0.1.0 → ${expected}`));
    assert.equal(git('cat-file', '-t', `v${expected}`), 'tag');
    assert.equal(git('rev-parse', `v${expected}^{}`), git('rev-parse', 'HEAD'));
    assert.equal(git('rev-parse', 'HEAD^'), initialHead);
    assert.equal(JSON.parse(git('show', `v${expected}:package.json`)).version, expected);
    assert.equal(git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), 'package.json');
    assert.equal(git('status', '--porcelain'), '');
    assert.match(
      git('ls-remote', 'origin', 'refs/heads/main'),
      new RegExp(git('rev-parse', 'HEAD')),
    );
    assert.match(git('ls-remote', 'origin', `refs/tags/v${expected}`), /refs\/tags\/v/);
  });
}
test('failed tests restore the original manifest without committing, tagging or pushing', async (t) => {
  const { cwd, git } = await fixture(t);
  const original = await readFile(join(cwd, 'package.json'), 'utf8');
  const head = git('rev-parse', 'HEAD');
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      choose: patch,
      log: quiet,
      test: async () => {
        throw new Error('Test failed');
      },
    }),
    /Test failed/,
  );
  assert.equal(await readFile(join(cwd, 'package.json'), 'utf8'), original);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('tag', '--list'), '');
  assert.equal(git('ls-remote', 'origin'), '');
});
test('cancelling the version prompt leaves the repository untouched', async (t) => {
  const { cwd, git } = await fixture(t);
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      log: quiet,
      choose: async () => {
        throw new Error('Cancelled');
      },
      test: async () => assert.fail('Must not test'),
    }),
    /Cancelled/,
  );
  assert.equal(await versionAt(cwd), '0.1.0');
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(git('tag', '--list'), '');
});
test('skip-tests still prompts, bumps, commits, and publishes', async (t) => {
  const { cwd, git } = await fixture(t);
  let prompted = false;
  await release(parseArgs(['--skip-tests']), {
    cwd,
    log: quiet,
    choose: async () => {
      prompted = true;
      return 'minor';
    },
    test: async () => assert.fail('Must not run'),
  });
  assert.ok(prompted);
  assert.equal(await versionAt(cwd), '0.2.0');
  assert.match(git('ls-remote', 'origin', 'refs/tags/v0.2.0'), /refs\/tags\/v0.2.0/);
});
test('dirty trees are rejected before prompting and existing tags before changing the version', async (t) => {
  const { cwd, git } = await fixture(t);
  const stray = join(cwd, 'uncommitted.txt');
  await writeFile(stray, 'uncommitted');
  await assert.rejects(
    release(parseArgs([]), { cwd, choose: async () => assert.fail('Must not prompt') }),
    /uncommitted/,
  );
  await rm(stray);
  git('tag', 'v0.1.1');
  await assert.rejects(release(parseArgs([]), { cwd, choose: patch, log: quiet }), /Local tag/);
  git('push', 'origin', 'v0.1.1');
  git('tag', '-d', 'v0.1.1');
  await assert.rejects(release(parseArgs([]), { cwd, choose: patch, log: quiet }), /Remote tag/);
  assert.equal(await versionAt(cwd), '0.1.0');
  assert.equal(git('status', '--porcelain'), '');
});
test('concurrent commits prevent tagging and are never rolled back', async (t) => {
  const { cwd, git } = await fixture(t);
  let changedHead;
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      choose: patch,
      log: quiet,
      test: async () => {
        await writeFile(join(cwd, 'change.txt'), 'change');
        git('add', '.');
        git('commit', '-m', 'Concurrent change');
        changedHead = git('rev-parse', 'HEAD');
      },
    }),
    /changed during testing/,
  );
  assert.equal(git('rev-parse', 'HEAD'), changedHead);
  assert.equal(git('tag', '--list'), '');
  assert.equal(git('ls-remote', 'origin'), '');
});
test('concurrent manifest edits are preserved on failure', async (t) => {
  const { cwd, git } = await fixture(t);
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      choose: patch,
      log: quiet,
      test: async () => {
        await writeFile(join(cwd, 'package.json'), '{"version":"3.0.0"}\n');
      },
    }),
    /Files or the index changed/,
  );
  assert.equal(await versionAt(cwd), '3.0.0');
  assert.equal(git('tag', '--list'), '');
});
test('rejected atomic pushes retain the release commit and tag without a partial remote update', async (t) => {
  const { cwd, remote, git } = await fixture(t);
  const head = git('rev-parse', 'HEAD');
  const hook = join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  await assert.rejects(
    release(parseArgs(['--skip-tests']), { cwd, choose: patch, log: quiet }),
    /release commit and local tag v0.1.1 were kept/,
  );
  assert.equal(git('tag', '--list'), 'v0.1.1');
  assert.equal(git('rev-parse', 'HEAD^'), head);
  assert.equal(git('ls-remote', 'origin'), '');
});
