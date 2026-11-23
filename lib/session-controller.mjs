import { chooseEnvironment, initialEnvironment, WINDOWS, WSL } from './session-environment.mjs';
import { parseWslWorkspace } from './workspace.mjs';

/** An admission latch, not a UI blank/running flag; removal never unlocks history. */
export function foldStarted(started, event) {
  if (started || event.type === 'turn/start') return true;
  const messages = event.type === 'agent/inbox/spliced' ? event.data.inserted
    : event.type === 'user/message' ? [event.data] : [];
  return messages.some(message => ['user', 'retry'].includes(message.source.kind));
}

export class EnvironmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EnvironmentError';
    this.code = code;
  }
}

function sameTarget(a, b) {
  return !!a && !!b && a.linuxPath === b.linuxPath && a.distro.toLowerCase() === b.distro.toLowerCase();
}

export function createSessionEnvironmentController({ platform, table, hasStarted, resolveAgent, preflight }) {
  const initialWrites = new Map();
  const initializationFailed = new WeakSet();
  const initializing = new WeakSet();

  function inspect(agent) {
    const header = agent.session.header;
    const applicable = platform === 'win32' && header.origin !== 'subagent' && !!parseWslWorkspace(header.cwd);
    const started = hasStarted(agent.session);
    const record = table.get(agent.id);
    if (record !== undefined) return { choice: record, applicable, started };
    // For delegated/forked sessions retain a recorded WSL parent's policy. A failed
    // directory mapping is blocked later; it must not become native Windows.
    const parent = header.parentSession ? table.get(header.parentSession) : undefined;
    if (parent?.mode === WSL) return { choice: parent, applicable, started };
    const choice = initialEnvironment({ hostPlatform: platform, workspacePath: header.cwd,
      started: (started && !initializationFailed.has(agent) && !initializing.has(agent)) || !applicable });
    return { choice, applicable, started };
  }

  async function initialize(agent) {
    const known = initialWrites.get(agent.id);
    if (known) return known;
    if (table.get(agent.id) !== undefined) return;
    const { choice } = inspect(agent);
    if (choice.mode !== WSL) return;
    initializing.add(agent);
    const task = Promise.resolve().then(() => table.put(agent.id, choice)).then(() => {
      initializationFailed.delete(agent);
    }, error => {
      initializationFailed.add(agent);
      throw error;
    }).finally(() => {
      initializing.delete(agent);
      if (initialWrites.get(agent.id) === task) initialWrites.delete(agent.id);
    });
    initialWrites.set(agent.id, task);
    return task;
  }

  async function stateFor(agent, signal, probe = true) {
    const { choice, applicable, started } = inspect(agent);
    const path = agent.session.header.cwd;
    const target = parseWslWorkspace(path);
    let availability = { ok: false, reason: 'This session does not have an eligible WSL workspace.' };
    if (applicable && (choice.mode === WINDOWS || sameTarget(target, choice.target))) {
      if (initializationFailed.has(agent)) {
        availability.reason = 'The WSL session environment could not be saved.';
      } else if (probe) {
        availability = await preflight(agent, target, signal);
      }
    } else if (choice.mode === WSL) {
      availability.reason = 'The session directory no longer matches the recorded WSL workspace.';
    }
    return {
      applicable, mode: choice.mode, locked: started, wslReady: availability.ok === true,
      ...(target ? { distro: target.distro } : {}),
      ...(!availability.ok && availability.reason ? { reason: availability.reason } : {}),
    };
  }

  return {
    initialize,
    inspect,
    async status(sessionId, signal) {
      const agent = await resolveAgent(sessionId, signal);
      signal?.throwIfAborted();
      if (!agent || agent.id !== sessionId) throw new EnvironmentError('session-not-found', 'Session not found.');
      return stateFor(agent, signal);
    },
    async set(sessionId, mode, signal) {
      if (mode !== WSL && mode !== WINDOWS) throw new EnvironmentError('invalid-environment', 'Invalid execution environment.');
      const agent = await resolveAgent(sessionId, signal);
      signal?.throwIfAborted();
      if (!agent || agent.id !== sessionId) throw new EnvironmentError('session-not-found', 'Session not found.');
      if (hasStarted(agent.session)) throw new EnvironmentError('session-started', 'This session has already accepted its first message.');
      await agent.runMaintenance(async maintenance => {
        const current = inspect(agent);
        const joined = signal ? AbortSignal.any([signal, maintenance]) : maintenance;
        joined.throwIfAborted();
        if (!current.applicable) throw new EnvironmentError('not-eligible', 'This session has no eligible WSL workspace.');
        const result = chooseEnvironment({ mode, hostPlatform: platform, workspacePath: agent.session.header.cwd, started: current.started });
        if (!result.ok) throw new EnvironmentError(result.reason, 'This session environment cannot be changed.');
        if (mode === WSL) {
          const available = await preflight(agent, result.choice.target, joined);
          if (!available.ok) throw new EnvironmentError('runner-unavailable', available.reason);
        }
        // A pending initial default cannot overwrite a confirmed user selection.
        await initialWrites.get(agent.id)?.catch(() => {});
        joined.throwIfAborted();
        await table.put(agent.id, result.choice);
        initializationFailed.delete(agent);
      });
      return stateFor(agent, signal);
    },
  };
}
