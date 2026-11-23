import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { isLexicallyWithin, parseWslWorkspace } from './workspace.mjs';

const guest = readFileSync(new URL('./wsl-guest.py', import.meta.url)).toString('base64');
// Static argv; neither the model's command nor Linux directories are shell-quoted on Windows.
const bootstrap = "import base64,sys;exec(compile(base64.b64decode(sys.stdin.buffer.readline(32768).rstrip(b'\\n'),validate=True),'<dsh-wsl-guest>','exec'))";

function prepare({ policy, workspace, workingDirectory, windowsRoot, command, seconds = 30 }, control) {
  if (!['read-only', 'workspace-write'].includes(policy?.mode)) {
    throw new Error('This WSL prototype requires a supported restricted DSH permission mode.');
  }
  const root = parseWslWorkspace(policy.workspaceRoot);
  const cwd = parseWslWorkspace(workingDirectory);
  if (root === null || !workspace || root.distro.toLowerCase() !== workspace.distro.toLowerCase()
      || root.linuxPath !== workspace.linuxPath || !isLexicallyWithin(root, cwd)) {
    throw new Error('The session directory no longer belongs to the selected WSL workspace.');
  }
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 120
      || typeof command !== 'string' || command.length === 0 || command.includes('\0') || Buffer.byteLength(command) > 24576) {
    throw new Error('Unsupported WSL command or deadline.');
  }
  if (typeof windowsRoot !== 'string' || !/^[A-Za-z]:\\[^\u0000-\u001f]+$/u.test(windowsRoot)) {
    throw new Error('A native Windows system directory is required.');
  }
  const system = win32.join(windowsRoot, 'System32');
  const request = { mode: policy.mode, root: root.linuxPath, cwd: cwd.linuxPath, seconds, command, ...(control ? { control } : {}) };
  const data = `${guest}\n${JSON.stringify(request)}\n`;
  if (guest.length >= 32766 || Buffer.byteLength(data) - guest.length > 65536) throw new Error('WSL launch payload too large.');
  const spec = {
    argv: [win32.join(system, 'wsl.exe'), '--distribution', root.distro, '--cd', '/', '--exec', '/usr/bin/python3', '-I', '-c', bootstrap],
    cwd: system,
    stdio: {
      stdin: control ? 'pipe' : { data },
      stdout: { maxBytes: 32768 },
      stderr: { maxBytes: 32768 },
    },
    graceMs: 2500,
    env: { WSLENV: undefined, WSL_INTEROP: undefined },
  };
  return { spec, data };
}

export function prepareGuestLaunch(options) {
  return prepare(options).spec;
}

export function prepareControlledGuestLaunch(options) {
  const nonce = randomBytes(24).toString('hex');
  const { spec, data } = prepare(options, nonce);
  const trailer = new RegExp(`\\r?\\nDSH-WSL-CONTROL ${nonce} (completed|timeout|cancelled|rejected)\\r?\\n?$`, 'u');
  return {
    spec,
    input: data,
    inspectExit(stderr) {
      const match = trailer.exec(stderr);
      return match ? { state: match[1], stderr: stderr.slice(0, match.index) } : { state: null, stderr };
    },
  };
}
