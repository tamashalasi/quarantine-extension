import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const usage = `Usage: pnpm release [--tests-only | --skip-tests] [--remote origin] [vX.Y.Z]

Default: run local checks, create an annotated tag matching package.json, then
atomically push the current branch and that tag. Commit all changes first.

  --tests-only  Run checks without creating tags or pushing; no Git repo needed.
  --skip-tests  Tag and push without running checks.
  --remote NAME Remote to push (default: origin).
  vX.Y.Z        Optional tag; must match the committed package.json version.
`;

export function parseArgs(args) {
  const options = {
    testsOnly: false,
    skipTests: false,
    remote: 'origin',
    tag: undefined,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--tests-only') options.testsOnly = true;
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--remote') {
      const remote = args[++i];
      if (!remote || !/^[a-zA-Z0-9][\w.-]*$/.test(remote))
        throw new Error('Provide a remote name after --remote.');
      options.remote = remote;
    } else if (/^v?\d+\.\d+\.\d+$/.test(arg) && !options.tag)
      options.tag = arg.startsWith('v') ? arg : `v${arg}`;
    else throw new Error(`Unknown or duplicate argument: ${arg}`);
  }
  if (options.testsOnly && options.skipTests)
    throw new Error('--tests-only and --skip-tests cannot be combined.');
  if (options.testsOnly && options.tag)
    throw new Error('--tests-only does not create a tag; omit the version.');
  return options;
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

export async function release(options, { cwd = process.cwd(), test = runLocalTests } = {}) {
  if (options.help) {
    console.log(usage);
    return;
  }
  if (options.testsOnly) {
    await test(cwd);
    console.log('Local checks passed. No tag created or pushed.');
    return;
  }
  const git = (...args) => run('git', args, cwd, {}, true);
  const root = git('rev-parse', '--show-toplevel');
  if (resolve(root) !== resolve(cwd))
    throw new Error('Run the release script from the repository root.');
  const version = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')).version;
  if (
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
    version.split('.').some((part) => Number(part) > 65535)
  )
    throw new Error('package.json must contain a browser-compatible X.Y.Z version.');
  const tag = options.tag ?? `v${version}`;
  if (tag !== `v${version}`)
    throw new Error(
      `Tag must match package.json: v${version}. Update and commit the version first.`,
    );
  const branch = git('symbolic-ref', '--quiet', '--short', 'HEAD');
  const head = git('rev-parse', 'HEAD');
  function clean() {
    if (git('status', '--porcelain', '--untracked-files=all'))
      throw new Error('Commit or remove all uncommitted files before releasing.');
  }
  function tagAbsent() {
    if (git('tag', '--list', tag))
      throw new Error(`Local tag ${tag} already exists; inspect it before retrying.`);
    if (git('ls-remote', '--tags', options.remote, `refs/tags/${tag}`))
      throw new Error(`Remote tag ${tag} already exists.`);
  }
  clean();
  git('remote', 'get-url', '--push', options.remote);
  tagAbsent();
  if (!options.skipTests) await test(cwd);
  else console.log('Skipping local checks as requested.');
  clean();
  if (
    git('rev-parse', 'HEAD') !== head ||
    git('symbolic-ref', '--quiet', '--short', 'HEAD') !== branch
  )
    throw new Error('The checked-out commit or branch changed during testing; release cancelled.');
  tagAbsent();
  git('tag', '-a', tag, '-m', `Quarantine ${tag}`, head);
  try {
    run(
      'git',
      [
        'push',
        '--atomic',
        options.remote,
        `${head}:refs/heads/${branch}`,
        `refs/tags/${tag}:refs/tags/${tag}`,
      ],
      cwd,
    );
  } catch (error) {
    throw new Error(
      `${error.message}\nThe local tag ${tag} was kept. Atomic push prevents a partial remote update. Resolve the push failure and retry the same branch/tag push; do not force-push the tag.`,
    );
  }
  console.log(
    `Pushed ${branch} and ${tag}. GitHub Actions will build and publish the release assets.`,
  );
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    await release(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
