import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CHANNEL, createHandler, registerTransport } from '../lib/remote-host.mjs';

const makePeer = () => ({ principal: { kind: 'owner' }, signal: new AbortController().signal });

test('only the authenticated browser peer reaches exact Session actions', async () => {
  const owner = makePeer(), other = makePeer();
  const fn = async id => ({ id });
  const rpc = createHandler({ status: fn, set: async (id, mode) => ({ id, mode }) }, owner, new AbortController().signal);
  const signal = new AbortController().signal;
  assert.deepEqual(await rpc('status', { args: { sessionId: 'session-123' } }, signal, owner), { ok: true, value: { id: 'session-123' } });
  assert.deepEqual(await rpc('set', { args: { sessionId: 'session-123', mode: 'wsl' } }, signal, owner), { ok: true, value: { id: 'session-123', mode: 'wsl' } });
  assert.equal((await rpc('status', { args: { sessionId: 'session-123' } }, signal, other)).error.code, 'dsh-wsl-env/forbidden');
  assert.equal((await rpc('unknown', {}, signal, owner)).error.code, 'dsh-wsl-env/not-found');
  for (const payload of [{}, { args: { sessionId: '../bad' } }, { args: { sessionId: 'x', extra: true } }]) {
    assert.equal((await rpc('status', payload, signal, owner)).error.code, 'dsh-wsl-env/bad-request');
  }
  assert.equal((await rpc('set', { args: { sessionId: 'x', mode: 'danger-full-access' } }, signal, owner)).error.code, 'dsh-wsl-env/bad-request');
});

test('exact RPC routes validate the envelope and stop after plugin disposal', async () => {
  const browserPeer = makePeer();
  const routes = new Map();
  const connection = { browserPeer, admit(request) {
    return request.headers.get('cookie') === 'test-browser' ? { peer: browserPeer } : { rejection: 401 };
  }, fetch: { register(route) {
    routes.set(route.path, route.fetch);
    return async () => { routes.delete(route.path); };
  } } };
  const dispose = registerTransport({ connection }, { status: async sessionId => ({ sessionId }) });
  assert.equal(routes.size, 2);
  const endpoint = `${CHANNEL}/dsh-wsl-env/status`;
  const dispatch = routes.get(endpoint);
  const payload = { type: 'client-request', rpcId: 'test-id', method: 'dsh-wsl-env/status', payload: { args: { sessionId: 'x' } } };
  const request = (body, cookie = 'test-browser') => new Request(`http://127.0.0.1${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  assert.deepEqual(await (await dispatch(request(payload))).json(), { type: 'server-response', rpcId: 'test-id', result: { ok: true, value: { sessionId: 'x' } } });
  assert.equal((await dispatch(request(payload, 'other'))).status, 403);
  assert.equal((await dispatch(request({ ...payload, method: 'dsh-wsl-env/set' }))).status, 400);
  await dispose();
  assert.equal(routes.size, 0);
  const response = await (await dispatch(request(payload))).json();
  assert.equal(response.result.error.code, 'dsh-wsl-env/cancelled');
});
