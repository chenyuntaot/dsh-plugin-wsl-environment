import { win32 } from 'node:path';
import { isLexicallyWithin, parseWslWorkspace } from './workspace.mjs';

export const WSL_USER_TERMINAL_ID = 'dsh-wsl-env.wsl';

/** Build a trusted launch declaration for DSH's native user-terminal extension.
 *  The renderer chooses this stable ID only; executable, argv and cwd are Host-owned.
 */
export function wslUserTerminalProfile({ platform, choice, workingDirectory, windowsRoot, ordinarySession = true, runtimeFailure }) {
  if (platform !== 'win32' || !ordinarySession || choice?.mode !== 'wsl') return undefined;
  const workspace = choice.target;
  const profile = { id: WSL_USER_TERMINAL_ID, name: workspace?.distro ? `WSL · ${workspace.distro}` : 'WSL', preferred: true };
  const target = parseWslWorkspace(workingDirectory);
  const unavailable = reason => ({ ...profile, unavailableReason: reason });
  if (runtimeFailure) return unavailable(runtimeFailure);
  if (!isLexicallyWithin(workspace, target)) {
    return unavailable('The current directory is no longer in this session’s WSL project.');
  }
  if (typeof windowsRoot !== 'string' || !/^[A-Za-z]:\\[^\u0000-\u001f]+$/u.test(windowsRoot)) {
    return unavailable('The native Windows system directory is unavailable.');
  }
  const windowsDirectory = win32.join(windowsRoot, 'System32');
  return {
    ...profile,
    launch: {
      path: win32.join(windowsDirectory, 'wsl.exe'),
      args: ['--distribution', workspace.distro, '--cd', target.linuxPath],
      hostCwd: windowsDirectory,
      displayCwd: target.linuxPath,
    },
  };
}

/** Query only the current Session and retain its WSL default when discovery is unavailable. */
export async function resolveWslUserTerminalProfiles({ platform, agent, getChoice, windowsRoot }, signal) {
  signal.throwIfAborted();
  if (platform !== 'win32' || agent.session.header.origin === 'subagent' || getChoice().mode !== 'wsl') return [];
  let runtimeFailure;
  let workingDirectory;
  try {
    const subprocess = agent.ctx.get('subprocess');
    const environment = subprocess && await subprocess.terminalEnvironment(signal);
    if (environment?.platform !== 'windows') {
      runtimeFailure = 'This session does not have a native Windows terminal provider for WSL.';
    } else {
      workingDirectory = agent.ctx.get('workingDirectory')?.get(agent.session);
    }
  } catch {
    runtimeFailure = 'This session’s WSL terminal environment could not be checked.';
  }
  signal.throwIfAborted();
  const profile = wslUserTerminalProfile({ platform, choice: getChoice(), workingDirectory, windowsRoot, runtimeFailure });
  return profile ? [profile] : [];
}
