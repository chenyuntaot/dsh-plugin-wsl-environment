# DSH WSL Environment

A third-party DeepSeek Harness Desktop preview bundle that selects where **Agent shell commands** run, without changing the workspace or DSH's file tools.

## Requirements

- DeepSeek Harness Desktop `0.2.2-rc.5` on Windows. The bundle targets this version exactly; other builds are not verified.
- Windows Subsystem for Linux 2. Open a native ext4 project under `/home/<user>/<project>` using `\\wsl.localhost\<distribution>\…` or `\\wsl$\<distribution>\…`.
- The selected distribution needs `/bin/bash`, `/usr/bin/python3` (with `pidfd_open`, `pidfd_send_signal`, and `memfd_create`), Bubblewrap at `/usr/bin/bwrap`, and `libseccomp.so.2`. On Ubuntu these come from `bash`, `python3`, `bubblewrap` and `libseccomp2`; any project build tools must also be installed in the distribution.
- Use the built-in Standard or Creator Agent preset, and **Read only** or **Workspace write** for WSL commands. Full access and PTC/Minimal are not supported by the WSL runner. Windows mode retains DSH's existing behavior.

## Install and try the preview

1. Get the bundle source and build a tarball with `pnpm pack` from the repository root. This is a GitHub-ready preview, not yet a published release.
2. In DSH Desktop's **Settings → Plugins**, use **Add plugin** with the local `.tgz` or the absolute source package directory. Use the generated `.tgz` if your Windows installation does not support linking directly to a WSL UNC directory. No changes to the DSH installation are required.
3. Open the WSL project in a **new** session. The dropdown beside the permission control should show the detected WSL distribution. Select Windows or WSL before sending the first message. Once accepted, the session remembers its choice and no longer allows switching.
4. With **Workspace write** and `WSL` selected, ask: “Use `wsl_bash` to run `uname -s` and `pwd -P`; only return the two outputs.” Expect `Linux` and the matching `/home/…` path. Test Windows in a **separate** new session before sending its first message. A Windows shell running from a WSL share is still subject to any DSH Windows UNC or permissions limitations.

The original file tools, file browser and manually opened terminals continue to use their existing providers. The plugin does not relax permissions or retry non-working WSL launches on Windows. On WSL, known alternative Host execution tools such as stock pwsh, PTC, workflow, Agent terminals and dynamic Cordis execution are not available through the Agent tool pipeline; third-party tools are not rewritten. Removing the plugin disables the WSL integration, so do not use an old WSL session as evidence of routing after removal.

The restricted runner does not mount Windows drives, allows ordinary IPv4/IPv6 but not local Unix or WSL IPC sockets, does not load user shell startup files, and only exposes the project plus selected system files. Project dependencies using cross-workspace hard links (for example, an existing external package store), nested mounts, or special files are refused in Workspace write mode. Use project-local caches and stores when necessary. The check also refuses very large workspaces it cannot inspect within its bound. The preview has not had an independent security audit.

## Development and verification

```sh
node test/unit.mjs
node --check client.js
```

On Windows, directly run `node test/probe-wsl-carrier.mjs` and `node test/probe-wsl-cancel.mjs` from a WSL UNC checkout. Within WSL 2 run `python3 -I test/probe-wsl-guest.py` for the native boundary and deadline tests. See [development notes](docs/DEVELOPMENT.md) for the current verification status and what the test cases do not prove.

No public release or license has been selected yet.
