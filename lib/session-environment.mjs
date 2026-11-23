import { parseWslWorkspace } from './workspace.mjs';

export const WINDOWS = 'windows';
export const WSL = 'wsl';

/** Determine initial intent before storing anything. Existing sessions stay as they were. */
export function initialEnvironment({ hostPlatform, workspacePath, started }) {
  const target = hostPlatform === 'win32' ? parseWslWorkspace(workspacePath) : null;
  return target && !started
    ? { mode: WSL, target }
    : { mode: WINDOWS };
}

/** Changes are only valid in an unstarted session; validate at the Host boundary. */
export function chooseEnvironment({ mode, hostPlatform, workspacePath, started }) {
  if (started) return { ok: false, reason: 'session-started' };
  if (mode !== WSL && mode !== WINDOWS) return { ok: false, reason: 'invalid-environment' };
  if (mode === WINDOWS) return { ok: true, choice: { mode: WINDOWS } };
  const target = hostPlatform === 'win32' ? parseWslWorkspace(workspacePath) : null;
  if (!target) return { ok: false, reason: 'not-a-wsl-workspace' };
  return { ok: true, choice: { mode: WSL, target } };
}

/** Do not translate WSL admission failures into requests for a Windows runner. */
export function resolveEnvironment({ choice, hostPlatform, workspacePath, runnerReady }) {
  if (choice?.mode === WINDOWS) return { status: 'ready', mode: WINDOWS };
  if (choice?.mode !== WSL || !choice.target) return { status: 'blocked', reason: 'invalid-environment' };
  const target = hostPlatform === 'win32' ? parseWslWorkspace(workspacePath) : null;
  if (!target || target.distro.toLowerCase() !== choice.target.distro.toLowerCase()
      || target.linuxPath !== choice.target.linuxPath) {
    return { status: 'blocked', mode: WSL, reason: 'workspace-changed' };
  }
  if (!runnerReady) return { status: 'blocked', mode: WSL, reason: 'runner-unavailable' };
  return { status: 'ready', mode: WSL, target };
}
