import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, Option } from 'commander';
import select from '@inquirer/select';
import semver from 'semver';

function command() {
  return new Command()
    .name('pnpm release')
    .description(
      'Choose a version bump, test it, commit it, then atomically push the branch and release tag.',
    )
    .helpOption(false)
    .option('-h, --help', 'display help')
    .addOption(
      new Option(
        '--tests-only',
        'run checks without prompting, changing versions, committing, tagging, or pushing',
      ).conflicts('skipTests'),
    )
    .addOption(
      new Option('--skip-tests', 'bump, commit, tag, and push without running checks').conflicts(
        'testsOnly',
      ),
    )
    .option('--remote <name>', 'Git remote to push', 'origin')
    .allowExcessArguments(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {} });
}

export function parseArgs(args) {
  const options = command().parse(args, { from: 'user' }).opts();
  if (!/^[a-zA-Z0-9][\w.-]*$/.test(options.remote))
    throw new Error('Provide a valid remote name after --remote.');
  return options;
}

function validateVersion(version) {
  if (
    typeof version !== 'string' ||
    !/^\d+\.\d+\.\d+$/.test(version) ||
    semver.valid(version) !== version ||
    version.split('.').some((part) => Number(part) > 65535)
  ) {
    throw new Error('package.json must contain a browser-compatible X.Y.Z version.');
  }
}

export function nextVersion(version, bump) {
  if (!['patch', 'minor', 'major'].includes(bump))
    throw new Error('Choose patch, minor, or major.');
  validateVersion(version);
  const next = semver.inc(version, bump);
  if (!next || next.split('.').some((part) => Number(part) > 65535))
    throw new Error('The new version exceeds the browser version limit of 65535 per component.');
  return next;
}

async function chooseBump(version) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Run a release in an interactive terminal to choose patch, minor, or major.');
  return select({
    message: `Current version: ${version}. Which version update?`,
    choices: ['patch', 'minor', 'major'].map((value) => ({
      name: `${value[0].toUpperCase()}${value.slice(1)} (${semver.inc(version, value)})`,
      value,
    })),
  });
}

function run(command, args, cwd, extraEnv = {}, capture = false) {
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(
      `${command} ${args.join(' ')} failed${result.stderr ? `: ${result.stderr.trim()}` : ''}`,
    );
  return result.stdout?.trim() ?? '';
}

export async function runLocalTests(cwd) {
  for (const task of ['check', 'test', 'package']) run('pnpm', [task], cwd);
  run('pnpm', ['test:browser'], cwd, { BRAVE_PATH: '' });
  run('pnpm', ['test:firefox'], cwd);
  if (process.env.BRAVE_PATH) run('pnpm', ['test:browser'], cwd);
  else console.log('Brave smoke test omitted: set BRAVE_PATH to include it.');
  run('pnpm', ['reproduce'], cwd);
}

export async function release(
  options,
  { cwd = process.cwd(), test = runLocalTests, choose = chooseBump, log = console.log } = {},
) {
  if (options.help) {
    log(command().helpInformation());
    return;
  }
  if (options.testsOnly) {
    await test(cwd);
    log('Local checks passed. No version changed, commit or tag created, or push performed.');
    return;
  }
  const git = (...args) => run('git', args, cwd, {}, true);
  const root = git('rev-parse', '--show-toplevel');
  if (resolve(root) !== resolve(cwd))
    throw new Error('Run the release script from the repository root.');
  const file = resolve(cwd, 'package.json');
  const original = await readFile(file, 'utf8');
  const pkg = JSON.parse(original);
  validateVersion(pkg.version);
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  const unchangedHead = () =>
    git('rev-parse', 'HEAD') === head &&
    git('symbolic-ref', '--quiet', '--short', 'HEAD') === branch;
  function clean() {
    if (git('status', '--porcelain', '--untracked-files=all'))
      throw new Error('Commit or remove all uncommitted files before releasing.');
  }
  clean();
  const pushUrls = git('remote', 'get-url', '--push', '--all', options.remote).split('\n');
  if (pushUrls.length !== 1)
    throw new Error('The release remote must have exactly one push URL for an atomic release.');
  const oldVersion = pkg.version;
  const version = nextVersion(oldVersion, await choose(oldVersion));
  const tag = `v${version}`;
  log(`Version: ${oldVersion} → ${version}`);
  function tagAbsent() {
    if (git('tag', '--list', tag))
      throw new Error(`Local tag ${tag} already exists; inspect it before retrying.`);
    if (git('ls-remote', '--tags', pushUrls[0], `refs/tags/${tag}`))
      throw new Error(`Remote tag ${tag} already exists.`);
  }
  clean();
  if (!unchangedHead())
    throw new Error(
      'The checked-out commit or branch changed while choosing a version; release cancelled.',
    );
  tagAbsent();
  const updated = JSON.stringify({ ...pkg, version }, null, 2) + '\n';
  await writeFile(file, updated);
  try {
    if (!options.skipTests) await test(cwd);
    else log('Skipping local checks as requested.');
    if (!unchangedHead())
      throw new Error(
        'The checked-out commit or branch changed during testing; release cancelled.',
      );
    if (
      (await readFile(file, 'utf8')) !== updated ||
      git('status', '--porcelain', '--untracked-files=all') !== 'M package.json' ||
      git('diff', '--cached', '--name-only')
    ) {
      throw new Error('Files or the index changed during testing; release cancelled.');
    }
    tagAbsent();
  } catch (error) {
    // Restore only our own edit, never concurrent user edits or commits.
    if (
      unchangedHead() &&
      (await readFile(file, 'utf8')) === updated &&
      !git('diff', '--cached', '--name-only')
    ) {
      await writeFile(file, original);
      log(`Restored package.json to ${oldVersion}; no release commit or tag created.`);
    }
    throw error;
  }
  git('add', '--', 'package.json');
  const testedTree = git('write-tree');
  git('commit', '-m', `chore: release ${tag}`);
  const releaseHead = git('rev-parse', 'HEAD');
  if (
    git('rev-parse', 'HEAD^') !== head ||
    git('rev-parse', 'HEAD^{tree}') !== testedTree ||
    git('symbolic-ref', '--quiet', '--short', 'HEAD') !== branch
  )
    throw new Error('The release commit differs from the tested files; inspect it before tagging.');
  clean();
  tagAbsent();
  git('tag', '-a', tag, '-m', `Quarantine ${tag}`, releaseHead);
  try {
    run(
      'git',
      [
        'push',
        '--atomic',
        options.remote,
        `${releaseHead}:refs/heads/${branch}`,
        `refs/tags/${tag}:refs/tags/${tag}`,
      ],
      cwd,
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nThe release commit and local tag ${tag} were kept. Atomic push prevents a partial remote update. Resolve the push failure and retry the same branch/tag push; do not force-push the tag.`,
    );
  }
  log(`Pushed ${branch} and ${tag}. GitHub Actions will build and publish the release assets.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await release(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.name === 'ExitPromptError' ? 'Release cancelled.' : error.message);
    process.exitCode = 1;
  }
}
