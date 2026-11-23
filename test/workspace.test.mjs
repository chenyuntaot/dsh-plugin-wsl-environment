import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLexicallyWithin, parseWslWorkspace } from '../lib/workspace.mjs';

const raw = String.raw;

test('maps real WSL paths without hard-coding a user or distro', () => {
  assert.deepEqual(parseWslWorkspace(raw`\\wsl.localhost\Ubuntu-26.04\home\alina\项目 A`), {
    distro: 'Ubuntu-26.04', linuxPath: '/home/alina/项目 A',
  });
  assert.deepEqual(parseWslWorkspace(raw`\\WSL$\Debian\home\a` + '\\'), {
    distro: 'Debian', linuxPath: '/home/a',
  });
  assert.deepEqual(parseWslWorkspace(raw`\\?\UNC\wsl.localhost\Ubuntu\home\a`), {
    distro: 'Ubuntu', linuxPath: '/home/a',
  });
  assert.deepEqual(parseWslWorkspace('//wsl.localhost/Debian'), {
    distro: 'Debian', linuxPath: '/',
  });
});

test('does not treat Windows drives, other shares or ambiguous paths as WSL', () => {
  for (const path of [
    raw`C:\work`, raw`\\server\Ubuntu\home\a`, raw`wsl$\Ubuntu\home`,
    raw`\\wsl$\Ubuntu\home\..\etc`, raw`\\wsl$\Ubuntu\home\\a`,
    raw`\\wsl$\--help\home\a`, raw`\\wsl$\Ubuntu\home\a:stream`,
    '\\\\wsl$\\Ubuntu\\home\\a\n', null,
  ]) assert.equal(parseWslWorkspace(path), null, String(path));
});

test('comparison separates distros, path boundaries and Linux case', () => {
  const workspace = parseWslWorkspace(raw`\\wsl.localhost\Ubuntu\home\a\project`);
  assert.equal(isLexicallyWithin(workspace, parseWslWorkspace(raw`\\wsl$\ubuntu\home\a\project\src`)), true);
  assert.equal(isLexicallyWithin(workspace, parseWslWorkspace(raw`\\wsl$\Ubuntu\home\a\project2`)), false);
  assert.equal(isLexicallyWithin(workspace, parseWslWorkspace(raw`\\wsl$\Ubuntu\home\a\Project`)), false);
  assert.equal(isLexicallyWithin(workspace, parseWslWorkspace(raw`\\wsl$\Other\home\a\project`)), false);
});
