import { z } from 'zod';
import { createSessionEnvironmentController, foldStarted } from './lib/session-controller.mjs';
import { prepareControlledGuestLaunch } from './lib/wsl-carrier.mjs';
import { createWslRunner, windowsCommandGuard, wslTool } from './lib/wsl-tool.mjs';
import { registerTransport } from './lib/remote-host.mjs';
import { resolveWslUserTerminalProfiles } from './lib/user-terminal-profile.mjs';

export const inject = [
  'agents', 'agentPresets', 'connection', 'sandboxPolicy', 'sessionController',
  'sessionProjections', 'storageDomain', 'subprocess', 'systemPrompt', 'tools',
  'workingDirectory',
];

const sessionChoice = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('windows') }),
  z.strictObject({ mode: z.literal('wsl'), target: z.strictObject({
    distro: z.string().min(1).max(128), linuxPath: z.string().startsWith('/').max(4096),
  }) }),
]);

export async function apply(ctx) {
  if (process.platform !== 'win32') return;
  const log = ctx.logger('dsh-wsl-env');
  const lifetime = new AbortController();
  const work = new Set();
  const join = signal => signal ? AbortSignal.any([lifetime.signal, signal]) : lifetime.signal;
  const track = operation => {
    const task = Promise.resolve().then(operation);
    work.add(task);
    // Both handlers return normally so this observation never adds a rejected promise.
    void task.then(() => work.delete(task), () => work.delete(task));
    return task;
  };
  const store = await ctx.storageDomain.open({
    name: 'dsh_wsl_env', version: 1, layout: 'per-record',
    tables: { sessions: { valueSchema: sessionChoice } },
  });
  ctx.effect(() => async () => {
    lifetime.abort();
    await Promise.allSettled([...work]);
    await store.close();
  });
  const started = await ctx.sessionProjections.register({
    key: 'dsh_wsl_env_started', stateVersion: 1, stateSchema: z.boolean(),
    init: header => header.isSeeded === true, apply: foldStarted,
  });
  const runner = createWslRunner({
    getPolicy: agent => ctx.sandboxPolicy.resolve({ session: agent.session }),
    getCwd: agent => ctx.workingDirectory.get(agent.session),
    getPreset: agent => ctx.agentPresets.composedPreset(agent.ctx) ?? ctx.agentPresets.presetForSession(agent.session),
    subprocess: ctx.subprocess, prepare: prepareControlledGuestLaunch, windowsRoot: process.env.SystemRoot,
  });
  const records = store.table('sessions');
  const recordKey = id => Buffer.from(id, 'utf8').toString('base64url');
  const table = { get: id => records.get(recordKey(id)), put: (id, choice) => records.put(recordKey(id), choice) };
  const controller = createSessionEnvironmentController({
    platform: process.platform, table,
    hasStarted: session => started.stateOf(session),
    preflight: (agent, target, signal) => track(() => runner.preflight(agent, target, join(signal))),
    async resolveAgent(id, signal) {
      signal?.throwIfAborted();
      const live = ctx.agents.get(id);
      if (live) return live;
      const value = await ctx.sessionController.resolveAgent(id);
      signal?.throwIfAborted();
      return value.agent;
    },
  });
  ctx.on('agent/created', async ({ agent, signal }) => {
    join(signal).throwIfAborted();
    await track(() => controller.initialize(agent));
  });
  ctx.inject(['terminalController'], terminalScope => {
    const native = terminalScope.terminalController;
    // Stock Desktop versions without the native extension retain their old terminal UI.
    if (typeof native.registerUserShellProfiles !== 'function') return;
    terminalScope.effect(() => native.registerUserShellProfiles('dsh-wsl-env', (agent, signal) => track(() =>
      resolveWslUserTerminalProfiles({
        platform: process.platform, agent, getChoice: () => controller.inspect(agent).choice, windowsRoot: process.env.SystemRoot,
      }, join(signal)))));
  });
  ctx.tools.guard(call => windowsCommandGuard(controller, call));
  const tool = wslTool(controller, runner);
  const execute = tool.execute;
  tool.execute = (args, call) => track(() => execute(args, { ...call, signal: join(call.signal) }));
  ctx.tools.register(tool, { when: ({ agent }) => controller.inspect(agent).choice.mode === 'wsl' });
  ctx.systemPrompt.context({
    name: 'dsh-wsl-env:execution', order: ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') + 1,
    text({ agent }) {
      if (!agent || controller.inspect(agent).choice.mode !== 'wsl') return '';
      return 'This Session uses WSL for Agent commands. Use wsl_bash for shell commands; do not try another host execution tool if WSL is unavailable. File tools use the existing DSH workspace paths and permissions.';
    },
  });
  await Promise.all(ctx.agents.list().map(agent => track(() => controller.initialize(agent)).catch(error => {
    log.warn('Could not initialize WSL for session %s: %s', agent.id, error.message);
  })));
  ctx.effect(() => registerTransport(ctx, {
    status: (id, signal) => track(() => controller.status(id, join(signal))),
    set: (id, mode, signal) => track(() => controller.set(id, mode, join(signal))),
  }));
}
