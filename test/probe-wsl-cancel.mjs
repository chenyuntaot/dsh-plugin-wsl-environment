import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, realpathSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { prepareControlledGuestLaunch } from '../lib/wsl-carrier.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '');
assert.ok(process.platform === 'win32' && parseWslWorkspace(root), 'run using Windows Node in a WSL workspace');
for (const explicit of [true, false]) {
  const fixture = mkdtempSync(join(root, '.dsh-cancel-test-'));
  const heartbeat = join(fixture, 'heartbeat');
  assert.equal(realpathSync.native(dirname(fixture)), realpathSync.native(root));
  assert.ok(basename(fixture).startsWith('.dsh-cancel-test-'));
  const prepared = prepareControlledGuestLaunch({
    policy: { mode: 'workspace-write', workspaceRoot: fixture }, workspace: parseWslWorkspace(fixture),
    workingDirectory: fixture, windowsRoot: process.env.SystemRoot, seconds: 8,
    command: '(while true; do printf . >> heartbeat; sleep 0.03; done) &\nwhile [ ! -s heartbeat ]; do sleep 0.02; done\nprintf "ready\\n"\nwait',
  });
  const { WSLENV, WSL_INTEROP, ...env } = process.env;
  const proc = spawn(prepared.spec.argv[0], prepared.spec.argv.slice(1), {
    cwd: prepared.spec.cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
  const deadline = setTimeout(() => proc.kill(), 18000);
  let stdout = '', stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('ready') && !proc.stdin.writableEnded) {
      if (explicit) proc.stdin.end('!');
      else proc.stdin.end();
    }
  });
  proc.stdin.on('error', () => {});
  proc.stdin.write(prepared.input);
  try {
    const [code] = await once(proc, 'close');
    assert.equal(code, 130, stderr);
    assert.equal(prepared.inspectExit(stderr).state, 'cancelled', stderr);
    const atExit = readFileSync(heartbeat);
    assert.ok(atExit.length > 0, 'worker did not run before cancellation');
    await delay(180);
    assert.deepEqual(readFileSync(heartbeat), atExit, 'Linux worker survived confirmed cancellation');
  } finally {
    clearTimeout(deadline);
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    try { unlinkSync(heartbeat); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmdirSync(fixture);
  }
}
console.log('PASS: explicit Windows cancellation and EOF both reap the guest descendants');
