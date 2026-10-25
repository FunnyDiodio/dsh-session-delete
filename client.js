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
  id: 'dsh-session-delete',
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
        'delete.forceLabel': '强制删除（先停止该会话的所有后台工作）',
        'delete.action': '删除',
        'delete.pending': '正在删除会话…',
        'delete.errorActivity': '该会话仍有正在进行的工作，请勾选强制删除后重试，或先停止这些工作。',
        'delete.errorLive': '这个会话的标签页还开着，关掉它就能删除。',
        'delete.errorRunning': '该会话正在生成回复；可先点右上角停止，或关闭标签页后再删除。',
        'delete.errorPending': '该会话还有未落盘的内容，请先关闭它的标签页或稍后再试。',
        'delete.closeTab': '去关闭标签页',
        'delete.closeTabHint': '（将切回空白页；其他标签页里的该会话请手动关闭）',
        'delete.errorDisk': '会话记录文件删除失败，注册表未被修改，请稍后重试。',
        'delete.errorNotFound': '未找到该会话的记录，可能已被删除。',
        cancel: '取消',
        close: '关闭',
      },
      en: {
        'menu.delete': 'Delete session',
        'delete.title': 'Delete this session?',
        'delete.desc': '"{title}"\'s conversation log will be permanently deleted and cannot be recovered (files it created in the workspace are kept). Before deleting, have the session save important conclusions to a file, or export its log.',
        'delete.forceLabel': 'Force delete (stop all background work first)',
        'delete.action': 'Delete',
        'delete.pending': 'Deleting session…',
        'delete.errorActivity': 'This session still has background work. Check Force delete to stop it, or stop the work first.',
        'delete.errorLive': 'This session tab is still open. Close it and the delete will work.',
        'delete.errorRunning': 'This session is generating a reply. Stop it (top-right) or close its tab first.',
        'delete.errorPending': 'This session still has unmaterialized content. Close its tab or retry shortly.',
        'delete.closeTab': 'Close its tab',
        'delete.closeTabHint': '(switches to a blank view; close any other tabs holding this session manually)',
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

    /**
     * Close the main conversation view (the same public layout action the
     * client performs when a tab closes) — the only clean exit for a live
     * session: releasing it natively drops the row from the desktop sidebar
     * and pushes session/disposed to the phone bridge. Only offered when the
     * row is actually retained by this page's main view (checked via the
     * standard useSessions hook the slot renderer injects).
     */
    /** Same-origin POST to this package's host route. */
    async function callDelete(sessionId, force) {
      const response = await fetch(ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, force: force === true }),
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
      // The refusal said "close the tab first": surface the one-click exit.
      const [needsTab, setNeedsTab] = React.useState(false);
      // Standard sessions hook the shell injects into every slot entry: does
      // THIS page's main view hold the session open right now?
      const openHere = props.useSessions
        ? props.useSessions((s) => (request === null ? false : (s.byId[request.sessionId]?.retainedBy?.mainView ?? 0) > 0))
        : false;

      // Reset the transient dialog state whenever a new request arrives.
      React.useEffect(() => {
        setDeleting(false);
        setError(null);
        setForce(false);
        setNeedsTab(false);
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

      const confirm = () => {
        if (deleting) return;
        setDeleting(true);
        setError(null);
        callDelete(request.sessionId, force)
          .then(() => {
            requestStore.set(null);
          })
          .catch((reason) => {
            setDeleting(false);
            const code = reason?.code;
            if (code === 'open-tab' || code === 'live-session') { setError(t('delete.errorLive')); setNeedsTab(true); }
            else if (code === 'live-running') { setError(t('delete.errorRunning')); setNeedsTab(true); }
            else if (code === 'activity') { setError(t('delete.errorActivity')); setNeedsTab(false); }
            else if (code === 'pending-session') { setError(t('delete.errorPending')); setNeedsTab(false); }
            else if (code === 'disk-remove-failed' || code === 'catalog-unavailable') { setError(t('delete.errorDisk')); setNeedsTab(false); }
            else if (code === 'not-found') { setError(t('delete.errorNotFound')); setNeedsTab(false); }
            else { setError(reason instanceof Error ? reason.message : String(reason)); setNeedsTab(false); }
          });
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
            // One-click exit for the "tab is open" refusal: closing the main
            // view releases the session natively (agent teardown, handle
            // close, session/disposed → desktop row and phone list both drop).
            !deleting && needsTab && openHere && h('div', { className: `${CSS_PREFIX}__tabRow` },
              h('button', {
                type: 'button',
                className: `${CSS_PREFIX}__btn ${CSS_PREFIX}__btnOutline ${CSS_PREFIX}__btnSm`,
                onClick: () => { props.layout?.selectPanel?.(null); },
              }, t('delete.closeTab')),
              h('span', { className: `${CSS_PREFIX}__tabHint` }, t('delete.closeTabHint')),
            ),
            // The force checkbox stays visible beside any refusal (notably
            // background work): the refusal IS the moment force helps, so
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
.${CSS_PREFIX}__tabRow {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.${CSS_PREFIX}__btnSm {
  height: 28px;
  font-size: 12px;
  line-height: 18px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm, 4px);
}
.${CSS_PREFIX}__tabHint {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
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

        // The confirmation dialog over the whole frame. `layout` rides in as
        // the entry's business share so the refusal path can offer the
        // one-click tab release (selectPanel(null) = close the main view).
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-delete-confirm',
          order: 30,
          inject: () => ({ layout: ctx.get('layout') }),
        }, DeleteSessionOverlay));
      },
    };
  },
});
