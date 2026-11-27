import { get, set } from 'idb-keyval';
import type { State, Evt, Log, Mission, PlanSnap } from './types';
import { seed, withDefaults } from './seed';
import { dateOf, nowTs, uid } from './time';
import { describeUnits, nextGap, nextLabels, planSig, GRACE } from './planner';
import { factor } from './learn';
import { know, stamp } from './merge';

/** What's on screen: the day being viewed (empty = today), the open item, or Settings. */
export interface Nav { date: string; open: string; settings: boolean }
export interface Local { nav: Nav; toast?: { text: string; id: number } }

const KEY = 'limit-break-v1', NAVKEY = 'limit-break-nav';
let state: State = seed();
let local: Local = { nav: { date: '', open: '', settings: false } };
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
export const go = (patch: Partial<Nav>) => setLocal({ nav: { ...local.nav, ...patch } });
export const toast = (text: string) => setLocal({ toast: { text, id: Date.now() } });

export async function load() {
  try { const got = await get(KEY); if (got && got.v === 1) state = withDefaults(got); } catch {}
  try { const n = JSON.parse(localStorage.getItem(NAVKEY) || '{}'); if (typeof n.settings === 'boolean') local.nav = { ...local.nav, settings: n.settings }; } catch {}
  try { (navigator as any).storage?.persist?.(); } catch {}
  emit();
}

const today = () => dateOf(nowTs());

export const actions = {
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
        // without named steps, the time already spent on the unfinished part comes off what's left
        const partial = m0?.kind === 'work' && !m0.labels?.length ? Math.max(0, elapsed - credited * unit) : 0;
        const restMin = m0?.kind === 'work' ? Math.max(restUnits > 0 ? 5 : 0, Math.round(restUnits * unit - partial)) : Math.max(0, Math.round(r.plannedMin * f0) - elapsed);
        if (elapsed >= 5 || credited > 0) {
          s.logs.push({ id: uid(), missionId: r.missionId, date, start: r.startedAt, end, plannedMin: r.plannedMin, units: credited, done: false, ...(r.step !== undefined ? { step: r.step } : {}) });
          if (credited > 0 && m0?.kind === 'work') { m0.unitsLeft = Math.max(0, (m0.unitsLeft || 0) - credited); if (m0.unitsLeft === 0) m0.doneAt = date; }
        }
        s.running = undefined;
        const pl = s.days[date]?.plan;
        if (pl && m0 && restMin >= 5 && restUnits > 0) {
          const start = Math.floor(nm / 5) * 5;
          const named = m0.kind === 'work' && m0.labels?.length ? describeUnits(nextLabels(m0, restUnits)) : '';
          pl.items.push({ key: `m:${m0.id}:p${end % 100000}`, missionId: m0.id, start, end: start + restMin, title: m0.title, sub: `${named ? named + ' · ' : ''}${restMin} min left`, detail: m0.note, units: restUnits, baseMin: m0.kind === 'work' ? restUnits * m0.minutes : r.plannedMin, min: restMin, ...(r.step !== undefined ? { step: r.step } : {}) });
          const added = pl.items.find((x) => x.key === `m:${m0.id}:p${end % 100000}`)!;
          // never more of it in the plan than is left to do (another device may have planned it again)
          if (m0.kind === 'work' && r.step === undefined) {
            let room = (m0.unitsLeft ?? 0) - restUnits;
            const others = pl.items.filter((x) => x !== added && x.missionId === m0.id && x.step === undefined).sort((x, y) => x.start - y.start);
            for (const o of others) { const u = o.units || 1; if (u <= room) room -= u; else pl.items.splice(pl.items.indexOf(o), 1); }
          }
          // whatever it now lands on moves to the next free time after it
          const hit = pl.items.filter((x) => x !== added && x.start < added.end && added.start < x.end);
          for (const h of hit) pl.items.splice(pl.items.indexOf(h), 1);
          for (const h of hit.sort((x, y) => x.start - y.start)) {
            const len = h.end - h.start, g = nextGap(s, date, added.end, len);
            if (g !== null) pl.items.push({ ...h, start: g, end: g + len });
          }
          pl.items.sort((a, b) => a.start - b.start);
        }
        return;
      }
      // stopping partway still counts the steps ticked off; the rest goes back to the pool
      const doneUnits = done ? r.units : Math.min(r.units, r.ticked || 0);
      const log: Log = { id: uid(), missionId: r.missionId, date, start: r.startedAt, end, plannedMin: r.plannedMin, units: doneUnits, done, ...(r.step !== undefined ? { step: r.step } : {}) };
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
    });
  },
  /** Done earlier and logging it now: records it with the real times he enters (minutes from midnight, today). */
  doneEarlier(missionId: string, units: number, plannedMin: number, fromMin: number, toMin: number, step?: number, key?: string) {
    mutate((s) => {
      const date = today(), base = new Date(nowTs()); base.setHours(0, 0, 0, 0);
      const start = base.getTime() + fromMin * 60000, end = base.getTime() + Math.max(fromMin + 1, toMin) * 60000;
      s.logs.push({ id: uid(), missionId, date, start, end, plannedMin, units, done: true, ...(step !== undefined ? { step } : {}) });
      const pl = s.days[date]?.plan;
      if (pl) { const i = pl.items.findIndex((x) => (key ? x.key === key : x.missionId === missionId)); if (i >= 0) pl.items.splice(i, 1); }
      const m = s.missions.find((x) => x.id === missionId);
      if (m?.kind === 'work') { m.unitsLeft = Math.max(0, (m.unitsLeft || 0) - units); if (m.unitsLeft === 0) m.doneAt = date; }
    });
  },
  /** Fix the real start and end of something already logged (minutes from midnight on its day). */
  editLog(id: string, fromMin: number, toMin: number) {
    mutate((s) => {
      const l = s.logs.find((x) => x.id === id); if (!l) return;
      const base = new Date(l.start); base.setHours(0, 0, 0, 0);
      l.start = base.getTime() + fromMin * 60000; l.end = base.getTime() + Math.max(fromMin + 1, toMin) * 60000;
    });
  },
  cancelRun() { mutate((s) => { s.running = undefined; }); },
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
      const keepEnd = cur[meal]?.end !== undefined && cur[meal]!.at === mins ? { end: cur[meal]!.end } : {};
      if (at === null) delete cur[meal]; else cur[meal] = { at: mins, ...(big ?? cur[meal]?.big ? { big: true } : {}), ...keepEnd };
      if (at !== null && big === false) delete cur[meal]!.big;
      d.ate = cur;
      if (meal === 'dinner' && at !== null) d.dinnerTap = mins;
    });
  },
  /** Done eating: the meal ends now (or at the given time), and what comes after can start. */
  doneEating(meal: 'lunch' | 'dinner', at?: number | null) {
    const t = nowTs(), mins = at ?? new Date(t).getHours() * 60 + new Date(t).getMinutes();
    mutate((s) => {
      const d = (s.days[today()] ||= {}), cur = d.ate?.[meal]; if (!cur) return;
      const next = { ...cur }; if (at === null) delete next.end; else next.end = Math.max(cur.at + 1, mins);
      d.ate = { ...(d.ate || {}), [meal]: next };
    });
  },
  /** Fix today's plan once the day has started (or after a change rebuilt it). */
  savePlan(sig: string, items: PlanSnap[]) {
    mutate((s) => { const d = (s.days[today()] ||= {}); d.plan = { sig, items, know: know(s) }; });
  },
  /** A planned block passed without being started: log it as missed (feeds the energy model), then the day re-plans. */
  /** A meal not eaten 5 minutes past its time moves to the next free stretch, without reshuffling the rest of the day. */
  mealLate(meal: 'lunch' | 'dinner') {
    mutate((s) => {
      const date = today(), d = (s.days[date] ||= {});
      if (d.ate?.[meal] || (meal === 'dinner' && d.cook)) return; // dinner after cooking follows the cooking
      const t = new Date(nowTs()), nm = Math.ceil((t.getHours() * 60 + t.getMinutes()) / 5) * 5;
      const len = meal === 'lunch' ? d.lunchMin ?? s.settings.lunchMin : d.dinnerMin ?? s.settings.dinnerMin;
      const hi = meal === 'lunch' ? 870 : 1230;
      // look for room as if the meal weren't on the clock yet
      const tmp = structuredClone(s), td = tmp.days[date];
      if (meal === 'lunch') { td.lunchAt = nm; td.lunchMin = 0; } else { td.dinnerAt = nm; td.dinnerMin = 0; }
      const gap = nextGap(tmp, date, nm, len);
      // a free stretch in the window: the meal moves there and the rest of the day stays put;
      // none: the meal is now, and the rest of the day re-plans around it
      const at = gap !== null && gap <= hi ? gap : nm;
      if (at > hi) return; // past the usual window: leave it
      const kept = gap === at && d.plan && d.plan.sig === planSig(s, date);
      if (meal === 'lunch') d.lunchAt = at; else d.dinnerAt = at;
      d.mealMoved = { ...(d.mealMoved || {}), [meal]: at };
      if (kept) d.plan!.sig = planSig(s, date);
    });
  },
  recordMiss(missionId: string, at: number) {
    const d0 = S().days[today()];
    if ((d0?.misses || []).some((x) => x.m === missionId && x.at === at)) return; // each planned time counts once
    mutate((s) => { const d = (s.days[today()] ||= {}); d.misses = [...(d.misses || []), { m: missionId, at }].slice(-40); });
  },
  /** Dinner's called: dinner starts now, and the time teaches the usual dinner time. */
  dinnerNow() {
    const t = nowTs(), mins = new Date(t).getHours() * 60 + new Date(t).getMinutes();
    mutate((s) => { const d = (s.days[today()] ||= {}); d.dinnerAt = mins; d.dinnerTap = mins; d.ate = { ...(d.ate || {}), dinner: { at: mins } }; if (d.cook && !d.cookEnd) { d.cookEnd = t; d.cookStart ??= t - 1; } });
    toast('Dinner time. Enjoy it.');
  },
  setDay(date: string, patch: Partial<State['days'][string]>) { mutate((s) => { s.days[date] = { ...(s.days[date] || {}), ...patch }; }); },
  setSettings(patch: Partial<State['settings']>) { mutate((s) => { s.settings = { ...s.settings, ...patch }; }); },
  saveMission(m: Mission) { mutate((s) => { const i = s.missions.findIndex((x) => x.id === m.id); if (i >= 0) s.missions[i] = m; else s.missions.push(m); }); },
  addMeasure(weight: number, neck: number, navel: number) {
    mutate((s) => {
      const date = today(), t = nowTs();
      s.measures.push({ id: uid(), date, weight, neck, navel });
      s.logs.push({ id: uid(), missionId: 'measure', date, start: t - 600000, end: t, plannedMin: 10, units: 1, done: true });
    });
  },
  /** Not doing this today: it leaves today's plan (and teaches the app that time didn't suit it). */
  skip(missionId: string, at: number) {
    mutate((s) => { const d = (s.days[today()] ||= {}); d.misses = [...(d.misses || []), { m: missionId, at, skip: true }].slice(-40); });
  },
  importState(json: string) { const got = JSON.parse(json); if (got?.v !== 1 || !Array.isArray(got.missions)) throw new Error('Not a Limit Break backup'); state = withDefaults(got); state.updatedAt = Date.now(); persist(); emit(); },
  reset() { state = seed(); state.updatedAt = Date.now(); persist(); emit(); },
};
