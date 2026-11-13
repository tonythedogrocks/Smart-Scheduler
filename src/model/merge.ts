import type { State } from './types';

const COLS = ['prior', 'skills', 'achDefs', 'objectives', 'missions', 'events', 'logs', 'flares', 'doing', 'measures'] as const;
type Rec = { id: string; t?: number };
const bare = (r: any) => JSON.stringify({ ...r, t: undefined });

/** Mark what a local change touched, so sync can merge record by record. */
export function stamp(prev: State, next: State, t: number) {
  for (const c of COLS) {
    const old = new Map(((prev[c] || []) as Rec[]).map((r) => [r.id, bare(r)]));
    const ids = new Set<string>();
    for (const r of (next[c] || []) as Rec[]) { ids.add(r.id); if (old.get(r.id) !== bare(r)) r.t = t; }
    for (const id of old.keys()) if (!ids.has(id)) (next.deleted ||= {})[id] = t;
  }
  // days are stamped field by field, so a device only ever overrides what it actually changed
  for (const [k, d] of Object.entries(next.days || {})) {
    const p = prev.days?.[k];
    if (p && bare(p) === bare(d)) continue;
    const ft: Record<string, number> = { ...(p?.ft || d.ft || {}) };
    for (const f of new Set([...Object.keys(p || {}), ...Object.keys(d)])) {
      if (f === 't' || f === 'ft') continue;
      if (JSON.stringify((p as any)?.[f]) !== JSON.stringify((d as any)[f])) ft[f] = t;
    }
    d.ft = ft; d.t = t;
  }
  if (JSON.stringify(prev.settings) !== JSON.stringify(next.settings)) next.settingsT = t;
  if (JSON.stringify(prev.running) !== JSON.stringify(next.running)) next.runningT = t;
}

/** Merge two copies of the data. Newest change wins per record; nothing either side added is lost. */
export function merge(a: State, b: State): State {
  const out: State = structuredClone(a);
  const deleted: Record<string, number> = { ...(b.deleted || {}) };
  for (const [id, t] of Object.entries(a.deleted || {})) deleted[id] = Math.max(t, deleted[id] || 0);
  for (const c of COLS) {
    const m = new Map<string, Rec>();
    const order: string[] = [];
    // either copy may come from an older version of the app that lacks a collection
    for (const r of [...((a[c] || []) as Rec[]), ...((b[c] || []) as Rec[])]) {
      const cur = m.get(r.id);
      if (!cur) { m.set(r.id, r); order.push(r.id); } else if ((r.t || 0) > (cur.t || 0)) m.set(r.id, r);
    }
    (out as any)[c] = order.map((id) => m.get(id)!).filter((r) => !(deleted[r.id] && deleted[r.id] >= (r.t || 0))).map((r) => structuredClone(r));
  }
  out.logs.sort((x, y) => x.start - y.start);
  out.measures.sort((x, y) => x.date.localeCompare(y.date));
  out.days ||= {};
  for (const [k, d] of Object.entries(b.days || {})) {
    const x = out.days[k];
    if (!x) { out.days[k] = structuredClone(d); continue; }
    // field by field: for each field keep the side that changed it last (older copies fall back to the record's time)
    const m: any = {}, ft: Record<string, number> = {};
    for (const f of new Set([...Object.keys(x), ...Object.keys(d)])) {
      if (f === 't' || f === 'ft') continue;
      // a copy that tracks fields but never touched this one is the oldest word on it; untracked (older) copies use the record's time
      const ta = x.ft ? x.ft[f] ?? 0 : x.t ?? 0, tb = d.ft ? d.ft[f] ?? 0 : d.t ?? 0;
      const src: any = tb > ta ? d : x;
      if (f === 'misses') { // each device only ever adds misses: keep every one either side saw
        const all = [...((x as any).misses || []), ...((d as any).misses || [])];
        m[f] = all.filter((v, i) => all.findIndex((w) => w.m === v.m && w.at === v.at) === i).sort((p, q) => p.at - q.at).slice(-40);
      } else if (src[f] !== undefined) m[f] = structuredClone(src[f]);
      ft[f] = Math.max(ta, tb);
    }
    m.ft = ft; m.t = Math.max(x.t || 0, d.t || 0);
    out.days[k] = m;
  }
  if ((b.settingsT || 0) > (a.settingsT || 0)) { out.settings = structuredClone(b.settings); out.settingsT = b.settingsT; }
  if ((b.runningT || 0) > (a.runningT || 0)) { out.running = b.running ? { ...b.running } : undefined; out.runningT = b.runningT; }
  for (const key of ['achievements', 'claimed'] as const) {
    const m: Record<string, string> = { ...(a[key] || {}) };
    for (const [id, d] of Object.entries(b[key] || {})) m[id] = m[id] && m[id] < d ? m[id] : d;
    out[key] = m;
  }
  out.deleted = deleted;
  out.updatedAt = Math.max(a.updatedAt, b.updatedAt);
  return out;
}

const canon = (v: any): any => {
  if (Array.isArray(v)) {
    const xs = v.map(canon);
    return xs.every((x) => x && typeof x === 'object' && 'id' in x) ? xs.sort((x, y) => String(x.id).localeCompare(String(y.id))) : xs;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canon(v[k])]));
  return v;
};
/** Same data, whatever order the two devices happen to hold it in? */
export const same = (a: State, b: State) => JSON.stringify(canon({ ...a, updatedAt: 0 })) === JSON.stringify(canon({ ...b, updatedAt: 0 }));
