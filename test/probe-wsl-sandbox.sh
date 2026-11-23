#!/bin/sh
# Capability probe, not an Agent command runner. Run from a WSL checkout.
set -eu

base=$(pwd -P)
case "$base" in
  /home/*) ;;
  *) printf >&2 'Run this probe from a native Linux checkout under /home.\n'; exit 1 ;;
esac
fixture=$(mktemp -d "$base/.dsh-wsl-smoke.XXXXXXXX")
case "$fixture" in
  "$base"/.dsh-wsl-smoke.*) ;;
  *) printf >&2 'Unexpected probe directory: %s\n' "$fixture"; exit 1 ;;
esac
cleanup() {
  [ "$(realpath -e -- "$fixture")" = "$fixture" ] || return 1
  for path in "$fixture/workspace/ok" "$fixture/outside/denied" "$fixture/workspace/read-only-denied"; do
    if [ -f "$path" ]; then unlink "$path"; fi
  done
  rmdir -- "$fixture/workspace" "$fixture/outside" "$fixture"
}
trap cleanup EXIT
mkdir -- "$fixture/workspace" "$fixture/outside"

run() {
  /usr/bin/bwrap \
    --unshare-all --unshare-user --disable-userns --new-session --die-with-parent \
    --ro-bind / / --tmpfs /run --tmpfs /mnt --proc /proc --dev /dev \
    --ro-bind /dev/null /init "$@"
}

run --chdir "$fixture/workspace" -- /bin/sh -eu -c '
  [ "$(uname -s)" = Linux ]
  [ "$(pwd -P)" = "$1" ]
  if (printf x > ./read-only-denied) 2>/dev/null; then exit 1; fi
  [ ! -e /mnt/c ] && [ ! -e /run/WSL ] && [ -c /init ]
' probe "$fixture/workspace"

run --tmpfs /tmp --bind "$fixture/workspace" "$fixture/workspace" \
  --chdir "$fixture/workspace" -- /bin/sh -eu -c '
  printf ok > ./ok
  if (printf x > "$1/outside/denied") 2>/dev/null; then exit 1; fi
  [ ! -e /mnt/c ] && [ ! -e /run/WSL ] && [ -c /init ]
' probe "$fixture"
[ "$(wc -c < "$fixture/workspace/ok")" -eq 2 ]
[ ! -e "$fixture/outside/denied" ] && [ ! -e "$fixture/workspace/read-only-denied" ]
printf '%s\n' 'PASS: WSL read-only and workspace-write mount probe (network isolated)'
