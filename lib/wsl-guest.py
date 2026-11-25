#!/usr/bin/python3
"""Run and supervise the WSL command selected by the Host policy."""

import ctypes as C
import errno
import json
import os
import re
import select
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

BWRAP = '/usr/bin/bwrap'
CONTROL_RE = re.compile(r'[a-f0-9]{48}')
SYSTEM_DIRS = ('/usr', '/bin', '/lib', '/lib64', '/etc/ssl')
SYSTEM_FILES = ('/etc/passwd', '/etc/group', '/etc/nsswitch.conf', '/etc/hosts', '/etc/resolv.conf', '/etc/localtime')


class FilterArgument(C.Structure):
    _fields_ = [('index', C.c_uint), ('op', C.c_int), ('value', C.c_uint64), ('unused', C.c_uint64)]


def socket_filter():
    """Allow ordinary IP sockets, not guest/host IPC sockets or alternate syscall paths."""
    lib = C.CDLL('libseccomp.so.2')
    lib.seccomp_init.argtypes = [C.c_uint32]
    lib.seccomp_init.restype = C.c_void_p
    lib.seccomp_release.argtypes = [C.c_void_p]
    lib.seccomp_syscall_resolve_name.argtypes = [C.c_char_p]
    lib.seccomp_rule_add_array.argtypes = [C.c_void_p, C.c_uint32, C.c_int, C.c_uint, C.POINTER(FilterArgument)]
    lib.seccomp_export_bpf.argtypes = [C.c_void_p, C.c_int]
    policy = lib.seccomp_init(0x7fff0000)  # SCMP_ACT_ALLOW
    if not policy:
        raise RuntimeError('cannot allocate seccomp filter')
    fd = None
    try:
        def deny(name, comparison=None):
            number = lib.seccomp_syscall_resolve_name(name.encode('ascii'))
            action = 0x00050000 | errno.EPERM  # SCMP_ACT_ERRNO(EPERM)
            if number < 0 or lib.seccomp_rule_add_array(
                policy, action, number, int(comparison is not None),
                C.pointer(comparison) if comparison is not None else None,
            ) != 0:
                raise RuntimeError(f'cannot install seccomp rule: {name}')

        # socket domains: only AF_INET (2) and AF_INET6 (10) are allowed.
        # Internal socketpairs remain available (they do not access outside peers).
        deny('socket', FilterArgument(0, 3, 1, 0))  # LE
        for family in range(3, 10):
            deny('socket', FilterArgument(0, 4, family, 0))  # EQ
        deny('socket', FilterArgument(0, 5, 11, 0))  # GE
        for name in ('io_uring_setup', 'io_uring_register', 'io_uring_enter', 'bpf'):
            deny(name)
        fd = os.memfd_create('dsh-wsl-seccomp', os.MFD_CLOEXEC)
        if lib.seccomp_export_bpf(policy, fd) != 0:
            raise RuntimeError('cannot export seccomp filter')
        os.lseek(fd, 0, os.SEEK_SET)
        os.set_inheritable(fd, True)
        return fd
    except BaseException:
        if fd is not None:
            os.close(fd)
        raise
    finally:
        lib.seccomp_release(policy)


def native_workspace(root, cwd):
    if not isinstance(root, str) or not isinstance(cwd, str) or not root.startswith('/home/'):
        raise ValueError('a native workspace directory under /home is required')
    if len(Path(root).parts) < 4:  # refuse mounting a whole user home
        raise ValueError('select a project directory under your Linux home, not the home itself')
    if (os.getuid() == 0 or len(root) > 4096 or len(cwd) > 4096
            or os.path.realpath(root, strict=True) != root or os.path.realpath(cwd, strict=True) != cwd
            or not os.path.isdir(root) or not os.path.isdir(cwd)
            or os.path.commonpath((root, cwd)) != root):
        raise ValueError('workspace or working directory is not a canonical native directory')
    covering = []
    with open('/proc/self/mountinfo', encoding='utf-8', errors='surrogateescape') as source:
        for row in source:
            before, after = row.rstrip('\n').split(' - ', 1)
            mount = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), before.split()[4])
            if mount == root or mount.startswith(root + '/'):
                raise ValueError('mounted filesystems at or inside the workspace are not supported')
            if mount == '/' or root.startswith(mount + '/'):
                covering.append((mount, after.split()[0]))
    if not covering or max(covering, key=lambda entry: len(entry[0]))[1] != 'ext4':
        raise ValueError('a workspace on the WSL native ext4 filesystem is required')
    return root, cwd


def check_writable_aliases(root):
    # A readonly sibling mount does not protect an inode that already has a
    # writable alias inside the project. Reject aliases we cannot account for.
    deadline = time.monotonic() + 2
    tracked = {}
    scanned = 0

    def fail(error):
        raise error

    for _dir, names, files, owner in os.fwalk(root, follow_symlinks=False, onerror=fail):
        scanned += len(names) + len(files) + 1
        if scanned > 250000 or time.monotonic() > deadline:
            raise ValueError('workspace is too large for the WSL write-boundary check')
        for name in files:
            info = os.stat(name, dir_fd=owner, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                continue
            if not stat.S_ISREG(info.st_mode):
                raise ValueError('special files in a writable workspace are not supported')
            if info.st_nlink > 1:
                key = (info.st_dev, info.st_ino)
                count, expected = tracked.get(key, (0, info.st_nlink))
                if expected != info.st_nlink:
                    raise ValueError('the workspace changed during the WSL write-boundary check')
                tracked[key] = count + 1, expected
    if any(count != expected for count, expected in tracked.values()):
        raise ValueError('the workspace contains file hard links to locations outside it')


def control_nonce(request):
    value = request.get('control') if type(request) is dict else None
    return value if isinstance(value, str) and CONTROL_RE.fullmatch(value) else None


def receipt(nonce, state):
    if nonce is not None:
        print(f'\nDSH-WSL-CONTROL {nonce} {state}', file=sys.stderr, flush=True)


def kill_adopted(child):
    deadline = time.monotonic() + 4
    while True:
        child.poll()
        if child.returncode is not None:
            while True:
                try:
                    pid, _ = os.waitpid(-1, os.WNOHANG)
                except ChildProcessError:
                    return  # ECHILD confirms that all guest descendants are gone.
                if pid == 0:
                    break
        for text in Path('/proc/thread-self/children').read_text(encoding='ascii').split():
            try:
                pidfd = os.pidfd_open(int(text))
            except ProcessLookupError:
                continue
            try:
                try:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            finally:
                os.close(pidfd)
        if time.monotonic() >= deadline:
            raise RuntimeError('guest cleanup unconfirmed: owned descendants did not settle')
        time.sleep(0.02)


def supervise(argv, *, cwd=None, seconds, pass_fds=(), nonce):
    libc = C.CDLL(None, use_errno=True)
    if libc.prctl(36, 1, 0, 0, 0) != 0:  # PR_SET_CHILD_SUBREAPER
        raise OSError(C.get_errno(), 'guest subreaper not available')
    if not hasattr(signal, 'pidfd_send_signal') or not hasattr(os, 'pidfd_open'):
        raise RuntimeError('guest pidfd supervision is not available')
    os.close(os.pidfd_open(os.getpid()))
    cancelled = False

    def on_signal(_signum, _frame):
        nonlocal cancelled
        cancelled = True

    for signum in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT):
        signal.signal(signum, on_signal)
    if nonce is not None:
        os.set_blocking(0, False)

    def stop_requested():
        # The initial buffered read may already hold a control byte. Descriptor
        # readiness without bytes also reports EOF after a carrier disconnect.
        return cancelled or (nonce is not None and (bool(sys.stdin.buffer.peek(1)) or bool(select.select([0], [], [], 0)[0])))

    if stop_requested():
        return 130, 'cancelled'
    deadline = time.monotonic() + seconds
    child = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.DEVNULL, close_fds=True,
                             pass_fds=pass_fds, start_new_session=True)
    try:
        while True:
            if stop_requested():
                return 130, 'cancelled'
            code = child.poll()
            if code is not None:
                return (code if code >= 0 else 128 - code), 'completed'
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return 124, 'timeout'
            time.sleep(min(remaining, 0.05))
    finally:
        kill_adopted(child)


def launch(request):
    basic = {'mode', 'root', 'cwd', 'seconds', 'command'}
    if type(request) is not dict or request.keys() not in (basic, basic | {'control'}):
        raise ValueError('invalid launch request')
    nonce = control_nonce(request)
    if 'control' in request and nonce is None:
        raise ValueError('invalid cancellation channel')
    mode, seconds, command = request['mode'], request['seconds'], request['command']
    if mode not in ('read-only', 'workspace-write', 'danger-full-access') or type(seconds) is not int or not 1 <= seconds <= 120:
        raise ValueError('unsupported guest mode or deadline')
    if not isinstance(command, str) or not command or '\0' in command or len(command.encode()) > 24576:
        raise ValueError('unsupported command length or contents')
    bash = ['/bin/bash', '--noprofile', '--norc', '-c', command]
    if mode == 'danger-full-access':
        # Inherit the distro user's environment and mount namespace. The Host
        # still pins the distro and initial project directory per session.
        return supervise(bash, cwd=request['cwd'], seconds=seconds, nonce=nonce)

    root, cwd = native_workspace(request['root'], request['cwd'])
    if mode == 'workspace-write':
        check_writable_aliases(root)
    fd = socket_filter()
    opts = ['--unshare-all', '--unshare-user', '--share-net', '--disable-userns',
            '--new-session', '--die-with-parent', '--clearenv', '--seccomp', str(fd),
            '--dev', '/dev', '--proc', '/proc', '--dir', '/etc', '--dir', '/tmp']
    for path in SYSTEM_DIRS + SYSTEM_FILES:
        opts += ['--ro-bind-try', path, path]
    opts += ['--bind' if mode == 'workspace-write' else '--ro-bind', root, root]
    if mode == 'workspace-write':
        opts += ['--tmpfs', '/tmp']
    opts += ['--setenv', 'HOME', root, '--setenv', 'PATH', '/usr/local/bin:/usr/bin:/bin',
             '--setenv', 'LANG', 'C.UTF-8', '--setenv', 'TMPDIR', '/tmp',
             '--remount-ro', '/', '--chdir', cwd, '--', *bash]
    try:
        return supervise([BWRAP, *opts], seconds=seconds, pass_fds=(fd,), nonce=nonce)
    finally:
        os.close(fd)


if __name__ == '__main__':
    try:
        data = sys.stdin.buffer.readline(65537)
        if len(data) > 65536:
            raise ValueError('request is too large')
        request = json.loads(data)
        nonce = control_nonce(request)
        if nonce is not None and not data.endswith(b'\n'):
            raise ValueError('incomplete control frame')
        code, state = launch(request)
        receipt(nonce, state)
        sys.exit(code)
    except (ValueError, TypeError, KeyError, OSError, RuntimeError) as exc:
        print(f'DSH WSL guest: {exc}', file=sys.stderr)
        sys.exit(125)
