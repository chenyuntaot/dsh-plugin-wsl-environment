"""Run the prototype as the distro user, not inside an active Agent session."""
import errno
import json
import os
import shlex
import socket
import subprocess
import sys
import tempfile
from pathlib import Path

BASE = Path(__file__).resolve().parents[1]
if not str(BASE).startswith('/home/'):
    sys.exit('Run from a native WSL checkout under /home.')
RUNNER = BASE / 'lib/wsl-guest.py'

with tempfile.TemporaryDirectory(prefix='.dsh-wsl-guest.', dir=BASE) as temp:
    fixture = Path(temp).resolve(strict=True)
    if fixture.parent != BASE or not fixture.name.startswith('.dsh-wsl-guest.'):
        sys.exit(f'Unexpected fixture path: {fixture}')
    workspace = fixture / 'workspace'
    workspace.mkdir()
    outside = fixture / 'outside'
    outside.write_text('untouched', encoding='utf-8')
    (workspace / 'outside-link').symlink_to(outside)

    def run(mode, command, seconds=8):
        request = {'mode': mode, 'root': str(workspace), 'cwd': str(workspace),
                   'seconds': seconds, 'command': command}
        return subprocess.run(['/usr/bin/python3', '-I', str(RUNNER)], input=json.dumps(request),
                              text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=seconds + 10)

    full = run('danger-full-access', f'''set -e
uname -s
pwd -P
id -u
printf '%s\\n' "$HOME"
printf changed > {shlex.quote(str(outside))}
''')
    assert full.returncode == 0, full
    assert full.stdout.splitlines() == ['Linux', str(workspace), str(os.getuid()), os.environ['HOME']], full
    assert outside.read_text(encoding='utf-8') == 'changed'
    outside.write_text('untouched', encoding='utf-8')
    full_expired = run('danger-full-access', 'sleep 10 & wait', seconds=1)
    assert full_expired.returncode == 124, full_expired

    readonly = run('read-only', 'uname -s; pwd -P; printf denied > ./read-only-new')
    assert readonly.stdout.splitlines() == ['Linux', str(workspace)], readonly
    assert readonly.returncode != 0 and not (workspace / 'read-only-new').exists(), readonly

    writable = run('workspace-write', f'''set -e
printf ok > ./inside
if (printf changed > {shlex.quote(str(outside))}) 2>/dev/null; then exit 1; fi
if (printf changed > ./outside-link) 2>/dev/null; then exit 2; fi
test ! -e /mnt/c && test ! -e /run/WSL && test ! -e /init
''')
    assert writable.returncode == 0, writable
    assert (workspace / 'inside').read_bytes() == b'ok'
    assert outside.read_text(encoding='utf-8') == 'untouched'

    external_alias = workspace / 'hard-link-outside'
    os.link(outside, external_alias)
    rejected = run('workspace-write', 'printf changed > ./hard-link-outside')
    assert rejected.returncode == 125 and 'hard links' in rejected.stderr, rejected
    assert outside.read_text(encoding='utf-8') == 'untouched'
    external_alias.unlink()
    os.link(workspace / 'inside', workspace / 'hard-link-inside')
    admitted = run('workspace-write', 'printf internal > ./hard-link-inside')
    assert admitted.returncode == 0 and (workspace / 'inside').read_bytes() == b'internal', admitted

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        listener.settimeout(1)
        host, port = listener.getsockname()
        script = f'''import errno, socket
for family in (socket.AF_UNIX, socket.AF_VSOCK):
    try:
        socket.socket(family, socket.SOCK_STREAM).close()
    except OSError as exc:
        assert exc.errno == {errno.EPERM}, exc
    else:
        raise SystemExit(f"unexpected restricted socket family: {{family}}")
with socket.create_connection(({host!r}, {port}), timeout=1) as conn:
    conn.sendall(b"ok")
'''
        networking = run('read-only', f'/usr/bin/python3 -I -c {shlex.quote(script)}')
        assert networking.returncode == 0, networking
        conn, _ = listener.accept()
        with conn:
            assert conn.recv(16) == b'ok'

    expired = run('workspace-write', 'sleep 10', seconds=1)
    assert expired.returncode == 124, expired
    print('PASS: prototype WSL paths, permission boundaries, socket filters, TCP and deadline')
