# Development notes

## Verified

- Browser/runtime preview `0.1.0-dev.4` was packed and activated through the plugin manager of DSH Desktop `0.2.2-rc.5` on Windows. The real browser slot `conversation.input.left` reports the active `dsh-wsl-env` contribution. The application was not patched and the existing Web server was not replaced.
- A request without browser credentials is refused by the existing DSH authentication. Local tests also verify that the two exact endpoints check the browser owner, session argument, request envelope, and lifetime before handling a decision.
- Native and Windows-carried standalone tests passed on Ubuntu WSL 2. They cover the real POSIX directory, exact quoting and Unicode, denial of read-only and out-of-workspace writes (including symlink and hard-link paths), local IPC socket restrictions, loopback TCP, and Linux deadlines. The cancellation tests demonstrate explicit cancellation and carrier EOF as observed with a live guest process and background worker.
- Session unit tests cover new and legacy defaults, request races, exact Host confirmation, persistence intent, first-input latching and the absence of a silent Windows fallback. No new custom format events are inserted into DSH session logs.

- The user confirmed the live new-session acceptance test from the Desktop composer: after selecting the detected Ubuntu in Workspace write, `wsl_bash` reported `Linux` and the expected `/home/…` project path. This is an end-to-end user verification, not a screenshot or a pixel comparison. The restricted guest also completed a DNS/TLS HEAD request to the public npm registry.

## Still to verify before a public release

- Separately exercise the Windows switch in a new session, the post-send locked presentation, keyboard and light/dark rendering, and reopening DSH in a clean profile. The Windows branch leaves the built-in command tools unchanged; the two choices and first-message lock are covered by local Host and UI contract tests.
- Test an online package installation in an owned fixture and an independent distro/profile. Do not claim all WSL distributions, DSH versions, preset compositions, tool plugins, project shapes or dependency managers work.
- Review the security and interoperability limits of the WSL mount, syscall and process policies independently. Removing the plugin, an unsupported session preset, or a missing runtime must not be described as an active WSL session.

## Implementation map

- `index.js`: Host composition, per-session storage, first-input projection, and DSH tool registration.
- `lib/session-controller.mjs` and `lib/remote-host.mjs`: exact session and browser admission; use authenticated `/api` exact routes. Commit with Agent maintenance before the first model request, while the built-in Send keeps its own independent request contract. Only a Host-confirmed preference takes effect.
- `lib/wsl-carrier.mjs`, `lib/wsl-guest.py` and `lib/wsl-tool.mjs`: standing policy resolves on every execution; no model-controlled permission overrides. A protected guest receipt is required before reporting a confirmed exit or cancellation.
- `client.js`: small session-scoped selector contributed alongside the built-in permission control; use returned Host state, not browser persistence.
