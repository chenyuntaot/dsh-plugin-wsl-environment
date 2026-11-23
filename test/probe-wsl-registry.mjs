// Optional smoke test: requires ordinary network access to the public npm registry.
// Sends a HEAD request only; does not install a package or send workspace data.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareGuestLaunch } from '../lib/wsl-carrier.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const path = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '');
const workspace = parseWslWorkspace(path);
assert.ok(process.platform === 'win32' && workspace, 'use Windows Node to invoke the WSL project');
const spec = prepareGuestLaunch({
  policy: { workspaceRoot: path, mode: 'read-only' }, workspace, workingDirectory: path,
  windowsRoot: process.env.SystemRoot, seconds: 15,
  command: `python3 -I -c 'import urllib.request; r=urllib.request.Request("https://registry.npmjs.org/zod", method="HEAD"); print(urllib.request.urlopen(r, timeout=8).status)'`,
});
const { WSLENV, WSL_INTEROP, ...env } = process.env;
const result = spawnSync(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, env, input: spec.stdio.stdin.data,
  encoding: 'utf8', timeout: 23000, windowsHide: true });
assert.ifError(result.error);
assert.equal(result.status, 0, result.stderr);
assert.equal(result.stdout.trim(), '200');
console.log('PASS: HTTPS and DNS reach the public npm package registry inside the WSL sandbox');
