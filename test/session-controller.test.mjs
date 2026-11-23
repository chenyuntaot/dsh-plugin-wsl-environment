import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionEnvironmentController, foldStarted } from '../lib/session-controller.mjs';

const id = 'test-session';
const workspace = String.raw`\\wsl.localhost\Ubuntu\home\user\project`;
function fixture({ cwd = workspace, preflight = async () => ({ ok: true }), save } = {}) {
  const state = new Map();
  let started = false, busy = false;
  const session = { header: { cwd } };
  const agent = {
    id, session,
    runMaintenance(callback) {
      if (busy) throw new Error('busy');
      busy = true;
      return callback(new AbortController().signal).finally(() => { busy = false; });
    },
  };
  const controller = createSessionEnvironmentController({
    platform: 'win32', hasStarted: () => started,
    resolveAgent: async requested => requested === id ? agent : undefined, preflight,
    table: { get: requested => state.get(requested), put: async (id, value) => {
      await save?.(id, value);
      state.set(id, value);
    } },
  });
  return { controller, agent, state, start: () => { started = true; } };
}

test('durable first input remains locked after the queue is removed', () => {
  assert.equal(foldStarted(false, { type: 'agent/inbox/spliced', data: { inserted: [] } }), false);
  assert.equal(foldStarted(false, { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'system-prompt' } }] } }), false);
  const started = foldStarted(false, { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user' } }] } });
  assert.equal(started, true);
  assert.equal(foldStarted(started, { type: 'agent/inbox/spliced', data: { inserted: [] } }), true);
  assert.equal(foldStarted(false, { type: 'turn/start' }), true);
});

test('the default WSL stays selected across first input; a legacy session does not switch', async () => {
  const { controller, agent, start } = fixture();
  await controller.initialize(agent);
  assert.equal((await controller.status(id)).mode, 'wsl');
  start();
  assert.deepEqual(await controller.status(id), { applicable: true, mode: 'wsl', locked: true, wslReady: true, distro: 'Ubuntu' });
  await assert.rejects(controller.set(id, 'windows'), { code: 'session-started' });
  const legacy = fixture();
  legacy.start();
  await legacy.controller.initialize(legacy.agent);
  assert.equal((await legacy.controller.status(id)).mode, 'windows');
});

test('only an already-admitted change can finish when first input arrives', async () => {
  const pause = Promise.withResolvers(), pending = Promise.withResolvers();
  const { controller, state, start } = fixture({ save: async () => { pending.resolve(); await pause.promise; } });
  const change = controller.set(id, 'windows');
  await pending.promise;
  start();
  await assert.rejects(controller.set(id, 'wsl'), { code: 'session-started' });
  pause.resolve();
  assert.equal((await change).mode, 'windows');
  assert.deepEqual(state.get(id), { mode: 'windows' });
});

test('runner failure never falls back to Windows after WSL has been elected', async () => {
  const { controller, agent, start } = fixture({ preflight: async () => ({ ok: false, reason: 'no isolation' }) });
  await controller.initialize(agent);
  await assert.rejects(controller.set(id, 'wsl'), { code: 'runner-unavailable' });
  start();
  assert.deepEqual(await controller.status(id), { applicable: true, mode: 'wsl', locked: true, wslReady: false,
    distro: 'Ubuntu', reason: 'no isolation' });
  await assert.rejects(controller.status('other'), { code: 'session-not-found' });
});

test('a failed default save stays WSL-blocked rather than becoming an older Windows session', async () => {
  const { controller, agent, start } = fixture({ save: async () => { throw new Error('storage'); } });
  await assert.rejects(controller.initialize(agent), /storage/);
  start();
  const status = await controller.status(id);
  assert.equal(status.mode, 'wsl');
  assert.equal(status.wslReady, false);
  assert.equal(status.locked, true);
});
