import type { State } from './types';
import { merge, same } from './merge';
import { S, adopt, onChange } from './store';

/**
 * Sync through a private GitHub repo: one data.json, merged record by record.
 * The access token stays on this device (localStorage) and is only ever sent to api.github.com.
 */
export interface SyncCfg { repo: string; token: string }
export interface SyncStatus { state: 'off' | 'idle' | 'syncing' | 'error'; at?: number; error?: string }

const CFG = 'limit-break-sync';
const FILE = 'data.json';
let status: SyncStatus = { state: 'off' };
const subs = new Set<() => void>();
export const syncStatus = () => status;
/** Safe to act on what's here (e.g. call something missed)? Only right after a good sync, or with sync off. */
export const isFresh = () => !getCfg() || (status.state === 'idle' && !!status.at && Date.now() - status.at < 90000);
export const onSyncStatus = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
const set = (s: SyncStatus) => { status = s; subs.forEach((f) => f()); };

export function getCfg(): SyncCfg | null {
  try { const c = JSON.parse(localStorage.getItem(CFG) || 'null'); return c && c.repo && c.token ? c : null; } catch { return null; }
}
export function setCfg(c: SyncCfg | null) {
  if (c) localStorage.setItem(CFG, JSON.stringify({ repo: c.repo.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''), token: c.token.trim() }));
  else localStorage.removeItem(CFG);
  set({ state: c ? 'idle' : 'off' });
}

const enc = (s: string) => { const b = new TextEncoder().encode(s); let o = ''; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
const dec = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function api(cfg: SyncCfg, method: string, body?: unknown, raw = false) {
  return fetch(`https://api.github.com/repos/${cfg.repo}/contents/${FILE}`, {
    method, cache: 'no-store',
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

const explain = (code: number) =>
  code === 401 ? 'GitHub did not accept the token.' :
  code === 403 ? 'The token is not allowed to write to that repo.' :
  code === 404 ? 'Repo not found, or the token cannot see it.' : `GitHub answered ${code}.`;

let busy = false, again = false;
/** Pull, merge, push. Safe to call any time; calls made while one is running are folded into one more pass. */
export async function syncNow(): Promise<void> {
  const cfg = getCfg();
  if (!cfg) return;
  if (busy) { again = true; return; }
  busy = true;
  set({ ...status, state: 'syncing' });
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      const meta = await api(cfg, 'GET');
      let sha: string | undefined, remote: State | null = null;
      if (meta.ok) {
        const j = await meta.json();
        sha = j.sha;
        // files over 1 MB come back without inline content
        const text = j.content ? dec(j.content) : await (await api(cfg, 'GET', undefined, true)).text();
        const got = JSON.parse(text);
        if (got?.v === 1 && Array.isArray(got.missions)) remote = got;
      } else if (meta.status !== 404 || (await meta.clone().json().catch(() => ({}))).message !== 'Not Found') throw new Error(explain(meta.status));
      else {
        // 404 is either "no file yet" (fine) or "no such repo": check the repo itself
        const repo = await fetch(`https://api.github.com/repos/${cfg.repo}`, { headers: { Authorization: `Bearer ${cfg.token}` } });
        if (!repo.ok) throw new Error(explain(repo.status));
      }
      const local = S();
      const merged = remote ? merge(local, remote) : local;
      if (!same(merged, local)) adopt(merged);
      if (remote && same(merged, remote)) break;
      const put = await api(cfg, 'PUT', { message: 'Limit Break sync', content: enc(JSON.stringify(merged)), sha });
      if (put.ok) break;
      if (put.status !== 409 && put.status !== 422) throw new Error(explain(put.status));
      // someone else wrote in between: go round again
    }
    set({ state: 'idle', at: Date.now() });
  } catch (e: any) {
    set({ state: 'error', at: status.at, error: e?.message === 'Failed to fetch' ? 'Offline. It will sync when you are back.' : e?.message || 'Sync failed.' });
  } finally {
    busy = false;
    if (again) { again = false; syncNow(); }
  }
}

let timer: any;
export function startSync() {
  set({ state: getCfg() ? 'idle' : 'off' });
  onChange(() => { clearTimeout(timer); timer = setTimeout(syncNow, 2500); });
  // coming back to the app: what's here may be old until the next pull
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { set({ ...status, at: 0 }); syncNow(); } else if (timer) { clearTimeout(timer); syncNow(); } });
  // while open, pull every minute so another device's changes show up (and this one never acts on old data)
  setInterval(() => { if (document.visibilityState === 'visible') syncNow(); }, 60000);
  window.addEventListener('online', () => syncNow());
  syncNow();
}
