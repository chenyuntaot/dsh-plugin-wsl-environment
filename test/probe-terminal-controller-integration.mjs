// Exercise the actual patched DSH controller source with an isolated subprocess double.
// This checks launch orchestration, not Typert transport, app rendering or native PTY internals.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { wslUserTerminalProfile } from '../lib/user-terminal-profile.mjs';
import { parseWslWorkspace } from '../lib/workspace.mjs';

const [checkout, compiler] = process.argv.slice(2);
assert.ok(checkout && compiler, 'pass the patched DSH checkout and TypeScript compiler paths');
const ts = createRequire(import.meta.url)(resolve(compiler));
const dir = join(resolve(checkout), 'packages/api/terminal-controller/src');
const modules = new Map();
const chain = new Proxy(() => chain, { get: (_target, property) => property === '__esModule' ? false : chain });
class RemoteError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const stubs = new Map([
  ['node:crypto', { randomUUID }],
  ['@deepseek-ai/schemastery', chain],
  ['@deepseek-ai/dsh-typert-protocol', {
    Remote: (_target, context) => context === undefined ? () => undefined : undefined, RemoteError,
    TypertRemoteService: class { constructor(ctx) { this.ctx = ctx; } },
  }],
  ['./agent.ts', { AgentTerminalHandle: class { constructor(terminal) { this.info = terminal.info; } } }],
  ['./terminal.ts', { BrowserTerminal: class {
    constructor(handle, info) { this.handle = handle; this.info = info; }
    monitor() {} setStateListener() {} async close() { await this.handle.terminate(); }
  } }],
  ['./retention.ts', { TerminalRetention: class {} }],
]);
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const source = readFileSync(join(dir, file), 'utf8');
  const output = ts.transpileModule(source, {
    fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    reportDiagnostics: true,
  });
  assert.ok(!output.diagnostics?.some(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error));
  const module = { exports: {} };
  const dependencies = name => {
    if (stubs.has(name)) return stubs.get(name);
    if (name === './shells.ts' || name === './user-profiles.ts') return load(name.slice(2));
    throw new Error(`unexpected isolated dependency ${name}`);
  };
  new Function('require', 'module', 'exports', output.outputText)(dependencies, module, module.exports);
  modules.set(file, module.exports);
  return module.exports;
}

const { TerminalController } = load('index.ts');
const pointer = new AbortController().signal;
const sys32 = String.raw`C:\Windows\System32`;
const cmd = `${sys32}\\cmd.exe`;
const pwsh = `${sys32}\\powershell.exe`;
const wsl = `${sys32}\\wsl.exe`;
const windows = String.raw`C:\work\windows`;
const project = String.raw`\\wsl.localhost\Ubuntu-26.04\home\alina\project`;
const wslChoice = { mode: 'wsl', target: parseWslWorkspace(project) };
const launches = [], closed = [];
let scenario = 'available';
const subprocess = {
  terminalEnvironment: async () => ({ platform: 'windows', defaultShell: 'cmd.exe' }),
  async resolveExecutable(name) {
    if (name === 'cmd.exe' || name === cmd) return cmd;
    if (name === 'powershell' || name === pwsh) return pwsh;
    if (name === wsl && scenario !== 'unavailable') return wsl;
    const error = new Error('executable absent'); error.name = 'SubprocessExecutableNotFoundError'; throw error;
  },
  async spawnTerminal(spec) {
    launches.push(spec);
    return { terminate: async () => { closed.push(spec); } };
  },
};
function agent(id, cwd) {
  const providers = {
    subprocess, sandboxPolicy: {}, workingDirectory: { ensure: async () => cwd },
    sandbox: { confine: async argv => ({ argv: ['sandbox.exe', ...argv] }) },
  };
  return { id, session: { cwd }, ctx: { effect: () => {}, get: name => providers[name] } };
}
const ubuntu = agent('ubuntu-session', project);
const native = agent('windows-session', windows);
const controller = new TerminalController({ effect: () => {} }, {
  shellCandidates: ['powershell'], maxTerminals: 8, maxAgentTerminals: 4, maxCols: 100, maxRows: 50,
  scrollback: 1000, maxBufferedBytes: 65536, disposeGraceMs: 1000,
});
const drop = controller.registerUserShellProfiles('dsh-wsl-env', selected => {
  const value = wslUserTerminalProfile({ platform: 'win32', choice: selected === ubuntu ? wslChoice : { mode: 'windows' },
    workingDirectory: selected.session.cwd, windowsRoot: String.raw`C:\Windows` });
  return value ? [value] : [];
});
const request = id => ({ id, cols: 80, rows: 24 });
assert.deepEqual((await controller.shells(ubuntu, pointer)).map(shell => shell.profileId ?? shell.path), ['dsh-wsl-env.wsl', cmd, pwsh]);
assert.deepEqual((await controller.shells(native, pointer)).map(shell => shell.path), [cmd, pwsh]);

const selected = await controller.create(ubuntu, { ...request('user-1'), preferredShellPath: pwsh }, pointer);
assert.equal(selected.origin, 'user');
assert.equal(selected.control, 'user');
assert.equal(selected.sandboxMode, undefined);
assert.equal(selected.cwd, '/home/alina/project');
assert.equal(launches.at(-1).cwd, sys32);
assert.deepEqual(launches.at(-1).argv, [wsl, '--distribution', 'Ubuntu-26.04', '--cd', selected.cwd]);
const explicitWindows = await controller.create(ubuntu, { ...request('user-2'), shellPath: pwsh }, pointer);
assert.equal(explicitWindows.shell.path, pwsh);
assert.equal(explicitWindows.rememberShellPath, undefined);
assert.equal((await controller.create(native, { ...request('user-3'), shellPath: pwsh }, pointer)).rememberShellPath, pwsh);
await assert.rejects(controller.create(native, { ...request('user-4'), profileId: 'dsh-wsl-env.wsl' }, pointer), { code: 'terminal/profile-unavailable' });

scenario = 'unavailable';
assert.ok((await controller.shells(ubuntu, pointer))[0].unavailableReason);
const before = launches.length;
await assert.rejects(controller.create(ubuntu, { ...request('missing'), preferredShellPath: pwsh }, pointer), { code: 'terminal/profile-unavailable' });
assert.equal(launches.length, before, 'an unavailable WSL default must not create any native process');
const automated = await controller.openForAgent(ubuntu, {
  title: 'Agent unchanged', cols: 80, rows: 24, preferredShells: ['wsl.exe'], policy: { mode: 'workspace-write', workspaceRoot: project },
}, pointer);
assert.equal(automated.info.origin, 'agent');
assert.equal(automated.info.sandboxMode, 'workspace-write');
assert.deepEqual(launches.at(-1).argv, ['sandbox.exe', cmd]);

await controller.close(ubuntu, 'user-1');
assert.equal(closed.length, 1);
drop();
assert.equal((await controller.create(ubuntu, { ...request('user-after-remove'), preferredShellPath: pwsh }, pointer)).shell.path, pwsh);
console.log('PASS: the patched controller keeps the native menu, launch, directory, policy and session boundaries');
