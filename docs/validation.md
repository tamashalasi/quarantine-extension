# Validation

The initial implementation was checked on Linux on 2026-09-10.

| Check                                          | Result                                      |
| ---------------------------------------------- | ------------------------------------------- |
| oxlint, oxfmt, tsc                             | Passed                                      |
| Selector/state/background/release-script tests | 25 passed                                   |
| Chromium 153.0.8010.12                         | Integration suite passed                    |
| Brave 1.94.121                                 | Integration suite passed                    |
| Firefox 155.0.1                                | Integration suite passed                    |
| Two clean builds with independent pnpm stores  | Both ZIPs byte-identical                    |
| Pinned Linux amd64 Docker build                | Both ZIPs byte-identical to the local build |

Automated browser tests use real input with installed extensions and a local HTTP fixture. Model/background tests additionally cover matching private suffixes, IDNs, IP addresses, overlapping rules, invalid configuration, sender authorization, rejected writes, last-window closure, and startup/session recovery.

Manual checks for each release:

- Pin the action, inspect both icon states, and lock from the toolbar across multiple windows.
- Close the last window while Chromium background mode remains enabled, reopen a window, and check that global quarantine is locked.
- Restore a previous browser session with matching tabs and verify all gates start locked.
- Check discarded tabs and browser Back/Forward cache navigation.
- Check fullscreen pages, pages containing iframes, system light/dark themes, narrow settings layouts, and screen-reader focus/countdown behavior.
- Confirm private browsing and browser-protected pages are excluded as documented.

The manual checklist describes additional release coverage; it is not a claim that every listed situation has been manually exercised in this environment. Unsigned Firefox temporary installations do not survive browser restart, so restart persistence is exercised in Chromium/Brave and in coordinator tests. Release workflow jobs only build and publish; checks run locally.
