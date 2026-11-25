// Keep the rc.5 terminal RPC schema when substituting the two native components.
// Tokens are interpreted only as selection hints. The Host validates the selected
// profile or native path against the exact session before preparing the PTY.
const profilePrefix = 'dsh-wsl-profile:';
const preferencePrefix = 'dsh-wsl-preferred:';

export function encodeMenuShell(shell) {
  if (shell.profileId === undefined) return shell;
  return {
    name: shell.name,
    path: profilePrefix + shell.profileId,
    args: [shell.sessionDefault ? 'default' : '', ...shell.unavailableReason ? [shell.unavailableReason] : []],
  };
}

export function decodeMenuShell(shell) {
  if (!shell.path.startsWith(profilePrefix)) return shell;
  return {
    name: shell.name,
    path: '',
    args: [],
    profileId: shell.path.slice(profilePrefix.length),
    sessionDefault: shell.args[0] === 'default',
    unavailableReason: shell.args[1],
  };
}

export function encodeSelection({ shellPath, profileId, preferredShellPath }) {
  if (profileId !== undefined) return { shellPath: profilePrefix + profileId };
  if (shellPath !== undefined) return { shellPath };
  if (preferredShellPath !== undefined) return { shellPath: preferencePrefix + preferredShellPath };
  return {};
}

export function decodeSelection(request) {
  const { shellPath, ...rest } = request;
  if (typeof shellPath === 'string') {
    if (shellPath.startsWith(profilePrefix)) return { ...rest, profileId: shellPath.slice(profilePrefix.length) };
    if (shellPath.startsWith(preferencePrefix)) return { ...rest, preferredShellPath: shellPath.slice(preferencePrefix.length) };
  }
  return request;
}
