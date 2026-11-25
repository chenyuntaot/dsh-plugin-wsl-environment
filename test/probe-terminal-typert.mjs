// Inspect the real Typert output from the patched terminal package, not an example schema.
// Usage: node test/probe-terminal-typert.mjs /path/to/typert.remote-client.js
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const artifact = process.argv[2];
assert.ok(artifact, 'pass the generated terminal Typert Remote Client artifact');
const { TYPERT_REMOTE } = await import(pathToFileURL(resolve(artifact)).href);
assert.equal(TYPERT_REMOTE.package, '@deepseek-ai/dsh-api-terminal-controller');
const { methods } = TYPERT_REMOTE;
assert.deepEqual(Object.keys(methods).sort(), [
  'attach', 'close', 'create', 'environment', 'list', 'rename', 'retain', 'shells', 'watch',
].map(method => `terminal/${method}`));
const create = methods['terminal/create'];
assert.deepEqual(create.scope, { context: 'agent', wire: 'agentId' });
assert.equal(create.parameters[0].lookup, 'agent');
assert.equal(create.cancellation.parameter, 'signal');
const request = create.parameters.find(parameter => parameter.name === 'request');
assert.ok(request?.strictCodec);
const schema = request.strictCodec.create();
const legacy = { id: 'web-terminal-1', cols: 80, rows: 24 };
assert.deepEqual(schema.parse(legacy), legacy);
assert.equal(schema.parse({ ...legacy, shellPath: 'cmd.exe' }).shellPath, 'cmd.exe');
assert.equal(schema.parse({ ...legacy, preferredShellPath: 'cmd.exe' }).preferredShellPath, 'cmd.exe');
assert.equal(schema.parse({ ...legacy, profileId: 'dsh-wsl-env.wsl' }).profileId, 'dsh-wsl-env.wsl');
for (const forbidden of ['path', 'args', 'argv', 'hostCwd', 'displayCwd', 'cwd', 'env']) {
  assert.equal(schema.safeParse({ ...legacy, profileId: 'dsh-wsl-env.wsl', [forbidden]: 'forbidden' }).success, false, forbidden);
}

const wsl = { name: 'WSL · Ubuntu', path: 'wsl.exe', args: ['--distribution', 'Ubuntu'], profileId: 'dsh-wsl-env.wsl', sessionDefault: true };
const windows = { name: 'cmd.exe', path: 'cmd.exe', args: [] };
const shells = methods['terminal/shells'].result.create();
assert.deepEqual(shells.parse([wsl, windows]), [wsl, windows]);
assert.equal(shells.parse([{ ...wsl, path: '', args: [], unavailableReason: 'Distribution missing' }, windows])[0].unavailableReason,
  'Distribution missing');
const record = { id: legacy.id, title: 'WSL', shell: wsl, cwd: '/home/user/project', cols: 80, rows: 24,
  state: 'running', exitCode: null, origin: 'user', control: 'user' };
assert.equal(create.result.create().parse(record).shell.profileId, wsl.profileId);
assert.equal(create.result.create().parse({ ...record, shell: windows, rememberShellPath: 'cmd.exe' }).rememberShellPath, 'cmd.exe');
const frame = { type: 'snapshot', sequence: 0, screen: '', writable: true, info: record };
assert.equal(methods['terminal/attach'].result.create().parse(frame).info.shell.sessionDefault, true);
console.log('PASS: generated Typert schemas keep session lookup, profile selection, legacy payloads and strict launch input boundaries');
