# Quarantine

A browser extension that gives you a deliberate pause before browsing. Inspired by [tamashalasi/quarantine](https://github.com/tamashalasi/quarantine), with independent global, page, and settings quarantines.

Works on current desktop Brave, Chromium, and Firefox. Everything stays in your browser: no account, server, analytics, cloud sync, or remote code.

## Get started

1. Open the [latest release](../../releases/latest) and download the ZIP for your browser. Older versions are on the [releases page](../../releases).
2. Extract the ZIP into a folder you will keep, then install it:
   - **Brave / Chromium:** download `quarantine-chromium.zip`, open `brave://extensions` or `chrome://extensions`, enable **Developer mode**, choose **Load unpacked**, and select the extracted folder.
   - **Firefox:** download `quarantine-firefox.zip`, open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and select `manifest.json` in the extracted folder. This unsigned installation lasts until Firefox closes; permanent installation requires a Mozilla-signed release.
3. Pin Quarantine to the toolbar. Right-click its icon and choose **Quarantine settings**.
4. Hold the settings button for **10 seconds**, then enable global quarantine or add page rules. Initially, global quarantine is off and no page rules are configured.

Settings are also accessible through the browser's extension-management page or a quarantine overlay. To update a Chromium/Brave installation, replace the files in the same folder and click **Reload** on its extension card.

## How it works

Hold the button with the primary mouse button, touch, or the Space/Enter key. Releasing early, changing focus, or leaving the page resets the countdown. Each quarantine requires a separate hold; global quarantine comes first, followed by matching rules in their saved order.

The shared duration applies to every quarantine, including settings. It accepts whole seconds from 1 to 300. **Save & lock** applies changes and relocks everything.

| Quarantine | Unlock lifetime                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global     | Until the browser exits, its last window closes, or you explicitly lock everything.                                                                 |
| Page rule  | While at least one tab matching that rule remains open, across all normal windows. Closing or navigating away from the last match relocks the rule. |
| Settings   | While at least one settings tab remains open. Closing or navigating away from the last settings tab relocks settings.                               |

Switching tabs and reloading preserve completed unlocks. Matching background/discarded tabs still count as open. Browser restart, extension reload/update, or clicking the toolbar icon clears temporary unlocks. Configuration survives browser restart.

**Left-click the toolbar icon to lock everything**, including open settings tabs. An amber open padlock means at least one quarantine is unlocked; a green closed padlock means none are unlocked. Unrestricted pages do not count as an unlock. The tooltip also states the status.

### Page selectors

Each rule has a selector type and selector text. Rules overlap independently; one unlocked rule does not bypass another matching rule.

| Type               | Example                                | Meaning                                                                                                                                                                                              |
| ------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base domain        | `example.co.uk`                        | This registrable domain and its subdomains. A bundled Public Suffix List includes private suffixes, so `alice.github.io` and `bob.github.io` are separate. IP addresses and localhost match exactly. |
| Host               | `www.example.com`                      | Exactly this hostname, case-insensitive, on any scheme or port. Enter no scheme, path, or port.                                                                                                      |
| Exact              | `https://example.com/path?q=1#section` | The entire browser-normalized URL, including query and fragment.                                                                                                                                     |
| Starts with        | `https://example.com/path`             | A case-sensitive prefix of the browser-normalized URL; this example also matches `/pathway`.                                                                                                         |
| Regular expression | `^https://example[.]com/news`          | A JavaScript regex against the complete URL, without `/` delimiters or flags. Invalid expressions cannot be saved.                                                                                   |
| Never              | Any retained text                      | An inactive rule that matches nothing. Switch its type to reactivate it.                                                                                                                             |

Domain inputs are normalized, including internationalized hostnames. Exact URLs are normalized using the browser URL parser. At most 200 rules and 2,048 characters per selector are supported. Avoid regex patterns with excessive backtracking, which can slow rule evaluation.

### Limits and permissions

Quarantine overlays ordinary HTTP/HTTPS pages. Browser-internal pages (`chrome://`, `brave://`, `about:`), extension pages other than its own settings, browser-protected sites such as add-on stores, built-in PDF viewers, and local files cannot reliably be covered. Private browsing is disabled. Permission restrictions set by the browser can also prevent coverage.

The overlay blocks page interaction, but does not stop downloads, scripts, media, or background network requests. This is a habit aid, not an enforcement or parental-control boundary. You can disable/uninstall it, and page code or developer tools can interfere with an overlay. Initial injection is early but cannot promise that no content is ever briefly painted.

Permissions are used as follows:

- HTTP/HTTPS host access and `scripting`: display overlays, including in tabs already open at installation.
- `tabs` and `webNavigation`: evaluate URLs and keep rule membership correct across tabs, reloads, and SPA navigation. Tab URLs are processed locally, not logged or uploaded.
- `storage`: save settings locally and temporary unlocks in memory for this browser session.
- `contextMenus`: expose settings without replacing the toolbar's lock action.

---

## Development and reproducible builds

### Build and install from source

Install [mise](https://mise.jdx.dev/), then run:

```sh
mise trust
mise install node pnpm
mise exec -- pnpm install --frozen-lockfile
mise run package
```

Node **24.21.0 LTS** and pnpm **12.3.4** are pinned in `mise.toml`. The `packageManager` field also pins pnpm. Use pnpm for project dependencies and commit `pnpm-lock.yaml` when changing them.

Load `dist/chromium` as an unpacked extension in Brave/Chromium, or load `dist/firefox/manifest.json` as a temporary add-on in Firefox, following the browser instructions above.

### Development commands

```sh
mise run dev               # Rebuild JavaScript bundles on edits; reload the extension/page
mise run format            # oxfmt
mise run lint              # oxlint
mise run typecheck         # tsc --noEmit
mise run check             # lint + formatting check + type checking
mise run test              # Selector, lifecycle, authorization, and background tests
mise run package           # Build both browser directories and deterministic ZIPs
```

Reload the development watcher when changing manifests or build scripts. Unsaved settings edits are discarded if another tab saves settings or you lock everything.

The background coordinator owns configuration and unlocks. Chromium uses an MV3 service worker; Firefox uses an event page. `storage.session` preserves unlocks across background suspension. The content script and options page share the same isolated dialog and hold control. Holds require continuous input, a focused tab/window, background-issued tokens, and heartbeats; navigation or locking invalidates pending tokens.

### Browser tests

Install a current Firefox and Playwright's Chromium, including the OS libraries they need:

```sh
mise exec -- pnpm exec playwright install --with-deps chromium
mise run package
mise run test:browser
mise run test:firefox
BRAVE_PATH=/path/to/brave mise run test:browser
```

`FIREFOX_PATH=/path/to/firefox` selects a Firefox binary. Selenium Manager obtains geckodriver on first run. The Firefox test enables geckodriver's system-access option in its disposable test profile to navigate extension pages and click the actual toolbar action. All browser tests use disposable profiles and a local fixture server; they do not touch your normal browser profile.

Tests cover interrupted mouse holds, keyboard/touch holds, independent overlapping gates, shared unlocks, reloads, SPA navigation, settings lifetime, background suspension, restart, and locking. Screenshots and result files are written under `dist/browser-tests`. See `docs/validation.md` for the tested browser versions and coverage boundaries.

### Reproducible builds

The reproducible artifacts are **unsigned ZIPs**, one per browser. Store signing and publication are separate; store signatures and store-generated packages are not claimed to be byte-identical to these ZIPs.

The build pins its Node/pnpm toolchain and dependency integrity hashes. ZIP entries have sorted paths, fixed timestamps and permissions, and deterministic compression. Bundles contain no absolute checkout paths or build timestamps. Third-party license notices are included.

#### Independent clean builds

```sh
mise run reproduce
```

This copies build inputs into two separate temporary directories, installs each with `pnpm install --frozen-lockfile` and an independent pnpm store, builds both browsers, and requires byte-identical ZIPs. It deletes the temporary directories afterward. Dependency downloads require network access.

#### Reproduce with the pinned container

Requires Docker with Linux amd64 support. The base image is pinned by digest in `build-support/Dockerfile`; pnpm's exact version matches mise. The pnpm bootstrap tarball is also pinned by SHA-256. The base image's npm is used only to install that verified package-manager executable, with lifecycle scripts disabled.

For a release, check out its exact tag in a clean checkout. Compare the commit with the reference `build-info.json` before building:

```sh
docker build --platform linux/amd64 \
  --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" \
  -f build-support/Dockerfile -t quarantine-build .
mkdir -p dist/rebuild
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$PWD/dist/rebuild:/out" quarantine-build
```

Download the reference unsigned ZIPs and metadata into `dist/reference`, then compare:

```sh
cmp dist/reference/quarantine-chromium.zip dist/rebuild/quarantine-chromium.zip
cmp dist/reference/quarantine-firefox.zip dist/rebuild/quarantine-firefox.zip
(cd dist/rebuild && sha256sum -c SHA256SUMS)
```

`build-info.json` records the source commit, Node and pnpm versions, lockfile hash, and artifact hashes. Builds outside a Git checkout use `uncommitted` unless `SOURCE_COMMIT` is provided. The two browser ZIPs differ intentionally because their manifests differ.

Dependency changes should update exact versions, the lockfile, toolchain pins where applicable, and reproducibility checks together.

### Test and release locally

Install dependencies and browser-test prerequisites above before running the release script. Run these commands from the repository root:

```sh
mise exec -- pnpm release --tests-only   # Checks only; never tags or pushes
mise exec -- pnpm release                # Checks, then tags and pushes
mise exec -- pnpm release --skip-tests   # Tags and pushes without checks
```

Local checks run oxlint, oxfmt, tsc, unit/background/release-script tests, packaging, Chromium and Firefox integration tests, and two clean reproducibility builds. Set `BRAVE_PATH=/path/to/brave` to include the Brave suite as well. `--tests-only` works without a Git checkout. It cannot be combined with `--skip-tests`.

Before releasing, update `package.json` to the desired `X.Y.Z` version and commit all changes, including the lockfile when dependencies change. Configure a Git remote named `origin` pointing to your GitHub repository, and authenticate Git pushes. The script defaults to an annotated `vX.Y.Z` tag matching `package.json`; you can supply that tag explicitly and choose another remote:

```sh
mise exec -- pnpm release --remote origin v0.1.0
```

The script requires a clean working tree and an attached branch, rejects existing local or remote tags, and verifies that HEAD did not change during testing. After checks pass, it creates the tag and atomically pushes **only the current branch and that tag**. It does not commit changes, bump versions, force-push, or push unrelated tags. A failed push keeps the local tag for inspection and retry; atomic push prevents a partial branch/tag update.

The tag triggers `.github/workflows/release.yml`. The workflow builds with the pinned Linux amd64 container and publishes `quarantine-chromium.zip`, `quarantine-firefox.zip`, `SHA256SUMS`, and `build-info.json` on GitHub Releases. It uploads assets to a draft before publishing; reruns can resume an incomplete draft but cannot overwrite an already published release. The workflow performs no tests—testing happens locally before tagging unless you explicitly choose `--skip-tests`.

GitHub Actions must be enabled for the repository. The workflow uses its built-in token with `contents: write`; no release secret is required. These releases contain unsigned extension files, not browser-store signatures.
