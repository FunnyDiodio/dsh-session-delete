/**
 * dsh-session-delete — Client half.
 *
 * Registers one destructive row (order 420, danger styling) in every
 * sidebar session "..." menu and the shell.overlay confirmation dialog that
 * row requests. The dialog follows the host's archive/rename dialog pattern:
 * the menu row only raises a request (menus unmount on select), the overlay
 * entry owns the modal, and the confirmed delete calls this package's own
 * host route.
 */
window.__ModuleLoader__.load({
  id: '@funny_diodio/dsh-session-delete',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'session-delete';
    const ROUTE = '/session-delete/api/delete';
    const CSS_PREFIX = 'sdSessionDelete';

    // ── Minimal observable store (subscribe + getSnapshot) ────────────────
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        set(next) {
          value = next;
          for (const listener of [...listeners]) listener();
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    /** One pending delete request: { sessionId, displayTitle, seq } or null. */
    let requestStore;

    /** The locale service once apply has started; dictionaries below. */
    let localeService = null;

    /**
     * The plugin's dictionaries, keyed by the DSH locale ids the desktop
     * ships ('zh-CN' folds into the zh branch below).
     */
    const DICTS = {
      zh: {
        'menu.delete': '删除会话',
        'delete.title': '删除此会话？',
        'delete.desc': '“{title}”的对话记录将被永久删除、无法找回（该会话生成的工作区文件不受影响，会保留）。删除前请先让该会话把重要结论存成文件，或导出日志。',
        'delete.forceLabel': '强制删除（停止其工作与后台任务，直接彻底删除）',
        'delete.action': '删除',
        'delete.pending': '正在删除会话…',
        'delete.errorActivity': '该会话仍有正在进行的工作；勾选「强制删除」可直接停止并删除。',
        'delete.errorLive': '该会话正在运行或仍被打开；勾选「强制删除」可直接删除。',
        'delete.errorRelease': '该会话被其标签页占用且无法自动释放，请关闭该标签页后重试。',
        'delete.errorPending': '该会话还有未落盘的内容，请稍后重试。',
        'delete.errorDisk': '会话记录文件删除失败，注册表未被修改，请稍后重试。',
        'delete.errorNotFound': '未找到该会话的记录，可能已被删除。',
        cancel: '取消',
        close: '关闭',
      },
      en: {
        'menu.delete': 'Delete session',
        'delete.title': 'Delete this session?',
        'delete.desc': '"{title}"\'s conversation log will be permanently deleted and cannot be recovered (files it created in the workspace are kept). Before deleting, have the session save important conclusions to a file, or export its log.',
        'delete.forceLabel': 'Force delete (stop its work and background tasks, then delete outright)',
        'delete.action': 'Delete',
        'delete.pending': 'Deleting session…',
        'delete.errorActivity': 'This session still has work in progress; tick Force delete to stop it and delete outright.',
        'delete.errorLive': 'This session is running or still open; tick Force delete to delete it outright.',
        'delete.errorRelease': 'This session is held open by its tab and could not be released automatically. Close the tab and retry.',
        'delete.errorPending': 'This session still has unmaterialized content. Retry shortly.',
        'delete.errorDisk': 'The session log could not be removed; the registry was left untouched. Retry shortly.',
        'delete.errorNotFound': 'No session record was found; it may already be deleted.',
        cancel: 'Cancel',
        close: 'Close',
      },
    };

    /**
     * Translate one key with {placeholder} interpolation. The active locale
     * comes from the DSH locale service when available (the host preference
     * wins over the browser language, and switches live); the zh branch
     * covers every zh-* id.
     */
    function t(key, params) {
      let active = 'en';
      try {
        active = localeService?.getSnapshot().active ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
      } catch {
        active = typeof navigator !== 'undefined' ? navigator.language : 'en';
      }
      const dict = String(active).toLowerCase().startsWith('zh') ? DICTS.zh : DICTS.en;
      let text = dict[key] ?? DICTS.en[key];
      if (text === undefined) return key;
      if (params !== undefined) {
        for (const [name, value] of Object.entries(params)) {
          text = text.replaceAll(`{${name}}`, String(value));
        }
      }
      return text;
    }

    /** Same-origin POST to this package's host route. */
    async function callDelete(sessionId, force, diag) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, force: force === true, ...(diag ? { diag: String(diag).slice(0, 400) } : {}) }),
      });
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (!response.ok || body?.ok !== true) {
        const error = new Error(typeof body?.error === 'string' ? body.error : `HTTP ${response.status}`);
        error.code = typeof body?.error === 'string' ? body.error : 'http';
        if (typeof body?.message === 'string') error.message = body.message;
        throw error;
      }
      return body;
    }

    /** Trash-can icon, 14px to match the native menu icons. */
    function TrashIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true,
        style: { flex: 'none' },
      },
        h('path', {
          d: 'M6.5 2.25a.75.75 0 0 0-.75.75v.75H3a.75.75 0 0 0 0 1.5h10a.75.75 0 0 0 0-1.5h-2.75V3a.75.75 0 0 0-.75-.75h-3Zm.75 1.5h1.5V3h-1.5v.75Z',
          fill: 'currentColor',
        }),
        h('path', {
          d: 'M4.5 6.5h7l-.5 6.4a1.5 1.5 0 0 1-1.5 1.35h-3A1.5 1.5 0 0 1 5 12.9l-.5-6.4Z',
          fill: 'currentColor',
        }));
    }

    /**
     * The menu row. Props arrive from the slot pipeline: `sessionId` and
     * `displayTitle` from the row, `useMenuOpenState` from the slot's
     * declared hooks, plus this entry's own `requestSessionDelete`.
     */
    function DeleteSessionMenuItem(props) {
      const { sessionId, useMenuOpenState, requestSessionDelete } = props;
      if (typeof useMenuOpenState !== 'function') return null;
      const [, setMenuOpen] = useMenuOpenState();
      return h('button', {
        type: 'button',
        role: 'menuitem',
        className: `${CSS_PREFIX}__item`,
        onClick: () => {
          // Close the menu first (the row unmounts on close), then raise the
          // request for the overlay dialog — the same ordering the native
          // rename row uses.
          setMenuOpen(false);
          requestSessionDelete(sessionId, props.displayTitle ?? '');
        },
      },
        h('span', { className: `${CSS_PREFIX}__itemIcon` }, h(TrashIcon)),
        h('span', { className: `${CSS_PREFIX}__itemLabel` }, t('menu.delete')));
    }

    /**
     * The shell.overlay entry: nothing while no request is pending, otherwise
     * one confirmation dialog. Markup mirrors the host Modal primitive
     * (renamed classes under this plugin's prefix; only --dsw-alias-* tokens).
     */
    function DeleteSessionOverlay(props) {
      const request = React.useSyncExternalStore(
        (onStoreChange) => requestStore.subscribe(onStoreChange),
        () => requestStore.getSnapshot(),
      );
      const [deleting, setDeleting] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [force, setForce] = React.useState(false);
      // What the silent release did this attempt, reported to the host log.
      let releaseDiag = 'no-release-attempted';
      // Standard slot hook from the shell: is THIS page's main view holding
      // the pending session open? (Force delete silently releases it first.)
      // Call the hook UNCONDITIONALLY every render (Rules of Hooks: a
      // conditional hook call crashes the entry — the abdicated entry then
      // never renders the dialog again). The null check lives inside the
      // selector instead.
      const pendingRequest = request;
      const openHere = typeof props.useSessions === 'function'
        ? props.useSessions((s) => {
            if (pendingRequest === null) return false;
            const row = s.byId[pendingRequest.sessionId];
            return row !== void 0 && (row.retainedBy?.mainView ?? 0) > 0;
          })
        : false;

      // Reset the transient dialog state whenever a new request arrives.
      React.useEffect(() => {
        setDeleting(false);
        setError(null);
        setForce(false);
      }, [request?.sessionId, request?.seq]);

      // Publish the in-flight flag onto the pending request so the frame-level
      // Escape listener (which cannot see this component's state) honors it.
      React.useEffect(() => {
        if (request === null || request.busy === deleting) return;
        requestStore.set({ ...request, busy: deleting });
      }, [deleting]);

      if (request === null) return null;

      const close = () => {
        if (deleting) return;
        requestStore.set(null);
      };

      const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      // Replicate the native tab-close: uiWorkspace.archiveSession, when the
      // archived session is the open main view, runs clearMain() — release
      // the mainView retain FIRST, then selectPanel(null). v1.2.2 only did
      // the panel switch, so the retain was never let go and the host always
      // timed out. Archive-then-unarchive (both durable-idempotent; archive
      // refuses while work runs, so a busy session stays untouched and the
      // retry surfaces the honest activity error) buys exactly that release.
      // Records what it saw into `releaseDiag` so the host request can carry
      // the client-side truth (one failed guess-and-check cycle per log line).
      const silentRelease = async (sessionId) => {
        const ws = props.uiWorkspace;
        if (ws === undefined || typeof ws.archiveSession !== 'function' || typeof ws.unarchiveSession !== 'function') {
          releaseDiag = `no-uiWorkspace(service=${ws === undefined ? 'absent' : 'shape-mismatch'});panel-switch-only`;
          try { props.layout?.selectPanel?.(null); } catch { /* attempts report */ }
          return;
        }
        try {
          await ws.archiveSession(sessionId);
          await ws.unarchiveSession(sessionId);
          releaseDiag = 'archive+unarchive ok';
        } catch (reason) {
          releaseDiag = `archive threw: ${String(reason?.message ?? reason).slice(0, 120)}`;
        }
      };

      // One delete attempt; on a force-request that the host refused for a
      // still-held session, silently release the main view first (the same
      // un-retain the user's own tab-close performs — no user concept), then
      // retry with a settle delay. Stage caps at 2 to keep failures honest.
      const attemptDelete = async (stage) => {
        try {
          await callDelete(request.sessionId, force, releaseDiag);
          requestStore.set(null);
        } catch (reason) {
          const code = reason?.code;
          const held = code === 'release-failed' || code === 'live-session';
          if (force && held && stage === 0) {
            await silentRelease(request.sessionId);
            try { props.layout?.selectPanel?.(null); } catch { /* retry still may land */ }
            await waitMs(600);
            return attemptDelete(1);
          }
          if (force && held && stage === 1) {
            await waitMs(1500);
            return attemptDelete(2);
          }
          setDeleting(false);
          if (code === 'live-session') setError(t('delete.errorLive'));
          else if (held) setError(t('delete.errorRelease'));
          else if (code === 'activity') setError(t('delete.errorActivity'));
          else if (code === 'pending-session') setError(t('delete.errorPending'));
          else if (code === 'disk-remove-failed') setError(t('delete.errorDisk'));
          else if (code === 'not-found') setError(t('delete.errorNotFound'));
          // any other failure: the server message is the most honest text we
          // have; show it verbatim.
          else setError(reason instanceof Error ? reason.message : String(reason));
        }
      };

      const confirm = () => {
        if (deleting) return;
        setDeleting(true);
        setError(null);
        // Proactive silent release: the session is open in THIS page's main
        // view and the caller forced the delete — release before the first
        // attempt instead of eating a guaranteed 409 round-trip.
        if (force && openHere) {
          (async () => {
            await silentRelease(request.sessionId);
            try { props.layout?.selectPanel?.(null); } catch { /* first attempt reports */ }
            await waitMs(600);
            await attemptDelete(1);
          })();
          return;
        }
        attemptDelete(0);
      };

      return h('div', { className: `${CSS_PREFIX}__modalRoot` },
        h('div', {
          className: `${CSS_PREFIX}__modalMask`,
          onClick: close,
          'aria-hidden': true,
        }),
        h('div', {
          className: `${CSS_PREFIX}__modalDialog`,
          role: 'alertdialog',
          'aria-modal': 'true',
          'aria-label': t('delete.title'),
          tabIndex: -1,
        },
          h('div', { className: `${CSS_PREFIX}__modalHeader` },
            h('h2', { className: `${CSS_PREFIX}__modalTitle` }, t('delete.title')),
            h('button', {
              type: 'button',
              className: `${CSS_PREFIX}__modalClose`,
              'aria-label': t('close'),
              disabled: deleting,
              onClick: close,
            }, '✕'),
          ),
          h('p', { className: `${CSS_PREFIX}__modalDesc` },
            t('delete.desc', { title: request.displayTitle || request.sessionId })),
          h('div', { className: `${CSS_PREFIX}__modalBody` },
            deleting ? h('div', { className: `${CSS_PREFIX}__status`, role: 'status' }, t('delete.pending')) : null,
            error !== null ? h('div', { className: `${CSS_PREFIX}__error`, role: 'alert' }, error) : null,
            // The force checkbox stays visible beside any refusal (notably
            // live-session): the refusal IS the moment force helps, so
            // hiding it forces a close-and-reopen cycle to recover.
            !deleting && h('label', { className: `${CSS_PREFIX}__forceLabel` },
              h('input', {
                type: 'checkbox',
                checked: force,
                onChange: (e) => setForce(e.target.checked),
                disabled: deleting,
              }),
              h('span', { className: `${CSS_PREFIX}__forceLabelText` }, t('delete.forceLabel')),
            ),
          ),
          h('div', { className: `${CSS_PREFIX}__modalFooter` },
            h('button', {
              type: 'button',
              className: `${CSS_PREFIX}__btn ${CSS_PREFIX}__btnOutline`,
              disabled: deleting,
              onClick: close,
            }, t('cancel')),
            h('button', {
              type: 'button',
              className: `${CSS_PREFIX}__btn ${CSS_PREFIX}__btnDanger`,
              disabled: deleting,
              onClick: confirm,
            }, t('delete.action')),
          ),
        ),
      );
    }

    // Escape handling for the dialog, registered once per apply.
    let keyListener = null;

    /** Package-owned styles, inserted at activation and removed at teardown. */
    const CSS = `
.${CSS_PREFIX}__item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 34px;
  padding: 6px 8px;
  border: none;
  border-radius: var(--dsw-radius-md, 6px);
  background: transparent;
  cursor: pointer;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
  text-align: left;
  font-family: inherit;
}
.${CSS_PREFIX}__item:hover {
  background: var(--dsw-alias-interactive-bg-hover-danger);
}
.${CSS_PREFIX}__item:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover-danger);
  outline: none;
}
.${CSS_PREFIX}__itemIcon {
  display: inline-flex;
  flex: none;
  width: 14px;
  height: 14px;
  align-items: center;
  justify-content: center;
  color: var(--dsw-alias-state-error-primary);
}
.${CSS_PREFIX}__itemLabel {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.${CSS_PREFIX}__modalRoot {
  pointer-events: auto;
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: max(24px, var(--dsh-frame-overlay-top, 24px)) 24px;
}
.${CSS_PREFIX}__modalMask {
  position: absolute;
  inset: var(--dsh-frame-chrome-top, 0px) 0 0;
  backdrop-filter: var(--dsw-mask-blur);
  background: var(--dsw-alias-bg-mask-1);
}
.${CSS_PREFIX}__modalDialog {
  box-sizing: border-box;
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: min(380px, 100%);
  padding: 0 0 24px;
  overflow: hidden;
  border: 0;
  border-radius: var(--dsw-radius-panel, 12px);
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-elevation-prominent);
  animation: ${CSS_PREFIX}Enter var(--ds-transition-duration, 0.16s) var(--ds-ease-in-out, ease);
}
@keyframes ${CSS_PREFIX}Enter { from { opacity: 0; } to { opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .${CSS_PREFIX}__modalDialog { animation: none; }
}
.${CSS_PREFIX}__modalHeader {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 22px 14px 12px 24px;
}
.${CSS_PREFIX}__modalTitle {
  margin: 0;
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.${CSS_PREFIX}__modalClose {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: none;
  border-radius: var(--dsw-radius-sm, 4px);
  background: transparent;
  cursor: pointer;
  color: var(--dsw-alias-label-secondary);
}
.${CSS_PREFIX}__modalClose:hover { background: var(--dsw-alias-interactive-bg-hover); }
.${CSS_PREFIX}__modalClose:disabled { opacity: 0.4; cursor: not-allowed; }
.${CSS_PREFIX}__modalDesc {
  margin: 0;
  padding: 0 24px;
  font-size: 14px;
  line-height: 22px;
  font-weight: 400;
  color: var(--dsw-alias-label-primary);
}
.${CSS_PREFIX}__modalBody {
  display: flex;
  flex-direction: column;
  min-width: 0;
  margin-top: 4px;
  padding: 0 24px;
}
.${CSS_PREFIX}__status {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.${CSS_PREFIX}__error {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-state-error-primary);
}
.${CSS_PREFIX}__modalFooter {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 24px;
}
.${CSS_PREFIX}__btn {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  height: 36px;
  border-radius: var(--dsw-radius-md, 6px);
  cursor: pointer;
  font-size: 14px;
  line-height: 22px;
  padding: 0 14px;
  font-family: inherit;
}
.${CSS_PREFIX}__btn:disabled { cursor: not-allowed; opacity: 0.4; }
.${CSS_PREFIX}__btnOutline {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}
.${CSS_PREFIX}__btnOutline:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.${CSS_PREFIX}__btnDanger {
  background: var(--dsw-alias-state-error-primary, #e5484d);
  color: #fff;
}
.${CSS_PREFIX}__btnDanger:hover:not(:disabled) { filter: brightness(1.06); }
.${CSS_PREFIX}__forceLabel {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
  cursor: pointer;
  user-select: none;
}
.${CSS_PREFIX}__forceLabel input[type="checkbox"] {
  width: 14px;
  height: 14px;
  accent-color: var(--dsw-alias-state-error-primary);
  cursor: pointer;
}
.${CSS_PREFIX}__forceLabel input[type="checkbox"]:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.${CSS_PREFIX}__forceLabelText {
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
`;

    let seq = 0;

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        requestStore = createStore(null);
        seq = 0;
        localeService = ctx.locale;

        // Also register the dictionaries into the DSH locale registry so the
        // `locale: NS` on the menu registration resolves against them — the
        // same two-step better-sidebar uses (registry for external callers,
        // the self-managed t() above for this plugin's own components).
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh), `${NS}: zh dictionary`);
        ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en), `${NS}: en dictionary`);

        // Styles: one owned <style> element, tagged for the loader's style
        // accounting and removed with the client run (the same pattern the
        // shipped desktop plugin uses; `styles` is NOT a platform seed word,
        // so it cannot be required).
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {};
          const style = document.createElement('style');
          style.id = `${CSS_PREFIX}__styles`;
          style.dataset.plugin = NS;
          style.textContent = CSS;
          document.head.appendChild(style);
          return () => { style.remove(); };
        }, `${NS}: styles`);

        // Escape closes the open dialog unless a delete is in flight — the
        // overlay marks the pending request busy in the store, and the close
        // path (mask, button, Escape) all honor it.
        keyListener = (event) => {
          if (event.key !== 'Escape') return;
          const request = requestStore.getSnapshot();
          if (request === null || request.busy === true) return;
          requestStore.set(null);
        };
        window.addEventListener('keydown', keyListener);
        ctx.effect(() => () => {
          window.removeEventListener('keydown', keyListener);
          keyListener = null;
        }, `${NS}: escape handler`);

        // The destructive menu row, ordered after archive (400) and before
        // the copy-id utility (450).
        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-delete',
          order: 420,
          locale: NS,
          inject: () => ({
            requestSessionDelete: (sessionId, displayTitle) => {
              requestStore.set({ sessionId, displayTitle, seq: ++seq });
            },
          }),
        }, DeleteSessionMenuItem));

        // The confirmation dialog over the whole frame. `layout` and
        // `uiWorkspace` ride in as the entry's business share so a force
        // delete can drive the native tab-close (clearMain: release the
        // mainView retain then selectPanel(null)) without any user concept.
        // ctx.get is the sanctioned lookup: it yields undefined (graceful
        // degrade) instead of throwing when a profile lacks the service.
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-confirm',
          order: 30,
          inject: () => ({ layout: ctx.get('layout'), uiWorkspace: ctx.get('uiWorkspace') }),
        }, DeleteSessionOverlay));
      },
    };
  },
});
