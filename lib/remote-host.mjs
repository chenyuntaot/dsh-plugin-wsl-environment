import { EnvironmentError } from './session-controller.mjs';

export const CHANNEL = '/api';
const METHODS = ['status', 'set'];
const PREFIX = 'dsh-wsl-env';
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const reject = (code, message) => ({ ok: false, error: { code, message, details: {} } });

/** The standard carrier authenticates the browser before this owner-only dispatcher. */
export function createHandler(handlers, browserPeer, lifetime) {
  return async (endpoint, payload, signal, peer) => {
    if (peer !== browserPeer || peer?.principal?.kind !== 'owner' || peer.signal.aborted) {
      return reject('dsh-wsl-env/forbidden', 'This action is only available to the signed-in DSH browser owner.');
    }
    if (endpoint !== 'status' && endpoint !== 'set') {
      return reject('dsh-wsl-env/not-found', 'Unknown session environment action.');
    }
    const args = payload?.args;
    if (!payload || Object.keys(payload).length !== 1 || !args || Array.isArray(args)
        || typeof args !== 'object' || Object.keys(args).length !== (endpoint === 'status' ? 1 : 2)
        || typeof args.sessionId !== 'string' || !SESSION_ID.test(args.sessionId)
        || (endpoint === 'set' && !['wsl', 'windows'].includes(args.mode))) {
      return reject('dsh-wsl-env/bad-request', 'Invalid session environment request.');
    }
    const operation = AbortSignal.any([signal, peer.signal, lifetime]);
    try {
      operation.throwIfAborted();
      const value = await (endpoint === 'status'
        ? handlers.status(args.sessionId, operation)
        : handlers.set(args.sessionId, args.mode, operation));
      operation.throwIfAborted();
      return { ok: true, value };
    } catch (error) {
      if (operation.aborted) return reject('dsh-wsl-env/cancelled', 'Session environment request cancelled.');
      if (error instanceof EnvironmentError) return reject(`dsh-wsl-env/${error.code}`, error.message);
      return reject('dsh-wsl-env/internal', 'The Host could not complete the request. Reopen the session and try again.');
    }
  };
}

export function registerTransport(ctx, handlers) {
  const lifetime = new AbortController();
  const connection = ctx.connection;
  const dispatch = createHandler(handlers, connection.browserPeer, lifetime.signal);
  const routes = [];
  const dispose = async () => {
    lifetime.abort();
    await Promise.all(routes.map(unregister => unregister()));
  };
  try {
    for (const endpoint of METHODS) {
      const method = `${PREFIX}/${endpoint}`;
      routes.push(connection.fetch.register({
        path: `${CHANNEL}/${method}`, methods: ['POST'], requestBody: 'buffered',
        async fetch(request) {
          const admission = connection.admit(request);
          if (admission.peer !== connection.browserPeer) return new Response('forbidden', { status: 403 });
          if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
            return new Response('expected application/json', { status: 415 });
          }
          let message;
          try {
            const text = await request.text();
            if (text.length > 8192) return new Response('request too large', { status: 413 });
            message = JSON.parse(text);
          } catch {
            return new Response('invalid request JSON', { status: 400 });
          }
          if (!message || Object.keys(message).length !== 4 || message.type !== 'client-request'
              || typeof message.rpcId !== 'string' || message.rpcId.length > 128 || message.method !== method) {
            return new Response('invalid request envelope', { status: 400 });
          }
          const result = await dispatch(endpoint, message.payload, request.signal, admission.peer);
          return Response.json({ type: 'server-response', rpcId: message.rpcId, result },
            { headers: { 'cache-control': 'no-store' } });
        },
      }));
    }
  } catch (error) {
    void dispose();
    throw error;
  }
  return dispose;
}
