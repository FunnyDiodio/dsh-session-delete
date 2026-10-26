/**
 * dsh-session-delete — Host half.
 *
 * Serves one same-origin API route the browser half calls from the sidebar
 * session "..." menu:
 *
 *   POST /session-delete/api/delete  { sessionId }
 *
 * The handler refuses live sessions, sessions with an unmaterialized write
 * handle in this process, and sessions with running work, then:
 *   1. removes the durable session log directory
 *      <DSH_HOME>/sessions/<projectKey(cwd)>/<encodeSegment(id)>/
 *      (when the header is already gone, every project directory is swept
 *      for a directory named after the encoded id),
 *   2. removes the projection cache entry
 *      <DSH_HOME>/storages/session_projcache/sessions/<id>.json,
 *   3. evicts the id from the registry's in-memory header/path index,
 *   4. drops archived/pinned bookkeeping and detaches the id from every
 *      workspace that still accounts it (durable registry writes),
 *   5. emits `api-session/removed` so every connected client drops the
 *      sidebar row without a restart.
 *
 * Disk removal runs BEFORE the registry mutations on purpose: the detach
 * write triggers client-side refreshes, and those refreshes must already see
 * a clean header index, or the deleted session re-appears under "Ungrouped".
 *
 * Every request passes the connection trust fence (loopback + same-origin
 * markers), the same guard the shipped workspace routes use.
 */
import { readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const NS = 'session-delete';

/** The route this plugin owns, under the shared web server. */
const ROUTE_PATH = '/session-delete/api/delete';

/** Byte cap for an in-flight request body; matches other host routes. */
const BODY_MAX_BYTES = 64 * 1024;

/** Resolve the DSH home exactly like the shipped host plugins do. */
function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** Encode one path segment the way dsh-session-persistence-jsonl does. */
function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment');
  if (raw === '.') return '~002E';
  if (raw === '..') return '~002E~002E';
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
  }
  return out;
}

/** Build the readable project directory key (mirrors projectKey in the jsonl backend). */
function projectKey(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) throw new Error('cannot encode an empty project path');
  let readable = '';
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

/** The durable log directory of one session, as the jsonl backend lays it out. */
function sessionLogDir(cwd, sessionId) {
  return join(dshHome(), 'sessions', projectKey(cwd), encodeSegment(sessionId));
}

/** Root holding one `<session-id>.json` projection-cache file per session. */
function projectionCacheFile(sessionId) {
  return join(dshHome(), 'storages', 'session_projcache', 'sessions', `${sessionId}.json`);
}

/** Read and parse one bounded JSON request body. */
async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > BODY_MAX_BYTES) throw new Error('request body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}

/**
 * Stop any running work for the session by dispatching the same parallel
 * event the archive path uses with stopActivity: true. This is best-effort:
 * failures are logged but do not block the delete.
 */
async function stopSessionActivity(ctx, sessionId) {
  try {
    await ctx.parallel('workspace/session-stop', { sessionId });
  } catch (error) {
    ctx.logger?.warn?.(`[${NS}] workspace/session-stop for '${sessionId}' failed: ${String(error)}`);
  }
}

/** Reject every request shape but { sessionId: string }. */
function assertPayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('expected { sessionId }');
  }
  const { sessionId } = body;
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('expected { sessionId }');
  }
  if (/[\\/]|\0/.test(sessionId)) {
    throw new Error('sessionId contains path separators');
  }
  return sessionId;
}

/**
 * Whether the session is live in this process. A live session owns an agent
 * and (usually) an open persistence write handle, so its log must not be
 * removed from under it; the user closes its tab or archives it first.
 *
 * Fails CLOSED: when the `sessions` service cannot be resolved the route
 * reports a server error instead of proceeding — silently skipping this
 * guard is what leaves a torn-out live session as an "Ungrouped" ghost row.
 */
function isLiveSession(ctx, sessionId) {
  const sessions = ctx.get('sessions');
  if (sessions === undefined || typeof sessions.get !== 'function') {
    throw new Error('session catalog is unavailable; refusing to delete blind');
  }
  return sessions.get(sessionId) !== undefined;
}

/**
 * Force-release a live session, logging every step so a failure is readable
 * from the host log alone (no guessing rounds). The primary path is the
 * caller's client driving the native tab-close (uiWorkspace archive →
 * clearMain); the client reports what it did via `diag`. Secondary: an
 * Agent object's own public `dispose`, capped at 2.5s so a hang cannot eat
 * the settle window. NEVER probe `agent.ctx.<anything>` — the Cordis context
 * proxy throws `cannot get property "x" without inject` even under typeof.
 * @returns true once the session is out of the live catalog.
 */
async function releaseLiveSession(ctx, sessionId, diag) {
  const steps = [];
  let agent;
  try {
    agent = ctx.get('agents')?.get(sessionId);
  } catch (error) {
    steps.push(`agent lookup threw: ${String(error?.message ?? error)}`);
  }
  steps.push(`agent=${agent === void 0 ? 'absent' : 'present'}`);
  if (agent !== void 0 && typeof agent.dispose === 'function') {
    const inflight = Promise.resolve().then(() => agent.dispose());
    inflight.catch(() => { /* a late rejection after the cap is not a crash */ });
    try {
      await Promise.race([
        inflight,
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout 2500ms')), 2500)),
      ]);
      steps.push('dispose ok');
    } catch (error) {
      steps.push(`dispose ${String(error?.message ?? error)}`);
    }
  } else if (agent !== void 0) {
    steps.push('agent has no dispose()');
  }
  // Store removal rides the disposal/un-retain listener chain (local emit or
  // a loopback remote call); give it a bounded settle window before declaring.
  let stillLive = true;
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!isLiveSession(ctx, sessionId)) { stillLive = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  let liveIds = '';
  let catalogError = '';
  try {
    const sessions = ctx.get('sessions');
    liveIds = (sessions?.list?.() ?? []).map((s) => String(s.id).slice(-6)).join(',');
  } catch (error) {
    catalogError = String(error?.message ?? error);
  }
  ctx.logger?.info?.(
    `[${NS}] release '${sessionId}': clientDiag=${diag ?? '-'} | ${steps.join('; ')} | stillLive=${stillLive}`
    + ` | liveCatalog=[${liveIds}]${catalogError ? ` | catalogError=${catalogError}` : ''}`,
  );
  return !stillLive;
}

/**
 * Whether the persistence backend still tracks this session as created but
 * unmaterialized in this process. Such a session exists only in the
 * backend's pending map — a filesystem rm finds nothing, and the pending
 * entry keeps it in every persistence listing (sessionPersistence.list()
 * merges it back), so the delete must refuse until the handle closes.
 */
async function isPendingSession(ctx, sessionId) {
  try {
    const snapshot = await ctx.sessionPersistence.stat(sessionId);
    return snapshot !== undefined && String(snapshot.revision).startsWith('memory:');
  } catch (error) {
    // A failing stat is not evidence of pending state; the live guard above
    // already covers open sessions, and the disk sweep below is idempotent.
    ctx.logger?.warn?.(`[${NS}] persistence stat for '${sessionId}' failed: ${String(error)}`);
    return false;
  }
}

/**
 * Whether any provider still reports running work for the session (the same
 * waterfall the archive path consults before offering "stop and archive").
 */
async function sessionActivity(ctx, sessionId) {
  try {
    return await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
  } catch {
    // A failing provider is not evidence of activity; the archive path treats
    // a throwing dispatcher the same way and continues.
    return [];
  }
}

/**
 * Remove one path; ENOENT counts as success (idempotent delete).
 * @returns 'removed' | 'missing' | throws on any other failure.
 */
async function removePath(path) {
  try {
    await stat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  await rm(path, { recursive: true, force: true });
  return 'removed';
}

/**
 * Without a header the cwd is unknown, so sweep every project directory for
 * the session's encoded directory name. This reclaims logs whose header was
 * already lost (ghost rows re-deleted through the menu) without touching
 * anything else: only the exact `<encodeSegment(id)>` name is removed.
 */
async function sweepSessionDirs(sessionId) {
  const target = encodeSegment(sessionId);
  const root = join(dshHome(), 'sessions');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
  let outcome = 'missing';
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, target);
    try {
      if ((await removePath(candidate)) === 'removed') outcome = 'removed';
    } catch (error) {
      // One unreadable project directory must not stop the sweep; log and
      // keep going so an orphan under a different key is still reclaimed.
      console.warn(`[${NS}] sweep remove '${candidate}' failed: ${String(error)}`);
    }
  }
  return outcome;
}

/** Required services; the Loader activates this plugin once all exist. */
export const inject = ['webServer', 'connection', 'workspaceRegistry', 'sessionPersistence'];

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
        const send = (status, payload) => {
          const text = JSON.stringify(payload);
          res.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(text),
            'cache-control': 'no-store',
          });
          res.end(text);
        };
        // Trust fence: loopback socket + same-origin browser markers, exactly
        // like the shipped workspace routes (connection.requestRejection).
        const rejection = ctx.connection.requestRejection(req);
        if (rejection !== undefined) {
          res.writeHead(rejection);
          res.end();
          return;
        }
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'method not allowed' });
          return;
        }
        try {
          const body = await readJsonBody(req);
          const sessionId = assertPayload(body);
          const force = body.force === true;
          // The client reports what its silent-release attempt actually did
          // (service present? threw?) so the host log line explains a
          // release-failed without another guess-and-check round.
          const diag = typeof body.diag === 'string' ? body.diag.slice(0, 400) : undefined;

          // A session live in this process (its tab is open / an Agent is
          // attached) may not have its log pulled out from under the open
          // persistence handle — v1.1 did exactly that and stranded ghost
          // "Ungrouped" rows on desktop and phone alike. With force the
          // plugin now RELEASES the session through the Agent's own public
          // teardown first (same path a tab close drives; clients drop the
          // row during the release) and only then deletes; without force a
          // live session is refused.
          if (isLiveSession(ctx, sessionId)) {
            if (!force) {
              send(409, { ok: false, error: 'live-session', message: 'session is live in this process' });
              return;
            }
            if (!(await releaseLiveSession(ctx, sessionId, diag))) {
              send(409, { ok: false, error: 'release-failed', message: 'session is held open by its tab and could not be released; close the tab and retry' });
              return;
            }
          }
          if (await isPendingSession(ctx, sessionId)) {
            send(409, { ok: false, error: 'pending-session', message: 'session has an unmaterialized write handle' });
            return;
          }
          // force also stops the session's background WORK (subagents, jobs,
          // schedules) — the same event the native "stop and archive" drives.
          if (force) await stopSessionActivity(ctx, sessionId);
          const activity = await sessionActivity(ctx, sessionId);
          if (activity.length > 0) {
            send(409, { ok: false, error: 'activity', message: `session has ${activity.length} active item(s)` });
            return;
          }

          const registry = ctx.workspaceRegistry;

          // Resolve the stored header for the session's cwd. A miss means the
          // durable log was already gone (or never materialized); the sweep
          // path still reclaims an orphaned directory by id alone.
          let header;
          try {
            header = await registry.host.readSessionHeader(sessionId);
          } catch {
            header = undefined;
          }

          // 1 + 2. Remove the durable artifacts FIRST — any real failure
          // aborts before the registry is touched, so a session whose log is
          // still readable is never silently detached.
          const removed = { logDir: false, logDirMissing: false, cache: false, cacheMissing: false };
          if (header?.cwd !== undefined) {
            const dir = sessionLogDir(header.cwd, sessionId);
            try {
              removed.logDir = (await removePath(dir)) === 'removed';
              removed.logDirMissing = !removed.logDir;
            } catch (error) {
              send(500, { ok: false, error: 'disk-remove-failed', message: `cannot remove session log: ${String(error?.message ?? error)}` });
              return;
            }
          } else {
            try {
              const swept = await sweepSessionDirs(sessionId);
              removed.logDir = swept === 'removed';
              removed.logDirMissing = swept !== 'removed';
              removed.swept = true;
            } catch (error) {
              send(500, { ok: false, error: 'disk-remove-failed', message: `cannot sweep session log directories: ${String(error?.message ?? error)}` });
              return;
            }
          }
          try {
            const cacheOutcome = await removePath(projectionCacheFile(sessionId));
            removed.cache = cacheOutcome === 'removed';
            removed.cacheMissing = cacheOutcome !== 'removed';
          } catch (error) {
            // The cache is a projection; its loss is recoverable from the log.
            // The log is already gone here, so a stale entry is harmless.
            ctx.logger?.warn?.(`[${NS}] removing projection cache for '${sessionId}' failed: ${String(error)}`);
          }

          // 3. Evict the id from the registry's in-memory index. Without this
          // the cached header keeps resurrecting the session in every
          // listing until the next Host restart (observed: a deleted session
          // lingering under "Ungrouped" with its title). These are plain
          // public Map/Set fields on WorkspaceRegistry.
          let evicted = false;
          try {
            registry.headers?.delete?.(sessionId);
            registry.sessionPaths?.delete?.(sessionId);
            registry.missingSessionPaths?.delete?.(sessionId);
            registry.invalidSessionPaths?.delete?.(sessionId);
            evicted = true;
          } catch (error) {
            ctx.logger?.warn?.(`[${NS}] header-index eviction for '${sessionId}' failed: ${String(error)}`);
          }

          // 4. Durable bookkeeping: drop archived/pinned sets, then detach
          // from every workspace that still accounts the id. These domain
          // writes are what wake the clients — by now the index is clean, so
          // the refresh renders the session as gone, not ungrouped.
          try { await registry.unarchiveSession(sessionId); } catch { /* idempotent */ }
          try { await registry.unpinSession(sessionId); } catch { /* idempotent */ }
          let detached = 0;
          for (const workspace of registry.list()) {
            const raw = workspace.record?.sessionIds;
            if (Array.isArray(raw) && raw.includes(sessionId)) {
              try {
                await workspace.detachSession(sessionId);
                detached += 1;
              } catch (error) {
                ctx.logger?.warn?.(`[${NS}] detach from workspace '${workspace.id}' failed: ${String(error)}`);
              }
            }
          }

          // 5. Tell every connected client to drop its sidebar row now.
          // `api-session/removed` is the event sessionController emits when
          // an in-memory session is disposed; replaying it for a session that
          // was never disposed in this process is what makes the deletion
          // instant. Undeclared-emit failures stay non-fatal: the registry
          // writes above already trigger a clean refresh.
          let emitted = false;
          try {
            ctx.emit('api-session/removed', sessionId);
            emitted = true;
          } catch (error) {
            ctx.logger?.warn?.(`[${NS}] api-session/removed emit for '${sessionId}' failed: ${String(error)}`);
          }

          send(200, {
            ok: true,
            sessionId,
            detached,
            headerFound: header !== undefined,
            evicted,
            emitted,
            ...removed,
          });
        } catch (error) {
          const message = String(error?.message ?? error);
          const blind = message.includes('unavailable');
          send(blind ? 500 : 400, { ok: false, error: blind ? 'catalog-unavailable' : 'bad-request', message });
        }
      },
    }), `[${NS}] ${ROUTE_PATH} route`);
}
