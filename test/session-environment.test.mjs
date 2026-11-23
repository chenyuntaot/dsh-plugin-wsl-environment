import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseEnvironment, initialEnvironment, resolveEnvironment } from '../lib/session-environment.mjs';

const workspacePath = String.raw`\\wsl.localhost\Debian\home\alina\project`;
const base = { hostPlatform: 'win32', workspacePath, started: false };

test('default is WSL for new WSL workspaces on Windows only', () => {
  assert.deepEqual(initialEnvironment(base), {
    mode: 'wsl', target: { distro: 'Debian', linuxPath: '/home/alina/project' },
  });
  assert.deepEqual(initialEnvironment({ ...base, started: true }), { mode: 'windows' });
  assert.deepEqual(initialEnvironment({ ...base, hostPlatform: 'linux' }), { mode: 'windows' });
  assert.deepEqual(initialEnvironment({ ...base, workspacePath: 'C:\\work' }), { mode: 'windows' });
});

test('choices are host-validated and after first input neither direction can change', () => {
  assert.equal(chooseEnvironment({ ...base, mode: 'wsl' }).ok, true);
  assert.deepEqual(chooseEnvironment({ ...base, mode: 'windows' }), { ok: true, choice: { mode: 'windows' } });
  assert.equal(chooseEnvironment({ ...base, mode: 'linux' }).reason, 'invalid-environment');
  assert.equal(chooseEnvironment({ ...base, mode: 'wsl', workspacePath: 'C:\\work' }).reason, 'not-a-wsl-workspace');
  for (const mode of ['wsl', 'windows']) {
    assert.deepEqual(chooseEnvironment({ ...base, mode, started: true }), { ok: false, reason: 'session-started' });
  }
});

test('unavailable or changed WSL targets stay blocked, never Windows', () => {
  const choice = initialEnvironment(base);
  assert.equal(resolveEnvironment({ ...base, choice, runnerReady: true }).status, 'ready');
  assert.deepEqual(resolveEnvironment({ ...base, choice, runnerReady: false }), {
    status: 'blocked', mode: 'wsl', reason: 'runner-unavailable',
  });
  const otherDistro = workspacePath.replace('Debian', 'Ubuntu');
  assert.equal(resolveEnvironment({ ...base, workspacePath: otherDistro, choice, runnerReady: true }).reason, 'workspace-changed');
  assert.equal(resolveEnvironment({ ...base, choice: null, runnerReady: true }).status, 'blocked');
});
