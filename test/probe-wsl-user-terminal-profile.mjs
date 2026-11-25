// Standalone profile-launch smoke test; this is not a GUI or PTY lifecycle test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { wslUserTerminalProfile } from '../lib/user-terminal-profile.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const workingDirectory = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '');
const target = parseWslWorkspace(workingDirectory);
assert.ok(process.platform === 'win32' && target, 'run Windows Node from a WSL UNC checkout');
const profile = wslUserTerminalProfile({
  platform: process.platform, choice: { mode: 'wsl', target }, workingDirectory, windowsRoot: process.env.SystemRoot,
});
assert.ok(profile?.launch, profile?.unavailableReason);
const { path, args, hostCwd } = profile.launch;
const result = spawnSync(path, [...args, '--exec', '/bin/sh', '-c', 'uname -s; pwd -P'], {
  cwd: hostCwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 12000, windowsHide: true,
});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u), ['Linux', target.linuxPath]);
console.log('PASS: the native human-terminal profile resolves the expected distro and Linux project directory');
