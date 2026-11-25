// Test the built compatibility package against the published rc.5 terminal codecs.
// Pass the built bundle directory and a fixture resources/ mirroring Desktop module resolution.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { decodeMenuShell, encodeSelection } from '../scripts/terminal-wire.mjs';
import { wslUserTerminalProfile } from '../lib/user-terminal-profile.mjs';

const [bundle, resources] = process.argv.slice(2);
assert.ok(bundle && resources, 'pass the built bundle directory and fixture resources/ path');
Object.defineProperty(process, 'resourcesPath', { value: resolve(resources) });
const load = name => import(pathToFileURL(resolve(bundle, name)).href);
const { desktopModule } = await load('desktop-modules.mjs');
const { Context } = await desktopModule('@deepseek-ai/cordis');
const { TYPERT_REMOTE } = await desktopModule('@deepseek-ai/dsh-api-terminal-controller/remote');
const { TerminalController } = await load('native-terminal.mjs');
const { TYPERT } = await load('native-terminal.typert.mjs');
const { TYPERT: originalDefinitions } = await desktopModule('@deepseek-ai/dsh-api-terminal-controller/typert');
const { TypertRegistry } = await desktopModule('@deepseek-ai/dsh-typert-registry');
const { TypertGatewayService } = await desktopModule('@deepseek-ai/dsh-api-gateway');
const { registerTerminalDefinitions } = await load('terminal-definitions.mjs');
assert.equal(TYPERT.package, 'dsh-wsl-env');
assert.ok(TYPERT.model.services.some(service => service.key === 'terminalController'));
const shellsCodec = TYPERT_REMOTE.methods['terminal/shells'].result.create();
const create = TYPERT_REMOTE.methods['terminal/create'];
const launchCodec = create.parameters.find(parameter => parameter.name === 'request').strictCodec.create();
const infoCodec = create.result.create();

const windowsRoot = String.raw`C:\Windows`;
const hostCwd = String.raw`C:\Windows\System32`;
const windowsProject = String.raw`C:\work`;
const ubuntuProject = String.raw`\\wsl.localhost\Ubuntu-26.04\home\user\project`;
const linuxProject = '/home/user/project';
const cmd = `${hostCwd}\\cmd.exe`;
const pwsh = `${hostCwd}\\powershell.exe`;
const wsl = `${hostCwd}\\wsl.exe`;
let distroPresent = true;
const launched = [], terminated = [];
const runtime = {
  async terminalEnvironment() { return { platform: 'windows', defaultShell: 'cmd.exe' }; },
  async resolveExecutable(name) {
    if (name === 'cmd.exe' || name === cmd) return cmd;
    if (name === 'powershell' || name === pwsh) return pwsh;
    if (name === wsl && distroPresent) return wsl;
    const error = new Error('Executable unavailable');
    error.name = 'SubprocessExecutableNotFoundError';
    throw error;
  },
  async spawnTerminal(specification) {
    launched.push(specification);
    const { promise, resolve } = Promise.withResolvers();
    return {
      done: promise, output: Readable.from([]),
      async inspectActivity() { return 'unknown'; },
      async terminate() { terminated.push(specification); resolve({ exitCode: 0 }); },
    };
  },
};
const providers = new Map([
  ['subprocess', runtime], ['sandboxPolicy', {}], ['remoteAccess', {}],
  ['workingDirectory', { async ensure(agent) { return agent.session.cwd; } }],
]);
const ctx = new Context();
for (const [name, service] of providers) ctx.provide(name, service);
function ready(promise, description) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Cordis did not activate ${description}`)), 2500);
  })]).finally(() => clearTimeout(timer));
}
function serviceReady(name) {
  const { promise, resolve } = Promise.withResolvers();
  ctx.inject([name], owner => { resolve(owner.get(name)); });
  return ready(promise, name);
}
ctx.plugin(TypertRegistry, {});
await serviceReady('typert');
const registry = ctx.typert;
ctx.plugin(TypertGatewayService, {});
const gateway = await serviceReady('typertGateway');
const signal = new AbortController().signal;
const peer = { principal: { kind: 'owner' }, signal };
const invoke = (method, args) => gateway.invoke({ namespace: 'terminal', method, args, peer });
const initialDefinitions = registry.register(originalDefinitions);
await initialDefinitions();
await assert.rejects(invoke('shells', { agentId: 'ubuntu-session' }), { code: 'gateway/definition-unavailable' });
const previous = registry.register(originalDefinitions);
const { promise: bound, resolve: readyBinding } = Promise.withResolvers();
const bindingFiber = ctx.plugin({
  inject: ['typert'],
  apply(scope) {
    registerTerminalDefinitions(scope.typert, TYPERT);
    readyBinding();
  },
});
await ready(bound, 'the compatibility plugin');
assert.equal(registry.getPackage('dsh-wsl-env'), undefined);
await previous();
for (const { namespace, method } of TYPERT.invocations) {
  const endpoint = `${namespace}/${method}`;
  assert.ok(registry.local.hasSeen(endpoint), endpoint);
  assert.ok(registry.local.get(endpoint), endpoint);
}
assert.ok(registry.getPackage('dsh-wsl-env'));
ctx.plugin(TerminalController, { shellCandidates: ['powershell'], unattendedTimeoutMs: 0 });
const controller = await serviceReady('terminalController');
assert.equal(typeof controller.registerUserShellProfiles, 'function');

function agent(id, cwd) {
  return { id, session: { cwd }, ctx: { effect: () => {}, get: name => providers.get(name) } };
}
const ubuntu = agent('ubuntu-session', ubuntuProject);
const native = agent('windows-session', windowsProject);
const wslChoice = { mode: 'wsl', target: { distro: 'Ubuntu-26.04', linuxPath: linuxProject } };
const unregister = controller.registerUserShellProfiles('dsh-wsl-env', owner => {
  const profile = wslUserTerminalProfile({ platform: 'win32', choice: owner === ubuntu ? wslChoice : { mode: 'windows' },
    workingDirectory: owner.session.cwd, windowsRoot });
  return profile === undefined ? [] : [profile];
});
const [lookup] = registry.local.get('terminal/shells').parameters;
registry.lookups.register('agent', { parameter: lookup.name, wire: lookup.wire, wireTypeSymbol: lookup.codec.typeSymbol,
  hostTypeSymbol: '@deepseek-ai/dsh-agent#Agent', resolve: id => [ubuntu, native].find(session => session.id === id) });
let identity = 0;
const open = async (owner, selection = {}) => {
  const request = launchCodec.parse({ id: `terminal-${++identity}`, cols: 80, rows: 24, ...encodeSelection(selection) });
  return infoCodec.parse(await invoke('create', { agentId: owner.id, request }));
};
try {
  const shells = shellsCodec.parse(await invoke('shells', { agentId: ubuntu.id })).map(decodeMenuShell);
  const [first] = shells;
  assert.equal(first.name, 'WSL · Ubuntu-26.04');
  assert.equal(first.sessionDefault, true);
  assert.deepEqual(shells.slice(1).map(shell => shell.path), [cmd, pwsh]);
  assert.deepEqual(shellsCodec.parse(await invoke('shells', { agentId: native.id })).map(shell => shell.path), [cmd, pwsh]);
  const terminal = await open(ubuntu, { preferredShellPath: pwsh });
  assert.equal(terminal.cwd, linuxProject);
  assert.equal(terminal.shell.path, wsl);
  assert.equal(launched.at(-1).cwd, hostCwd);
  assert.deepEqual(launched.at(-1).argv, [wsl, '--distribution', 'Ubuntu-26.04', '--cd', linuxProject]);
  assert.equal((await open(ubuntu, { profileId: first.profileId })).shell.path, wsl);
  assert.equal((await open(ubuntu, { shellPath: cmd })).shell.path, cmd);
  assert.equal((await open(ubuntu)).shell.path, wsl);
  assert.equal((await open(native, { preferredShellPath: pwsh })).shell.path, pwsh);
  await assert.rejects(open(native, { profileId: first.profileId }), { code: 'terminal/profile-unavailable' });
  assert.equal(launchCodec.safeParse({ id: 'unsafe', cols: 80, rows: 24, argv: ['ignored'] }).success, false);
  await assert.rejects(open(ubuntu, { shellPath: String.raw`C:\somewhere\not-a-configured-shell.exe` }), /not available/u);

  distroPresent = false;
  assert.ok(decodeMenuShell(shellsCodec.parse(await invoke('shells', { agentId: ubuntu.id }))[0]).unavailableReason);
  const launches = launched.length;
  await assert.rejects(open(ubuntu, { preferredShellPath: pwsh }), { code: 'terminal/profile-unavailable' });
  assert.equal(launched.length, launches);
} finally {
  for (const session of [ubuntu, native]) {
    for (const { id } of controller.list(session.id)) await controller.close(session, id);
  }
  unregister();
  await bindingFiber.dispose();
}
assert.equal(terminated.length, launched.length);
assert.equal(registry.local.get('terminal/shells'), undefined);
assert.equal(registry.local.hasSeen('terminal/shells'), true);
console.log('PASS: stock Gateway reproduces the withdrawn-definition error, then dispatches shells and create after the fix.');
