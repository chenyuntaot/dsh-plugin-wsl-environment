import { EnvironmentError } from './session-controller.mjs';

// Workspace-write scans the tree before the command. This matches the guest
// walk budget in lib/wsl-guest.py and is added to the carrier deadline so a
// full scan cannot be reported as a missing completion receipt.
const WRITE_BOUNDARY_BUDGET_SECONDS = 15;
const SUPPORTED_PRESETS = new Set(['standard', 'cordis']);
const SUPPORTED_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const NON_WSL_TOOLS = new Set([
  'pwsh', 'bash', 'run_code', 'terminal_open', 'terminal_send', 'workflow', 'ralph',
  'cordis_define', 'cordis_run',
]);

export function windowsCommandGuard(controller, call) {
  if (call.agent && NON_WSL_TOOLS.has(call.name) && controller.inspect(call.agent).choice.mode === 'wsl') {
    return { reason: 'This session is locked to WSL. Use wsl_bash, or start a separate Windows session.' };
  }
}

// Do not abort the Windows carrier early. A Windows process exit does not prove
// that Linux descendants exited; demand the guest teardown receipt as well.
export async function superviseGuest({ subprocess, prepared, signal, seconds }) {
  signal?.throwIfAborted();
  const { spec, input, inspectExit } = prepared;
  const proc = subprocess.spawn(spec);
  const stdin = proc.stdin;
  if (!stdin) {
    proc.terminate();
    await proc.done.catch(() => {});
    throw new EnvironmentError('guest-unconfirmed', 'The WSL control channel could not be opened.');
  }
  let inputError;
  const recordError = error => { inputError = error; };
  const cancel = () => { if (!stdin.destroyed && !stdin.writableEnded) stdin.end('!'); };
  stdin.on('error', recordError);
  let timer;
  let emergency;
  try {
    stdin.write(input);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const emergencyDeadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        cancel();
        proc.terminate();
        emergency = setTimeout(() => reject(new EnvironmentError('guest-unconfirmed',
          'The WSL carrier did not return; guest termination is not confirmed.')),
        4000);
      }, (seconds + WRITE_BOUNDARY_BUDGET_SECONDS + 12) * 1000);
    });
    const outcome = await Promise.race([proc.done, emergencyDeadline]);
    const nativeExited = await proc.waitForExit(AbortSignal.timeout(4000));
    const out = proc.collected.stdout?.readFrom(0);
    const err = proc.collected.stderr?.readFrom(0);
    const examined = inspectExit(err?.text ?? '');
    if (!nativeExited || !examined.state) {
      const detail = (err?.text || inputError?.message || '').slice(-1200).trim();
      throw new EnvironmentError('guest-unconfirmed',
        `WSL did not provide a verified completion receipt. No Windows command was attempted.${detail ? ` ${detail}` : ''}`);
    }
    if (examined.state === 'cancelled') throw new EnvironmentError('guest-cancelled', 'WSL guest execution cancelled and reaped.');
    if (examined.state === 'rejected') throw new EnvironmentError('runner-unavailable', examined.stderr.trim().slice(-1200) || 'The WSL sandbox refused this command.');
    return {
      state: examined.state,
      exitCode: outcome.exitCode,
      stdout: out?.text ?? '',
      stderr: examined.stderr,
      truncated: !!out?.lossy || !!err?.lossy,
    };
  } finally {
    clearTimeout(timer);
    clearTimeout(emergency);
    signal?.removeEventListener('abort', cancel);
    // If wsl.exe exited after consuming the frame, do not leave the writer open.
    if (!stdin.destroyed) stdin.destroy();
  }
}

export function createWslRunner({ getPolicy, getCwd, getPreset, subprocess, prepare, windowsRoot }) {
  async function execute(agent, target, command, seconds, signal) {
    if (!SUPPORTED_PRESETS.has(getPreset(agent))) {
      throw new EnvironmentError('preset-unsupported', 'WSL commands require the built-in Standard or Creator Agent preset.');
    }
    const policy = getPolicy(agent);
    if (!SUPPORTED_MODES.has(policy.mode)) {
      throw new EnvironmentError('policy-unsupported', 'This permission mode is unsupported for WSL commands; no Windows command was attempted.');
    }
    const prepared = prepare({ policy, workspace: target, workingDirectory: getCwd(agent), windowsRoot,
      command, seconds });
    return superviseGuest({ subprocess, prepared, signal, seconds });
  }

  return {
    execute,
    async preflight(agent, target, signal) {
      try {
        const result = await execute(agent, target, 'printf dsh-wsl-ready', 4, signal);
        if (result.state !== 'completed' || result.exitCode !== 0 || result.stdout !== 'dsh-wsl-ready') {
          return { ok: false, reason: 'The WSL command runner did not pass its startup probe.' };
        }
        return { ok: true };
      } catch (error) {
        signal?.throwIfAborted();
        return { ok: false, reason: String(error?.message || 'The WSL command runner could not be started.').slice(0, 600) };
      }
    },
  };
}

export function wslTool(controller, runner) {
  const schema = {
    type: 'object', additionalProperties: false, required: ['state', 'exitCode', 'stdout', 'stderr', 'truncated'],
    properties: {
      state: { type: 'string', enum: ['completed', 'timeout'] },
      exitCode: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
      stdout: { type: 'string' }, stderr: { type: 'string' }, truncated: { type: 'boolean' },
    },
  };
  return {
    name: 'wsl_bash',
    description: 'Run a Bash command in this session’s selected WSL distribution and current project directory, under the standing DSH permission mode. No Windows fallback. Use DSH file tools as usual.',
    timeoutMs: 170000,
    parameters: {
      type: 'object', additionalProperties: false, required: ['command', 'description'],
      properties: {
        command: { type: 'string', minLength: 1, maxLength: 24576 },
        description: { type: 'string', minLength: 1, maxLength: 180, description: 'Concise user-facing summary.' },
        timeout_seconds: { type: 'integer', minimum: 1, maximum: 120, description: 'Maximum seconds (default 30).' },
      },
    },
    output: {
      schema,
      render(_args, result) {
        const parts = [result.stdout, result.stderr, result.truncated ? '[output truncated]' : '',
          result.state === 'timeout' ? '[WSL command timed out and was reaped]' : '', `[exit code: ${result.exitCode ?? 'none'}]`];
        return [{ type: 'text', text: parts.filter(Boolean).join('\n') }];
      },
    },
    async execute(args, call) {
      const choice = call.agent && controller.inspect(call.agent).choice;
      if (choice?.mode !== 'wsl') throw new EnvironmentError('environment-not-selected', 'This session has not selected WSL.');
      if (typeof args?.command !== 'string' || typeof args?.description !== 'string'
          || !args.description.trim() || args.description.length > 180) {
        throw new EnvironmentError('invalid-command', 'A command and a concise description are required.');
      }
      return runner.execute(call.agent, choice.target, args.command, args.timeout_seconds ?? 30, call.signal);
    },
  };
}
