import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WSL_USER_TERMINAL_ID, resolveWslUserTerminalProfiles, wslUserTerminalProfile } from '../lib/user-terminal-profile.mjs';

const base = {
  platform: 'win32', windowsRoot: String.raw`C:\Windows`,
  choice: { mode: 'wsl', target: { distro: 'Ubuntu-26.04', linuxPath: '/home/alina/project' } },
  workingDirectory: String.raw`\\wsl.localhost\Ubuntu-26.04\home\alina\project`,
};

test('only an ordinary Windows-hosted session which selected WSL receives a profile', () => {
  assert.equal(wslUserTerminalProfile({ ...base, choice: { mode: 'windows' } }), undefined);
  assert.equal(wslUserTerminalProfile({ ...base, platform: 'linux' }), undefined);
  assert.equal(wslUserTerminalProfile({ ...base, ordinarySession: false }), undefined);
  assert.equal(wslUserTerminalProfile(base).preferred, true);
});

test('the WSL profile passes the distro and valid current Linux cwd as separate arguments', () => {
  const directory = `${base.workingDirectory}\\中文 & 空格`;
  assert.deepEqual(wslUserTerminalProfile({ ...base, workingDirectory: directory }), {
    id: WSL_USER_TERMINAL_ID, name: 'WSL · Ubuntu-26.04', preferred: true,
    launch: {
      path: String.raw`C:\Windows\System32\wsl.exe`,
      args: ['--distribution', 'Ubuntu-26.04', '--cd', '/home/alina/project/中文 & 空格'],
      hostCwd: String.raw`C:\Windows\System32`, displayCwd: '/home/alina/project/中文 & 空格',
    },
  });
});

test('invalid or changed directories leave WSL unavailable, not a Windows default', () => {
  for (const workingDirectory of [
    `${base.workingDirectory}-other`, base.workingDirectory.replace('Ubuntu-26.04', 'Debian'),
    String.raw`C:\work`, `${base.workingDirectory}\\..\\escape`,
  ]) {
    const profile = wslUserTerminalProfile({ ...base, workingDirectory });
    assert.equal(profile.id, WSL_USER_TERMINAL_ID);
    assert.equal(profile.preferred, true);
    assert.equal(profile.launch, undefined);
    assert.ok(profile.unavailableReason);
  }
  const missingWindows = wslUserTerminalProfile({ ...base, windowsRoot: undefined });
  assert.equal(missingWindows.launch, undefined);
  assert.ok(missingWindows.unavailableReason);
});

function hostOptions(terminalEnvironment, getChoice = () => base.choice) {
  return {
    platform: base.platform, windowsRoot: base.windowsRoot, getChoice,
    agent: { session: { header: {} }, ctx: { get: name => name === 'subprocess'
      ? { terminalEnvironment } : { get: () => base.workingDirectory } } },
  };
}

test('a missing or failing PTY execution world cannot turn a WSL default into Windows', async () => {
  for (const terminalEnvironment of [
    async () => ({ platform: 'posix' }), async () => { throw new Error('offline'); },
  ]) {
    const [profile] = await resolveWslUserTerminalProfiles(hostOptions(terminalEnvironment), new AbortController().signal);
    assert.equal(profile.id, WSL_USER_TERMINAL_ID);
    assert.equal(profile.preferred, true);
    assert.equal(profile.launch, undefined);
    assert.ok(profile.unavailableReason);
  }
});

test('profiles resolve the latest mode after an asynchronous terminal provider check', async () => {
  let choice = base.choice;
  const pending = Promise.withResolvers();
  const request = resolveWslUserTerminalProfiles(hostOptions(() => pending.promise, () => choice), new AbortController().signal);
  choice = { mode: 'windows' };
  pending.resolve({ platform: 'windows' });
  assert.deepEqual(await request, []);
});
