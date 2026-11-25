import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { createWslRunner, superviseGuest, windowsCommandGuard, wslTool } from '../lib/wsl-tool.mjs';

const target = { distro: 'Ubuntu', linuxPath: '/home/test/project' };
const agent = { id: 'session-1' };

function stopped(state) {
  return () => ({ state, stderr: '' });
}

function simulator({ state = 'completed' } = {}) {
  const completed = Promise.withResolvers();
  let content = '', spawns = 0;
  const stdin = new PassThrough();
  stdin.on('data', chunk => { content += chunk.toString(); });
  const proc = { stdin, done: completed.promise, waitForExit: async () => true,
    terminate() { completed.resolve({ exitCode: 130 }); },
    collected: { stdout: { readFrom: () => ({ text: 'dsh-wsl-ready', lossy: false }) } },
  };
  return { subprocess: { spawn(spec) { assert.equal(spec.signal, undefined); spawns++; return proc; } }, stdin,
    finish: (exitCode = 0) => completed.resolve({ exitCode }), content: () => content, spawns: () => spawns,
    prepared: { spec: {}, input: 'frame\n', inspectExit: stopped(state) },
  };
}

test('Windows execution tools are guarded only in a WSL session; file tools stay untouched', () => {
  const wsl = { inspect: () => ({ choice: { mode: 'wsl', target } }) };
  const windows = { inspect: () => ({ choice: { mode: 'windows' } }) };
  for (const name of ['pwsh', 'run_code', 'workflow', 'terminal_open', 'cordis_run']) {
    assert.ok(windowsCommandGuard(wsl, { agent, name }));
    assert.equal(windowsCommandGuard(windows, { agent, name }), undefined);
  }
  for (const name of ['read', 'edit', 'grep', 'wsl_bash']) {
    assert.equal(windowsCommandGuard(wsl, { agent, name }), undefined);
  }
});

test('tool preserves the session policy and blocks unsupported modes and presets before spawning', async () => {
  const sim = simulator();
  let preset = 'ptc', policy = { mode: 'workspace-write', workspaceRoot: 'path' };
  const runner = createWslRunner({ getPreset: () => preset, getPolicy: () => policy, getCwd: () => 'cwd',
    subprocess: sim.subprocess, prepare(args) { assert.equal(args.policy, policy); return sim.prepared; } });
  await assert.rejects(runner.execute(agent, target, 'pwd', 4), { code: 'preset-unsupported' });
  preset = 'cordis';
  policy = { mode: 'unknown' };
  await assert.rejects(runner.execute(agent, target, 'pwd', 4), { code: 'policy-unsupported' });
  assert.equal(sim.spawns(), 0);
  policy = { mode: 'danger-full-access', workspaceRoot: 'path' };
  const probe = runner.preflight(agent, target);
  assert.equal(sim.spawns(), 1);
  sim.finish();
  assert.deepEqual(await probe, { ok: true });
  const tool = wslTool({ inspect: () => ({ choice: { mode: 'windows' } }) }, runner);
  await assert.rejects(tool.execute({ command: 'pwd', description: 'Show directory' }, { agent }), { code: 'environment-not-selected' });
});

test('cancellation sends a control marker, but success requires a verified guest receipt', async () => {
  const sim = simulator({ state: 'cancelled' });
  const abort = new AbortController();
  const task = superviseGuest({ subprocess: sim.subprocess, prepared: sim.prepared, signal: abort.signal, seconds: 4 });
  abort.abort();
  assert.equal(sim.content(), 'frame\n!');
  sim.finish(130);
  await assert.rejects(task, { code: 'guest-cancelled' });
  const unverified = simulator({ state: null });
  const uncontrolled = superviseGuest({ subprocess: unverified.subprocess, prepared: unverified.prepared, seconds: 4 });
  unverified.finish(0);
  await assert.rejects(uncontrolled, { code: 'guest-unconfirmed' });
});
