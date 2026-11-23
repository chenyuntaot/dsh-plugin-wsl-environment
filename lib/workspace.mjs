// Only the command runner consumes this mapping; DSH keeps its Windows path.
const WSL_UNC = /^\\\\(?:\?\\UNC\\)?(?:wsl\.localhost|wsl\$)\\([^\\]+)(?:\\(.*))?$/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const DISTRO = /^[^\\/:*?"<>|]+$/u;

/** Recognize the UNC namespaces published by Windows for WSL distributions. */
export function parseWslWorkspace(value) {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const match = WSL_UNC.exec(value.replaceAll('/', '\\'));
  if (!match) return null;

  const [, distro, relative = ''] = match;
  if (!DISTRO.test(distro) || distro.trim() !== distro || distro === '.' || distro === '..' || distro.startsWith('-')) return null;
  const tail = relative.endsWith('\\') ? relative.slice(0, -1) : relative;
  const parts = tail === '' ? [] : tail.split('\\');
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) return null;
  return { distro, linuxPath: `/${parts.join('/')}` };
}

/** Prefilter only: the WSL runner must separately check canonical paths. */
export function isLexicallyWithin(workspace, candidate) {
  if (!workspace || !candidate || workspace.distro.toLowerCase() !== candidate.distro.toLowerCase()) return false;
  return workspace.linuxPath === '/'
    || candidate.linuxPath === workspace.linuxPath
    || candidate.linuxPath.startsWith(`${workspace.linuxPath}/`);
}
