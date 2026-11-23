window.__ModuleLoader__.load({
  id: 'dsh-wsl-env',
  factory(require) {
    const { createElement: h, useEffect, useId, useRef, useState } = require('react');
    const slot = 'conversation.input.left';
    const namespace = 'dsh-wsl-env';
    const channel = '/api';
    const catalog = {
      en: {
        label: 'Session execution environment',
        checking: 'Checking environment…',
        saving: 'Saving environment…',
        unavailable: 'Environment unavailable',
        wslUnavailable: 'WSL unavailable',
        locked: 'Locked after the first accepted message. Start a new session to change the environment.',
        readFailed: 'Could not check the execution environment.',
        writeFailed: 'Could not change the execution environment.',
        details: 'Environment details',
        retry: 'Check again',
      },
      zh: {
        label: '会话执行环境',
        checking: '正在检查环境…',
        saving: '正在保存环境…',
        unavailable: '执行环境不可用',
        wslUnavailable: 'WSL 不可用',
        locked: '首条消息提交后不可更改。请新建会话以切换环境。',
        readFailed: '无法检查执行环境。',
        writeFailed: '无法切换执行环境。',
        details: '执行环境详情',
        retry: '重新检查',
      },
    };

    const menuCss = `
      .dsh-wsl-trigger,.dsh-wsl-option { font: inherit; cursor: pointer; }
      .dsh-wsl-trigger { color: var(--dsw-alias-label-secondary); background: transparent; }
      .dsh-wsl-option { color: inherit; background: transparent; }
      .dsh-wsl-trigger[aria-disabled="true"],.dsh-wsl-option:disabled { cursor: default; }
      .dsh-wsl-trigger:not([aria-disabled="true"]):hover,.dsh-wsl-trigger[data-open="true"],.dsh-wsl-option:enabled:hover,.dsh-wsl-option:focus-visible { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
      .dsh-wsl-trigger:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
      .dsh-wsl-option:focus-visible { outline: 1px solid var(--dsw-alias-border-l2); outline-offset: -1px; }
      .dsh-wsl-option:disabled { opacity: .48; }
    `;
    const triggerStyle = {
      boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', gap: '6px',
      maxWidth: 'min(32vw, 192px)', height: '28px', padding: '0 6px', border: 'none',
      borderRadius: 'var(--dsw-radius-sm, 6px)', whiteSpace: 'nowrap', fontSize: '13px', lineHeight: '20px', fontWeight: 500,
    };
    const popoverStyle = {
      boxSizing: 'border-box', inset: 'auto', position: 'fixed', margin: 0, padding: '4px',
      color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-overlay)',
      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '10px',
      boxShadow: '0 8px 24px color-mix(in srgb, var(--dsw-alias-bg-base) 65%, transparent)',
      overflow: 'auto', maxHeight: 'calc(100vh - 16px)', scrollbarWidth: 'thin',
    };
    const optionStyle = {
      width: '100%', minHeight: '34px', padding: '5px 8px', display: 'grid', alignItems: 'center',
      gridTemplateColumns: '16px minmax(0, 1fr) 14px', gap: '8px', textAlign: 'start',
      boxSizing: 'border-box', border: 'none', borderRadius: '6px',
    };
    const labelOverflow = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };

    function glyph(name, size = 16, style) {
      const paths = {
        windows: 'M3 3h8v8H3z M13 3h8v8h-8z M3 13h8v8H3z M13 13h8v8h-8z',
        terminal: 'M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z M7 9l3 3-3 3 M13 15h4',
        check: 'm5 12 4 4L19 6',
        chevron: 'm6 9 6 6 6-6',
        lock: 'M6 11h12v9H6z M8 11V7a4 4 0 0 1 8 0v4',
      };
      return h('svg', { 'aria-hidden': true, width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.65, strokeLinecap: 'round', strokeLinejoin: 'round',
        style: { flexShrink: 0, ...style },
      }, h('path', { d: paths[name] }));
    }

    function EnvironmentMenu({ editable, locked, busy, value, label, title, options, choose }) {
      const id = useId();
      const trigger = useRef(null);
      const popup = useRef(null);
      const [open, setOpen] = useState(false);
      const entries = () => Array.from(popup.current?.querySelectorAll('button:not(:disabled)') ?? []);

      function place() {
        const menu = popup.current;
        const anchor = trigger.current;
        if (!menu || !anchor) return;
        const r = anchor.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) { close(false); return; }
        const width = Math.max(0, Math.min(Math.max(178, r.width), window.innerWidth - 16));
        menu.style.width = `${width}px`;
        const start = window.getComputedStyle(anchor).direction === 'rtl' ? r.right - width : r.left;
        menu.style.left = `${Math.max(8, Math.min(start, window.innerWidth - width - 8))}px`;
        const below = window.innerHeight - r.bottom - 14;
        const above = r.top - 14;
        const height = menu.offsetHeight;
        const flip = below < height && above > below;
        menu.style.top = `${Math.max(8, Math.min(flip ? r.top - height - 6 : r.bottom + 6, window.innerHeight - height - 8))}px`;
      }

      function close(restore) {
        if (popup.current?.matches(':popover-open')) popup.current.hidePopover();
        if (restore) trigger.current?.focus({ preventScroll: true });
      }

      function show(direction) {
        const menu = popup.current;
        if (!editable || !menu || typeof menu.showPopover !== 'function') return;
        if (menu.matches(':popover-open')) { close(false); return; }
        menu.showPopover({ source: trigger.current });
        place();
        const items = entries();
        const target = direction === 'last' ? items.at(-1)
          : direction === 'first' ? items[0]
          : items.find(item => item.getAttribute('aria-checked') === 'true') ?? items[0];
        target?.focus({ preventScroll: true });
      }

      useEffect(() => {
        const menu = popup.current;
        const onToggle = event => setOpen(event.newState === 'open');
        menu?.addEventListener('toggle', onToggle);
        return () => menu?.removeEventListener('toggle', onToggle);
      }, []);
      useEffect(() => { if (!editable) close(false); }, [editable]);
      useEffect(() => {
        if (!open) return undefined;
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);

      function keydown(event) {
        const items = entries();
        if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(true); return; }
        if (event.key === 'Tab') { close(true); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !items.length) return;
        event.stopPropagation(); event.preventDefault();
        const current = items.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
          : event.key === 'ArrowUp' ? (current <= 0 ? items.length - 1 : current - 1)
          : (current + 1) % items.length;
        items[next]?.focus({ preventScroll: true });
      }

      return h('span', { style: { display: 'inline-flex', minWidth: 0 } }, h('style', null, menuCss),
        h('button', { type: 'button', className: 'dsh-wsl-trigger', style: triggerStyle,
          ref: trigger, disabled: !editable && !busy, 'aria-disabled': !editable,
          popoverTarget: id, 'aria-haspopup': 'menu', 'aria-controls': id,
          'aria-expanded': open, 'aria-busy': busy, 'aria-label': `${title}：${label}`, 'data-open': open,
          onClick: event => { event.preventDefault(); show(); }, onKeyDown: event => {
            if (!editable || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return;
            event.stopPropagation(); event.preventDefault(); show(event.key === 'ArrowUp' ? 'last' : 'first');
          },
        }, value && glyph(value === 'wsl' ? 'terminal' : 'windows', 14),
        h('span', { style: labelOverflow }, label),
        locked ? glyph('lock', 12) : editable ? glyph('chevron', 12, { transform: open ? 'rotate(180deg)' : undefined }) : null),
        h('div', { id, ref: popup, popover: 'auto', role: 'menu', 'aria-label': title, style: popoverStyle, onKeyDown: keydown },
          options.map(option => h('button', { key: option.mode, type: 'button', role: 'menuitemradio',
            'aria-checked': option.mode === value, disabled: option.disabled, className: 'dsh-wsl-option',
            title: option.label, style: optionStyle, onClick: () => { close(true); choose(option.mode); },
          }, glyph(option.mode === 'wsl' ? 'terminal' : 'windows'), h('span', { style: labelOverflow }, option.label),
          option.mode === value ? glyph('check', 14, { color: 'var(--dsw-alias-brand-primary)' }) : null))),
      );
    }

    const announcementStyle = {
      position: 'absolute', width: '1px', height: '1px', padding: 0,
      overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
    };

    // Use the Host's exact routes through the authenticated DSH connection.
    function createRemoteAdapter(connection) {
      if (typeof connection?.rpc?.call !== 'function') return undefined;
      return {
        status: (sessionId, signal) => connection.rpc.call(channel, 'dsh-wsl-env/status', { args: { sessionId } }, signal),
        set: (sessionId, mode, signal) => connection.rpc.call(channel, 'dsh-wsl-env/set', { args: { sessionId, mode } }, signal),
      };
    }

    function statusValue(reply) {
      if (reply?.ok !== true) {
        throw new Error(typeof reply?.error?.message === 'string' ? reply.error.message : '');
      }
      const value = reply.value;
      if (value === null || typeof value !== 'object'
        || typeof value.applicable !== 'boolean'
        || (value.mode !== 'windows' && value.mode !== 'wsl')
        || typeof value.locked !== 'boolean' || typeof value.wslReady !== 'boolean'
        || (value.distro !== undefined && typeof value.distro !== 'string')
        || (value.reason !== undefined && typeof value.reason !== 'string')) {
        throw new Error('');
      }
      return value;
    }

    function SessionEnvironment(props) {
      const { api, sessionId, subscribeReconnect, t, useAccess, useInput, useProjection, useSession } = props;
      const historyOpen = useSession(s => s.openState === 'open');
      const blank = useSession(s => s.blank);
      const awaitingFirstTurn = useSession(s => s.awaitingFirstTurn);
      const running = useSession(s => s.running);
      const ordinary = useSession(s => !s.removed && s.subagent === null);
      const inputPhase = useInput(s => s.phase);
      const permission = useProjection('permissions', value => value?.currentValue);
      const preset = useProjection('agentPreset');
      const canRead = useAccess('dshWslEnv/status');
      const canSet = useAccess('dshWslEnv/set');
      const localLock = !blank || awaitingFirstTurn || running;
      const inputBusy = inputPhase === 'adjudicating' || inputPhase === 'submitting' || inputPhase === 'sending';
      const [status, setStatus] = useState(null);
      const [failure, setFailure] = useState(null);
      const [saving, setSaving] = useState(false);
      const [refresh, setRefresh] = useState(0);
      const [checking, setChecking] = useState(true);
      const read = useRef(null);
      const write = useRef(null);
      const tabs = useRef(null);

      useEffect(() => subscribeReconnect(() => {
        setChecking(true);
        setRefresh(rev => rev + 1);
      }), [subscribeReconnect]);
      useEffect(() => {
        const checkAgain = () => {
          if (write.current !== null) return;
          setChecking(true);
          setRefresh(rev => rev + 1);
        };
        const broadcast = typeof BroadcastChannel === 'function' ? new BroadcastChannel('dsh-wsl-env') : null;
        const onMessage = event => { if (event.data === sessionId) checkAgain(); };
        broadcast?.addEventListener('message', onMessage);
        tabs.current = broadcast;
        window.addEventListener('focus', checkAgain);
        return () => {
          window.removeEventListener('focus', checkAgain);
          broadcast?.close();
          tabs.current = null;
        };
      }, [sessionId]);
      useEffect(() => () => {
        read.current?.abort();
        write.current?.abort();
      }, []);

      useEffect(() => {
        if (!canRead || !ordinary || !historyOpen || write.current !== null) return undefined;
        const request = new AbortController();
        read.current = request;
        setChecking(true);
        void (async () => {
          try {
            const next = statusValue(await api.status(sessionId, request.signal));
            if (!request.signal.aborted) {
              setStatus(next);
              setFailure(error => error?.action === 'set' ? error : null);
            }
          } catch (error) {
            if (!request.signal.aborted) {
              setStatus(null);
              setFailure(current => current?.action === 'set' ? current : { action: 'status', detail: error?.message });
            }
          } finally {
            if (read.current === request && !request.signal.aborted) {
              read.current = null;
              setChecking(false);
            }
          }
        })();
        return () => {
          request.abort();
          if (read.current === request) read.current = null;
        };
      }, [api, canRead, historyOpen, localLock, ordinary, permission, preset, refresh, sessionId]);

      if (!canRead || !ordinary || !historyOpen || status?.applicable === false) {
        return null;
      }
      const locked = localLock || status?.locked === true;
      const editable = canSet && !locked && !inputBusy && !saving && !checking && status?.applicable === true;
      const wslLabel = status?.wslReady === true
        ? status.distro ? `WSL · ${status.distro}` : 'WSL'
        : t('wslUnavailable');
      const options = [
        { mode: 'windows', label: 'Windows', disabled: !editable },
        { mode: 'wsl', label: wslLabel, disabled: !editable || !status?.wslReady },
      ];
      const selectedLabel = !status ? t(checking ? 'checking' : 'unavailable')
        : status.mode === 'wsl' ? wslLabel : 'Windows';
      const errorText = failure === null ? '' : [
        t(failure.action === 'set' ? 'writeFailed' : 'readFailed'), failure.detail,
      ].filter(Boolean).join(' ');
      const unavailable = status?.wslReady === false ? status.reason || t('wslUnavailable') : '';
      const feedback = saving ? t('saving') : checking ? t('checking') : '';
      const explanation = [feedback, locked ? t('locked') : '', errorText, unavailable].filter(Boolean).join(' ');

      function choose(mode) {
        if (!editable || write.current !== null || mode === status.mode || (mode !== 'windows' && mode !== 'wsl')) return;
        if (mode === 'wsl' && !status.wslReady) return;
        read.current?.abort();
        read.current = null;
        const request = new AbortController();
        write.current = request;
        setSaving(true);
        setFailure(null);
        void (async () => {
          try {
            const next = statusValue(await api.set(sessionId, mode, request.signal));
            if (!request.signal.aborted) {
              setStatus(next);
              tabs.current?.postMessage(sessionId);
            }
          } catch (error) {
            if (!request.signal.aborted) {
              setStatus(null);
              setFailure({ action: 'set', detail: error?.message });
            }
          } finally {
            if (write.current === request && !request.signal.aborted) {
              write.current = null;
              setSaving(false);
              // Reconcile rejection, lost acknowledgment, or another tab's first prompt.
              setChecking(true);
              setRefresh(rev => rev + 1);
            }
          }
        })();
      }

      const details = (errorText || unavailable || locked) ? h('details', {
        style: { position: 'relative', flexShrink: 0 },
      }, h('summary', {
        'aria-label': t('details'), title: t('details'),
        style: { cursor: 'pointer', listStyle: 'none', fontSize: '0.85em',
          color: errorText || unavailable ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-secondary)' },
      }, 'ⓘ'), h('div', { style: {
        position: 'absolute', insetInlineStart: 0, bottom: 'calc(100% + 8px)', zIndex: 5,
        width: 'min(290px, 65vw)', padding: '8px 10px', boxSizing: 'border-box',
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-overlay)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '8px', whiteSpace: 'normal',
      } }, explanation, !checking && !saving && (errorText || unavailable) ? h('button', {
        type: 'button', onClick: () => { setChecking(true); setRefresh(rev => rev + 1); },
        style: { display: 'block', marginTop: '5px', font: 'inherit',
          color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '5px' },
      }, t('retry')) : null)) : null;
      return h('span', { title: explanation || t('label'), style: { display: 'inline-flex', alignItems: 'center', gap: '2px' } },
        h(EnvironmentMenu, { editable, locked, busy: saving || checking, value: status?.mode,
          label: selectedLabel, title: t('label'), options, choose }),
        details, h('span', { role: 'status', style: announcementStyle }, explanation),
      );
    }

    function EnvironmentSelector(props) {
      return h(SessionEnvironment, { ...props, key: props.sessionId });
    }

    return {
      inject: ['locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, catalog));
        ctx.inject(['connection'], scope => {
          const api = createRemoteAdapter(scope.connection);
          if (api === undefined) return;
          const subscribeReconnect = listener => scope.on('connection/reset', listener);
          scope.slots.inject(slot, () => scope.slots.register({
            name: slot,
            id: namespace,
            order: 0,
            locale: namespace,
            inject: () => ({ api, subscribeReconnect }),
          }, EnvironmentSelector));
        });
      },
    };
  },
});
