// Optional: run with a Windows Node runtime compatible with an installed node-pty.
// Pass the absolute node-pty package path, e.g. from the installed DSH runtime.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { wslUserTerminalProfile } from '../lib/user-terminal-profile.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const modulePath = process.argv[2];
assert.ok(modulePath && isAbsolute(modulePath), 'pass an absolute node-pty package path');
const { spawn } = createRequire(import.meta.url)(modulePath);
const cwd = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '');
const workspace = parseWslWorkspace(cwd);
assert.ok(process.platform === 'win32' && workspace, 'run with Windows Node from a native WSL UNC workspace');
const { launch } = wslUserTerminalProfile({
  platform: process.platform, choice: { mode: 'wsl', target: workspace },
  workingDirectory: cwd, windowsRoot: process.env.SystemRoot,
});
assert.ok(launch);

// Use a deterministic WSL PTY fixture rather than depending on login profiles.
const prompt = 'DSH_WSL_PTY_READY';
const input = 'DSH_WSL_PTY_INPUT';
const guest = `test -t 0 && test -t 1 || exit 2; printf '${prompt}\\n'; IFS= read -r line; test "$line" = ${input} || exit 3; uname -s; pwd -P`;
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|windir|SystemDrive|PATH|USERPROFILE|TEMP|TMP|LOCALAPPDATA)$/iu.test(key)));
const terminal = spawn(launch.path, [...launch.args, '--exec', '/bin/sh', '-c', guest], {
  cwd: launch.hostCwd, cols: 110, rows: 24, name: 'xterm-256color', env: { ...env, TERM: 'xterm-256color' },
});
let buffer = '', written = false, exited = false;
const data = terminal.onData(chunk => {
  buffer = (buffer + chunk).slice(-65536);
  if (!written && stripVTControlCharacters(buffer).includes(prompt)) {
    written = true;
    terminal.write(input + '\r');
  }
});
let timer, exit;
try {
  const result = await new Promise((resolve, reject) => {
    exit = terminal.onExit(event => { exited = true; resolve(event); });
    timer = setTimeout(() => reject(new Error(`WSL PTY smoke test timed out (prompt seen: ${written}): ${stripVTControlCharacters(buffer).slice(-800)}`)), 18000);
  });
  assert.equal(result.exitCode, 0, stripVTControlCharacters(buffer));
  assert.ok(written, 'the native PTY did not open the WSL prompt');
  const output = stripVTControlCharacters(buffer).replace(/\r\n/gu, '\n').split('\n');
  assert.ok(output.includes('Linux') && output.includes(workspace.linuxPath), output.join('\n'));
  console.log('PASS: native Windows PTY opened WSL, accepted input, reported the selected project and exited');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  data.dispose();
  exit?.dispose();
  if (!exited) terminal.kill();
}

// Electron's standalone test wrapper may otherwise retain a ConPTY transport handle.
process.exit(process.exitCode ?? 0);
