import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs, release } from '../scripts/release.mjs';

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

test('release flags reject contradictory modes and malformed arguments', () => {
  assert.equal(parseArgs([]).remote, 'origin');
  assert.equal(parseArgs(['0.1.0']).tag, 'v0.1.0');
  assert.equal(parseArgs(['--skip-tests', '--remote', 'upstream', 'v0.1.0']).skipTests, true);
  for (const args of [
    ['--tests-only', '--skip-tests'],
    ['--tests-only', 'v0.1.0'],
    ['--remote'],
    ['--remote', '--bad'],
    ['--bogus'],
    ['v1.0.0', 'v2.0.0'],
  ])
    assert.throws(() => parseArgs(args));
});
test('tests-only runs checks without requiring Git or producing a tag', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'quarantine-tests-only-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  let checked = false;
  await release(parseArgs(['--tests-only']), {
    cwd,
    test: async (dir) => {
      assert.equal(dir, cwd);
      checked = true;
    },
  });
  assert.ok(checked);
});
test('successful tests precede annotated tag creation and atomic branch/tag push', async (t) => {
  const { cwd, git } = await fixture(t);
  let checked = false;
  await release(parseArgs([]), {
    cwd,
    test: async () => {
      assert.equal(git('tag', '--list'), '');
      assert.equal(git('ls-remote', 'origin'), '');
      checked = true;
    },
  });
  assert.ok(checked);
  assert.equal(git('cat-file', '-t', 'v0.1.0'), 'tag');
  assert.match(git('ls-remote', 'origin', 'refs/heads/main'), new RegExp(git('rev-parse', 'HEAD')));
  assert.match(git('ls-remote', 'origin', 'refs/tags/v0.1.0'), /refs\/tags\/v0.1.0/);
});
test('failed local tests leave local tags and the remote unchanged', async (t) => {
  const { cwd, git } = await fixture(t);
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      test: async () => {
        throw new Error('Test failed');
      },
    }),
    /Test failed/,
  );
  assert.equal(git('tag', '--list'), '');
  assert.equal(git('ls-remote', 'origin'), '');
});
test('skip-tests still checks the version and safely publishes the tag', async (t) => {
  const { cwd, git } = await fixture(t);
  await assert.rejects(release(parseArgs(['--skip-tests', 'v0.2.0']), { cwd }), /must match/);
  await release(parseArgs(['--skip-tests']), {
    cwd,
    test: async () => {
      throw new Error('Must not run');
    },
  });
  assert.match(git('ls-remote', 'origin', 'refs/tags/v0.1.0'), /refs\/tags\/v0.1.0/);
});
test('dirty trees and an existing remote tag are rejected before testing', async (t) => {
  const { cwd, git } = await fixture(t);
  const stray = join(cwd, 'uncommitted.txt');
  await writeFile(stray, 'uncommitted');
  await assert.rejects(
    release(parseArgs([]), { cwd, test: async () => assert.fail('Checks should not run') }),
    /uncommitted/,
  );
  await rm(stray);
  git('tag', 'v0.1.0');
  git('push', 'origin', 'v0.1.0');
  git('tag', '-d', 'v0.1.0');
  await assert.rejects(
    release(parseArgs([]), { cwd, test: async () => assert.fail('Checks should not run') }),
    /Remote tag/,
  );
});
test('changing HEAD during tests prevents release of an untested commit', async (t) => {
  const { cwd, git } = await fixture(t);
  await assert.rejects(
    release(parseArgs([]), {
      cwd,
      test: async () => {
        await writeFile(join(cwd, 'change.txt'), 'change');
        git('add', '.');
        git('commit', '-m', 'Concurrent change');
      },
    }),
    /changed during testing/,
  );
  assert.equal(git('tag', '--list'), '');
  assert.equal(git('ls-remote', 'origin'), '');
});
test('rejected atomic pushes retain the local tag without partially updating the remote', async (t) => {
  const { cwd, remote, git } = await fixture(t);
  const hook = join(remote, 'hooks/pre-receive');
  await writeFile(hook, '#!/bin/sh\nexit 1\n');
  await chmod(hook, 0o755);
  await assert.rejects(release(parseArgs(['--skip-tests']), { cwd }), /local tag v0.1.0 was kept/);
  assert.equal(git('tag', '--list'), 'v0.1.0');
  assert.equal(git('ls-remote', 'origin'), '');
});
