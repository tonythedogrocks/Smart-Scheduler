import { get, set } from 'idb-keyval';
import type { State, Level, Evt, Mission, Objective, Log, PlanSnap } from './types';
import { seed, withDefaults } from './seed';
import { dateOf, nowTs, uid } from './time';
import { describeUnits, excusedHabits, habitsDue, nextLabels, GRACE } from './planner';
import { factor } from './learn';
import { unlock } from './game';
import { stamp } from './merge';

export interface Nav { view: 'shelf' | 'col' | 'toc' | 'page' | 'panel' | 'debrief' | 'settings' | 'achievements'; c: string; i: string; ch: number; p: string; dir: 'in' | 'out' }
export interface Local { nav: Nav; status: boolean; sheet: null | 'flare' | 'doing' | 'add' | 'mission'; sheetArg?: string; toast?: { text: string; id: number }; lastFlare?: string }

const KEY = 'limit-break-v1', NAVKEY = 'limit-break-nav';
let state: State = seed();
let local: Local = { nav: { view: 'shelf', c: 'week', i: '', ch: 0, p: '', dir: 'in' }, status: false, sheet: null };
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
export const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const S = () => state;
export const L = () => local;

let saveT: any;
function persist() {
  clearTimeout(saveT);
  // no browser storage (e.g. tests): skip quietly
  saveT = setTimeout(() => { try { if (typeof indexedDB !== 'undefined') set(KEY, state).catch(() => {}); } catch { /* ignore */ } }, 50);
}
export function mutate(fn: (s: State) => void) {
  const next: State = structuredClone(state);
  fn(next);
  next.updatedAt = Date.now();
  stamp(state, next, next.updatedAt);
  state = next;
  persist();
  emit();
  changed.forEach((f) => f());
}
const changed = new Set<() => void>();
/** Called after every local change (used by sync). */
export const onChange = (f: () => void) => { changed.add(f); };
/** Replace state with a merged copy from sync, without re-stamping. */
export function adopt(next: State) { state = withDefaults(next); persist(); emit(); }
export function setLocal(patch: Partial<Local>) {
  local = { ...local, ...patch };
  try { localStorage.setItem(NAVKEY, JSON.stringify(local.nav)); } catch {}
  emit();
}
export const go = (patch: Partial<Nav>) => setLocal({ nav: { ...local.nav, dir: 'in', ...patch } });
export const toast = (text: string) => setLocal({ toast: { text, id: Date.now() } });

export async function load() {
  try { const got = await get(KEY); if (got && got.v === 1) state = withDefaults(got); } catch {}
  try { const n = localStorage.getItem(NAVKEY); if (n) local.nav = { ...local.nav, ...JSON.parse(n) }; } catch {}
  try { (navigator as any).storage?.persist?.(); } catch {}
  emit();
}

const today = () => dateOf(nowTs());

function afterChange(s: State, date: string) {
  const d = (s.days[date] ||= {});
  if (d.level && !d.floorAwarded) {
    const due = habitsDue(s, date, d.level).filter((m) => !m.notFloor);
    // a routine the app's own rules kept out today (e.g. a meal gap) doesn't count against the floor
    const excused = date === today() ? excusedHabits(s, nowTs()) : new Set<string>();
    const ok = due.every((m) => excused.has(m.id) || s.logs.some((l) => l.missionId === m.id && l.date === date && l.done));
    if (ok && (due.length > 0 || d.level === 1)) d.floorAwarded = true;
  }
  return unlock(s, date);
}

export const actions = {
  setLevel(level: Level) {
    mutate((s) => { const d = (s.days[today()] ||= {}); d.level = level; /* first report of the day = start of the day */ if (!d.setAt || dateOf(d.setAt) !== today()) d.setAt = nowTs(); });
    setLocal({ status: false });
  },
  start(missionId: string, units: number, plannedMin: number, step?: number, key?: string) {
    mutate((s) => {
      if (s.running) return;
      s.running = { missionId, units, plannedMin, startedAt: nowTs(), ...(step !== undefined ? { step } : {}) };
      // the planned block this replaces leaves today's fixed plan; everything else stays put
      const pl = s.days[today()]?.plan;
      if (pl) { const i = pl.items.findIndex((x) => (key ? x.key === key : x.missionId === missionId)); if (i >= 0) pl.items.splice(i, 1); }
    });
  },
  /** done=false: stop here. Time still counts; the work quietly goes back to the pool. */
  /** Tick off steps of the running block in order (count = how many units are done so far). */
  tick(count: number) { mutate((s) => { if (s.running) s.running.ticked = Math.max(0, Math.min(s.running.units, count)); }); },
  finish(done: boolean) {
    let got: string[] = [], floor = false;
    mutate((s) => {
      const r = s.running; if (!r) return;
      const date = today(), end = nowTs();
      const m0 = s.missions.find((x) => x.id === r.missionId);
      // "Continue later" is a pause: credit what was done, and keep what's left in today's plan
      // starting where he paused (rounded down to 5 min). The usual 5-minute window then applies.
      if (!done) {
        const nm = new Date(end).getHours() * 60 + new Date(end).getMinutes();
        const elapsed = Math.floor((end - r.startedAt) / 60000 / 5) * 5;
        const f0 = factor(s, r.missionId);
        const unit = m0 && m0.kind === 'work' ? m0.minutes * f0 : 0;
        const credited = m0?.kind === 'work' ? (m0.labels?.length ? Math.min(r.units, r.ticked || 0) : Math.min(r.units, Math.floor(elapsed / unit))) : 0;
        const restUnits = m0?.kind === 'work' ? r.units - credited : 1;
        const restMin = m0?.kind === 'work' ? Math.round(restUnits * unit) : Math.max(0, Math.round(r.plannedMin * f0) - elapsed);
        if (elapsed >= 5 || credited > 0) {
          s.logs.push({ id: uid(), missionId: r.missionId, date, start: r.startedAt, end, plannedMin: r.plannedMin, units: credited, done: false, level: s.days[date]?.level, xp: Math.round(Math.min((end - r.startedAt) / 60000, Math.max(r.plannedMin * 2, 10))), ...(r.step !== undefined ? { step: r.step } : {}) });
          if (credited > 0 && m0?.kind === 'work') { m0.unitsLeft = Math.max(0, (m0.unitsLeft || 0) - credited); if (m0.unitsLeft === 0) m0.doneAt = date; }
        }
        s.running = undefined;
        const pl = s.days[date]?.plan;
        if (pl && m0 && restMin >= 5 && restUnits > 0) {
          const start = Math.floor(nm / 5) * 5;
          const named = m0.kind === 'work' && m0.labels?.length ? describeUnits(nextLabels(m0, restUnits)) : '';
          pl.items.push({ key: `m:${m0.id}:p${end % 100000}`, missionId: m0.id, start, end: start + restMin, title: m0.title, sub: `${named ? named + ' · ' : ''}${restMin} min left`, detail: m0.note, units: restUnits, baseMin: m0.kind === 'work' ? restUnits * m0.minutes : r.plannedMin, min: restMin, ...(r.step !== undefined ? { step: r.step } : {}) });
          pl.items.sort((a, b) => a.start - b.start);
        }
        afterChange(s, date);
        return;
      }
      // stopping partway still counts the steps ticked off; the rest goes back to the pool
      const doneUnits = done ? r.units : Math.min(r.units, r.ticked || 0);
      const log: Log = { id: uid(), missionId: r.missionId, date, start: r.startedAt, end, plannedMin: r.plannedMin, units: doneUnits, done, level: s.days[date]?.level, xp: Math.round(Math.min((end - r.startedAt) / 60000, Math.max(r.plannedMin * 2, 10))), ...(r.step !== undefined ? { step: r.step } : {}) };
      s.logs.push(log);
      s.running = undefined;
      // ran past the start of what was next: re-plan the rest (not a miss, he was working)
      const pl = s.days[date]?.plan, nm = new Date(end).getHours() * 60 + new Date(end).getMinutes();
      if (pl && pl.items.some((x) => x.start + GRACE <= nm)) delete s.days[date].plan;
      const m = s.missions.find((x) => x.id === r.missionId);
      if (doneUnits > 0 && m?.kind === 'work') {
        m.unitsLeft = Math.max(0, (m.unitsLeft || 0) - doneUnits);
        if (m.unitsLeft === 0) m.doneAt = date;
      }

      const before = !!s.days[date]?.floorAwarded;
      got = afterChange(s, date);
      floor = !before && !!s.days[date]?.floorAwarded;
    });
    if (got.length) toast('Achievement unlocked!'); else if (floor) toast("Today's floor is hit. Full mission success!");
  },
  cancelRun() { mutate((s) => { s.running = undefined; }); },
  flare() {
    const id = uid();
    mutate((s) => { s.flares.push({ id, ts: nowTs() }); });
    setLocal({ sheet: 'flare', lastFlare: id });
  },
  rateFlare(id: string, rating: number) { mutate((s) => { const f = s.flares.find((x) => x.id === id); if (f) f.rating = rating; }); },
  undoFlare(id: string) { mutate((s) => { s.flares = s.flares.filter((x) => x.id !== id); }); },
  doing(what: string) { mutate((s) => { s.doing.push({ id: uid(), ts: nowTs(), what }); }); toast(`Logged: ${what}`); },
  addEvent(e: Omit<Evt, 'id'>) { mutate((s) => { s.events.push({ ...e, id: uid() }); }); },
  updateEvent(id: string, patch: Partial<Evt>) { mutate((s) => { const e = s.events.find((x) => x.id === id); if (e) { if (patch.start !== undefined) patch.end = patch.start + (e.end - e.start); Object.assign(e, patch); } }); },
  removeEvent(id: string, date?: string) {
    mutate((s) => {
      const e = s.events.find((x) => x.id === id); if (!e) return;
      if (e.date || !date) s.events = s.events.filter((x) => x.id !== id);
      else (e.skip ||= []).push(date);
    });
  },
  /** Confirm when a meal was actually eaten (minutes from midnight; default now), or clear it. */
  ate(meal: 'lunch' | 'dinner', at?: number | null, big?: boolean) {
    const t = nowTs(), mins = at ?? new Date(t).getHours() * 60 + new Date(t).getMinutes();
    mutate((s) => {
      const d = (s.days[today()] ||= {}); const cur = { ...(d.ate || {}) };
      if (at === null) delete cur[meal]; else cur[meal] = { at: mins, ...(big ?? cur[meal]?.big ? { big: true } : {}) };
      if (at !== null && big === false) delete cur[meal]!.big;
      d.ate = cur;
      if (meal === 'dinner' && at !== null) d.dinnerTap = mins;
    });
  },
  /** Re-check today's floor (a routine can become excused later, e.g. after a meal); only writes if it's newly met. */
  checkFloor() {
    const d = S().days[today()];
    if (!d?.level || d.floorAwarded) return;
    const probe = structuredClone(S());
    afterChange(probe, today());
    if (probe.days[today()]?.floorAwarded) { let got: string[] = []; mutate((s) => { got = afterChange(s, today()); }); toast(got.length ? 'Achievement unlocked!' : "Today's floor is hit. Full mission success!"); }
  },
  /** Fix today's plan once the day has started (or after a change rebuilt it). */
  savePlan(sig: string, items: PlanSnap[]) {
    mutate((s) => { const d = (s.days[today()] ||= {}); d.plan = { sig, items }; });
  },
  /** A planned block passed without being started: log it as missed (feeds the energy model), then the day re-plans. */
  recordMiss(missionId: string, at: number) {
    const d0 = S().days[today()];
    if ((d0?.misses || []).some((x) => x.m === missionId && Math.floor(x.at / 30) === Math.floor(at / 30))) return;
    mutate((s) => { const d = (s.days[today()] ||= {}); d.misses = [...(d.misses || []), { m: missionId, at }].slice(-40); });
  },
  /** Dinner's called: dinner starts now, and the time teaches the usual dinner time. */
  dinnerNow() {
    const t = nowTs(), mins = new Date(t).getHours() * 60 + new Date(t).getMinutes();
    mutate((s) => { const d = (s.days[today()] ||= {}); d.dinnerAt = mins; d.dinnerTap = mins; d.ate = { ...(d.ate || {}), dinner: { at: mins } }; if (d.cook && !d.cookEnd) { d.cookEnd = t; d.cookStart ??= t - 1; } });
    toast('Dinner time. Enjoy it.');
  },
  /** Make a week's rest day a backup work day, or turn that back off. */
  toggleBackup(weekMonday: string) {
    mutate((s) => { const w = new Set(s.settings.backupWeeks || []); if (w.has(weekMonday)) w.delete(weekMonday); else w.add(weekMonday); s.settings.backupWeeks = [...w].sort().slice(-8); });
  },
  setDay(date: string, patch: Partial<State['days'][string]>) { mutate((s) => { s.days[date] = { ...(s.days[date] || {}), ...patch }; }); },
  setSettings(patch: Partial<State['settings']>) { mutate((s) => { s.settings = { ...s.settings, ...patch }; }); },
  addObjective(o: Omit<Objective, 'id'>) { const id = uid(); mutate((s) => { s.objectives.push({ ...o, id }); }); return id; },
  completeObjective(id: string, done: boolean) {
    let got: string[] = [];
    mutate((s) => { const o = s.objectives.find((x) => x.id === id); if (!o) return; o.done = done; o.doneAt = done ? today() : undefined; got = unlock(s, today()); });
    if (got.length) toast('Achievement unlocked!');
  },
  saveMission(m: Mission) { mutate((s) => { const i = s.missions.findIndex((x) => x.id === m.id); if (i >= 0) s.missions[i] = m; else s.missions.push(m); }); },
  addMeasure(weight: number, neck: number, navel: number) {
    let got: string[] = [];
    mutate((s) => {
      const date = today(), t = nowTs();
      s.measures.push({ id: uid(), date, weight, neck, navel });
      s.logs.push({ id: uid(), missionId: 'measure', date, start: t - 600000, end: t, plannedMin: 10, units: 1, done: true, level: s.days[date]?.level, xp: 10 });
      got = afterChange(s, date);
    });
    if (got.length) toast('Achievement unlocked!');
  },
  claim(id: string) { mutate((s) => { if (!s.achievements[id]) { s.achievements[id] = today(); (s.claimed ||= {})[id] = today(); } }); toast('Achievement unlocked!'); },
  importState(json: string) { const got = JSON.parse(json); if (got?.v !== 1 || !Array.isArray(got.missions)) throw new Error('Not a Limit Break backup'); state = withDefaults(got); state.updatedAt = Date.now(); persist(); emit(); },
  reset() { state = seed(); state.updatedAt = Date.now(); persist(); emit(); },
};
