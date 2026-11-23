// Standalone test for Windows -> WSL stdin transport. Not an installed DSH test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareGuestLaunch } from '../lib/wsl-carrier.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const path = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '');
const workspace = parseWslWorkspace(path);
assert.ok(process.platform === 'win32' && workspace, 'run with Windows Node from a WSL UNC checkout');
const options = {
  policy: { workspaceRoot: path, mode: 'read-only' }, workspace, workingDirectory: path,
  windowsRoot: process.env.SystemRoot, seconds: 4,
  command: 'uname -s\npwd -P\nprintf "%s\\n" \'special $;& \\ 漢字\'',
};
const spec = prepareGuestLaunch(options);
assert.ok(!spec.argv.some(arg => arg.includes('special')), 'model command must not be on the Windows command line');
assert.throws(() => prepareGuestLaunch({ ...options, policy: { ...options.policy, mode: 'danger-full-access' } }));
assert.throws(() => prepareGuestLaunch({ ...options, workingDirectory: `${path}-outside` }));
const { WSLENV, WSL_INTEROP, ...env } = process.env;
const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
  cwd: spec.cwd, env, input: spec.stdio.stdin.data, encoding: 'utf8', timeout: 15000,
});
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
assert.deepEqual(result.stdout.trimEnd().split(/\r?\n/u), ['Linux', workspace.linuxPath, 'special $;& \\ 漢字']);
console.log('PASS: Windows carrier preserves nested quoting, Unicode and the Linux directory');
