import type { State, Mission, Objective, Evt } from './types';
import { addDays, dateOf, diffDays, minsOf, weekStart, weekday } from './time';
import { eatingNow, eventsOn, fixedBlocks, freeSlots, holidayName, isSabbath, sunTimes, type Block } from './schedule';
import { choreDue, exerciseCeiling, exerciseMinWeek, expectedBusy, factor, isExercise, realMisses } from './learn';

/**
 * How a day gets planned. No levels: the whole free day is filled, most important work first.
 *
 * What (the ranking):
 *   1 floor · 2 due today (dated habits, errands) · 3 deadline work needed today to stay on pace
 *   4 the big goals, up to their weekly targets · 5 getting ahead on a deadline while it's short of a week's buffer
 *   6 smaller goals · 7 anything beyond targets
 * How much he really gets done (learned from what he marks) paces the deadlines and drives the two warnings.
 * When: each task goes where tasks like it most often get done (time of day x energy type), the most important first.
 */
export interface PlanItem {
  key: string; start: number; end: number; title: string; sub?: string; detail?: string;
  kind: 'mission' | 'fixed';
  missionId?: string; units?: number; baseMin?: number; min?: number; step?: number;
  done?: boolean; running?: boolean; now?: boolean; past?: boolean; logId?: string;
  /** FINAL SHOT: skipping it today loses a deadline even giving everything (Off Duty included);
   *  DANGER ZONE: at his usual pace it misses a deadline (or skipping it today makes it miss). */
  must?: 'final' | 'danger';
  block?: Block;
}
/** One thing a day needs: a mission, how much of it, how important. */
export interface Need { missionId: string; units: number; min: number; baseMin: number; row: number }
export interface Warn { objectiveId: string; title: string; due: string; lands: string | null; kind: 'failure' | 'pace' }
export interface Forecast {
  today: string;
  /** deadline work per day, as the plan lays it out (dates from today) */
  days: { date: string; needs: Need[] }[];
  /** when each deadline lands at his usual pace */
  landing: Record<string, string | null>;
  warns: Warn[];
  /** today's tasks whose skipping costs a deadline: mission -> Objective title */
  must: Record<string, { kind: 'final' | 'danger'; title: string }>;
  /** deadlines that miss at his usual pace: their work on later days shows as DANGER ZONE */
  lateIds: string[];
}

/** The ranking, most important first. */
const R = { final: 1, due: 2, core: 3, danger: 4, deadline: 5, floor: 6, big: 7, ahead: 8, minor: 9, extra: 10 };
const WEIGHT = [0, 100, 95, 90, 80, 60, 50, 30, 15, 8, 2];
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round5 = (x: number) => Math.ceil(x / 5) * 5;
export const GRACE = 5;
const BUFFER = 7;

export function describeUnits(labels: string[]): string {
  const groups: { g: string; items: string[] }[] = [];
  let prev = '';
  for (const l of labels) {
    if (l === prev) continue;
    prev = l;
    const [g, item = ''] = l.split('|');
    const last = groups[groups.length - 1];
    if (last && last.g === g) last.items.push(item); else groups.push({ g, items: item ? [item] : [] });
  }
  return groups.map(({ g, items }) => {
    const nums = items.map((i) => /^lesson (\d+)$/.exec(i)).filter(Boolean).map((x) => +x![1]);
    const other = items.filter((i) => !/^lesson \d+$/.test(i));
    const parts: string[] = [];
    if (nums.length) parts.push(nums.length === 1 ? `lesson ${nums[0]}` : `lessons ${nums[0]}–${nums[nums.length - 1]}`);
    parts.push(...other);
    return parts.length ? `${g}: ${parts.join(' + ')}` : g;
  }).join(' · ');
}
export function nextLabels(m: Mission, units: number, skip = 0): string[] {
  if (!m.labels?.length) return [];
  const at = m.labels.length - (m.unitsLeft ?? 0) + skip;
  return m.labels.slice(Math.max(0, at), Math.max(0, at) + units);
}
export function rotationAt(s: State, m: Mission, skip = 0) {
  const r = m.rotation!;
  return r[(s.logs.filter((l) => l.missionId === m.id && l.done).length + skip) % r.length];
}
const detailOf = (s: State, m: Mission, skip = 0) => (m.rotation?.length ? [rotationAt(s, m, skip).detail, m.note].filter(Boolean).join('\n\n') : m.note);

export function lastDone(s: State, id: string, before?: string): string | null {
  let d: string | null = null;
  for (const l of s.logs) if (l.missionId === id && l.done && (!before || l.date < before) && (!d || l.date > d)) d = l.date;
  return d;
}
/** The floor: daily routines (not the longer forms), every day. */
const isFloor = (m: Mission) => m.kind === 'habit' && !m.notFloor && m.minLevel <= 4;
/** Habits due on a date (cadence and weekdays), floor or not. */
export function habitsDue(s: State, date: string, last?: Map<string, string | null>): Mission[] {
  return s.missions.filter((m) => {
    if (m.kind !== 'habit' || m.archived) return false;
    if (m.days && !m.days.includes(weekday(date))) return false;
    if (m.everyDays && m.everyDays > 1) { const ld = last ? last.get(m.id) ?? null : lastDone(s, m.id, date); if (ld && diffDays(ld, date) < m.everyDays) return false; }
    return true;
  });
}
const isBig = (m: Mission) => !!(m.guarantee?.length || m.pace || m.exShare);

/** Minutes a week the big goals get (guarantee, total-hours pace, share of the exercise ceiling). */
function weeklyTarget(s: State, m: Mission, date: string, exCap: number): number {
  const g0 = (m.guarantee || []).filter((x) => x.from <= date).sort((a, b) => b.from.localeCompare(a.from))[0];
  let g = g0 ? g0.min : m.pace || m.exShare ? Infinity : 0;
  if (m.pace) {
    const ws = weekStart(date), logged = s.logs.filter((l) => m.pace!.count.includes(l.missionId) && l.date >= m.pace!.since && l.date < ws && l.end > 0).reduce((a, l) => a + (l.end - l.start) / 60000, 0);
    g = Math.min(g, Math.max(0, Math.round((m.pace.totalMin - logged) / Math.max(1, diffDays(ws, m.pace.by) / 7) - (m.pace.routineMin || 0))));
  }
  if (m.exShare) g = Math.min(g, Math.round(exCap * m.exShare));
  return Number.isFinite(g) ? g : 0;
}
const logMin = (l: { start: number; end: number }) => (l.end > 0 ? Math.max(1, (l.end - l.start) / 60000) : 0);

/** What counts as getting work done: not routines, chores or errands. */
const workIds = (s: State) => new Set(s.missions.filter((m) => m.kind !== 'habit' && m.kind !== 'chore' && !m.errand).map((m) => m.id));
/** Usable free minutes in a day (gaps of 15 min or more, with breaks between blocks). */
const freeMinOn = (s: State, date: string, from = 0) => freeSlots(fixedBlocks(s, date), from).reduce((a, [x, y]) => a + (y - x >= 15 ? (y - x) * 60 / (60 + (s.settings.breakMin ?? 10)) : 0), 0);
/** Share of a day's free time used for routines (the floor and what's due). */
const floorMinOn = (s: State, date: string) => habitsDue(s, date).filter((m) => isFloor(m) || m.notFloor).reduce((a, m) => a + m.minutes * factor(s, m.id), 0);
const PRIOR_SHARE = 0.5;

/**
 * How much of his free time he really spends on work: recent days he used this version of the app (days from the
 * old, level-capped app don't count), newest counting most. Starts from a modest guess until there are 5 days.
 */
export function usualShare(s: State, today: string): number {
  const ids = workIds(s), xs: number[] = [];
  for (let i = 1; i <= 28 && xs.length < 14; i++) {
    const d = addDays(today, -i);
    if (isSabbath(s, d) || s.days[d]?.level) continue; // old-app days were capped by level
    const ls = s.logs.filter((l) => l.date === d);
    if (!ls.length && !s.days[d]?.misses?.length) continue; // a day he didn't use the app says nothing
    const free = freeMinOn(s, d) - floorMinOn(s, d);
    if (free < 60) continue;
    xs.push(clamp(ls.filter((l) => ids.has(l.missionId)).reduce((a, l) => a + logMin(l), 0) / free, 0, 1));
  }
  if (!xs.length) return PRIOR_SHARE;
  let w = 0, t = 0;
  xs.forEach((x, i) => { const k = Math.pow(0.9, i); w += k; t += k * x; });
  const mean = t / w;
  return xs.length >= 5 ? mean : (mean * xs.length + PRIOR_SHARE * (5 - xs.length)) / 5;
}

let memo: { k: string; v: Forecast } | null = null;

export function forecast(s: State, now: number): Forecast {
  const today = dateOf(now);
  const k = `${s.updatedAt}|${Math.floor(now / 300000)}`;
  if (memo && memo.k === k) return memo.v;
  const live = s.missions.filter((m) => !m.archived);
  const byId = new Map(live.map((m) => [m.id, m]));
  const unit = (m: Mission) => m.minutes * factor(s, m.id);
  const objs = s.objectives.filter((o) => !o.done);
  const deadlineObjs = objs.filter((o) => o.due && live.some((m) => m.objectiveId === o.id && m.kind === 'work' && !m.errand && !isBig(m)));
  const dues = deadlineObjs.map((o) => diffDays(today, o.due!));
  const H = clamp(Math.max(14, ...dues.map((d) => d + 30)), 14, 150);
  const units0 = new Map(live.filter((m) => m.kind === 'work').map((m) => [m.id, m.unitsLeft ?? 0]));
  const run = s.running;
  if (run && units0.has(run.missionId)) units0.set(run.missionId, Math.max(0, units0.get(run.missionId)! - run.units));
  const done0 = new Map<string, number>();
  for (const m of live) if (m.kind === 'work' && (units0.get(m.id) ?? 0) <= 0) done0.set(m.id, m.doneAt ? diffDays(today, m.doneAt) : -999);
  const tailMemo = new Map<string, number>();
  const tail = (m: Mission): number => {
    if (tailMemo.has(m.id)) return tailMemo.get(m.id)!;
    tailMemo.set(m.id, 0);
    const v = (m.clock ? m.waitDays || 0 : 0) + Math.max(0, ...live.filter((x) => (x.after || []).includes(m.id)).map(tail));
    tailMemo.set(m.id, v);
    return v;
  };
  const isDeadlineWork = (m: Mission) => m.kind === 'work' && !m.errand && !isBig(m) && deadlineObjs.some((o) => o.id === m.objectiveId);

  // ---- Each day: free minutes (whole plan), and what he usually gets done (realistic).
  const share = usualShare(s, today);
  const brk = s.settings.breakMin ?? 10;
  const exCap = exerciseCeiling(s, today).cap;
  const last = new Map(live.filter((m) => m.kind === 'habit').map((m) => [m.id, lastDone(s, m.id)]));
  const days: { date: string; sab: boolean; free: number; max: number; real: number; floor: number; big: number; sabFree: number; sabReal: number }[] = [];
  for (let t = 0; t <= H; t++) {
    const date = addDays(today, t), sab = isSabbath(s, date);
    const fx = fixedBlocks(s, date), from = t === 0 ? round5(minsOf(now)) : 0;
    const slots = freeSlots(fx, from);
    const off = fx.find((b) => b.kind === 'offduty');
    const offMin = off ? Math.max(0, off.end - Math.max(off.start, from)) * 60 / (60 + brk) : 0;
    let free = slots.reduce((a, [x, y]) => a + (y - x >= 15 ? (y - x) * 60 / (60 + brk) : 0), 0);
    if (t === 0 && run) free -= Math.max(0, run.plannedMin * factor(s, run.missionId) - (now - run.startedAt) / 60000);
    let floor = 0;
    for (const m of habitsDue(s, date, last)) {
      if (t === 0 && s.logs.some((l) => l.missionId === m.id && l.date === date && l.done)) continue;
      if (isFloor(m) || m.notFloor) floor += unit(m);
      if (t > 0 && m.everyDays) last.set(m.id, date);
    }
    // the big goals' share of a day (their weekly targets spread over the week)
    let big = 0;
    if (!sab) for (const m of live) if (isBig(m) && (!m.notBefore || date >= m.notBefore)) big += weeklyTarget(s, m, date, exCap) / 6;
    // later days: plans that usually come up that weekday, and holidays at half
    let hold = 0;
    if (t >= 1) {
      const known = eventsOn(s, date).filter((e) => e.date).reduce((a, e) => a + (e.end - e.start) + e.travel + (e.travelBack ?? e.travel), 0);
      hold = Math.max(0, expectedBusy(s, today, weekday(date)) - known);
      if (holidayName(date) && !eventsOn(s, date).some((e) => e.date)) hold = Math.max(hold, free / 2);
    }
    const workFree = Math.max(0, free - floor);
    const real = sab ? 0 : share * Math.max(0, workFree - hold); // today: what's left of today's free time
    days.push({ date, sab, free: sab ? 0 : workFree, max: workFree + offMin, real, floor, big: Math.min(big, workFree), sabFree: sab ? workFree : 0, sabReal: sab ? share * Math.max(0, workFree - hold) : 0 });
  }
  let sunCap = 0; // minutes a rest day gives deadlines, only when that's what saves one
  const realW = days.map((d) => d.real);
  const avgW = realW.reduce((a, b) => a + b, 0) / Math.max(1, realW.length);
  const safeOf = (o: Objective, extra: number) => {
    const maxTail = Math.max(0, ...live.filter((m) => m.objectiveId === o.id && m.kind === 'work' && (units0.get(m.id) || 0) > 0).map(tail));
    return Math.max(0, diffDays(today, o.due!) - extra - maxTail);
  };
  const order = [...deadlineObjs].sort((a, b) => a.due!.localeCompare(b.due!));

  /**
   * Walk forward day by day. mode 'real': each day gets what he usually does, in ranking order (deadline pace first,
   * then the big goals' share, then the buffer). 'plan': the whole free day. 'max': every free minute to deadlines.
   */
  type Sim = { units: Map<string, number>; doneIdx: Map<string, number>; alloc: Need[][] };
  const simulate = (mode: 'real' | 'plan' | 'max', from = 0, startUnits = units0, startDone = done0): Sim => {
    const units = new Map(startUnits), doneIdx = new Map(startDone), owed = new Map<string, number>(), alloc: Need[][] = [];
    const available = (m: Mission, t: number) => (!m.notBefore || addDays(today, t) >= m.notBefore) && (!m.onDate || m.onDate === addDays(today, t))
      && (m.afterNoWait || []).every((a) => !byId.get(a) || (doneIdx.get(a) ?? 1e9) <= t)
      && (m.after || []).every((a) => { const p = byId.get(a); return !p || (doneIdx.get(a) ?? 1e9) + (p.clock ? p.waitDays || 0 : 0) <= t; });
    const remaining = (oid: string) => live.filter((m) => m.objectiveId === oid && isDeadlineWork(m)).reduce((a, m) => a + (units.get(m.id) || 0) * unit(m), 0);
    for (let t = 0; t < from; t++) alloc.push([]);
    for (let t = from; t <= H; t++) {
      const d = days[t], out: Need[] = [], usedBy = new Map<string, number>();
      let left = d.sab && mode !== 'max' ? Math.min(sunCap, mode === 'real' ? d.sabReal : d.sabFree) : mode === 'real' ? d.real : mode === 'max' ? d.max : d.free;
      const give = (o: Objective, amount: number, row: number) => {
        let ow = Math.min(remaining(o.id), (owed.get(o.id + row) || 0) + amount);
        for (let progressed = true; progressed;) {
          progressed = false;
          const ready = live.filter((m) => m.objectiveId === o.id && isDeadlineWork(m) && (units.get(m.id) || 0) > 0 && available(m, t))
            .sort((a, b) => Number(!!b.clock) - Number(!!a.clock) || tail(b) - tail(a));
          for (const m of ready) {
            const u1 = unit(m);
            while ((units.get(m.id) || 0) > 0 && ow >= Math.min(u1 * 0.5, 15) && left >= Math.min(u1 * 0.5, 15) && available(m, t)) {
              const capLeft = (m.dailyCapMin || 1e9) - (usedBy.get(m.id) || 0);
              const u = Math.min(units.get(m.id)!, Math.max(1, Math.floor((Math.min(ow, left, capLeft) + u1 * 0.5) / u1)));
              if (capLeft < u1 * 0.5) break;
              const min = Math.round(u * u1);
              out.push({ missionId: m.id, units: u, min, baseMin: u * m.minutes, row });
              ow -= min; left -= min; usedBy.set(m.id, (usedBy.get(m.id) || 0) + min); progressed = true;
              units.set(m.id, units.get(m.id)! - u);
              if (!units.get(m.id)) doneIdx.set(m.id, t);
            }
          }
        }
        owed.set(o.id + row, Math.max(0, ow));
      };
      const paceShare = (o: Objective, extra: number) => {
        const safe = safeOf(o, extra), rem = remaining(o.id);
        if (rem <= 0) return 0;
        if (t >= safe) return rem;
        let denom = 0;
        for (let j = t; j <= Math.min(safe, H); j++) denom += realW[j];
        if (safe > H) denom += (safe - H) * avgW;
        return denom > 0 ? (rem * realW[t]) / denom : rem;
      };
      if (left > 0) {
        if (mode === 'max') for (const o of order) give(o, 1e9, 3);
        else {
          // needed today: the pace share, or more when the days ahead (at his usual pace) can't cover what's left
          let ahead = 0;
          const sh = order.map((o) => {
            const rem = remaining(o.id), safe = Math.min(H, safeOf(o, 0));
            let fut = 0; for (let j = t + 1; j <= safe; j++) fut += realW[j];
            const catchUp = mode === 'plan' ? Math.max(0, rem - Math.max(0, fut - ahead)) : 0;
            ahead += rem;
            return [Math.max(paceShare(o, 0), catchUp), paceShare(o, BUFFER)];
          });
          order.forEach((o, i) => give(o, sh[i][0], 3));
          if (mode === 'real') left -= Math.min(left, d.big); // the big goals take their share before getting ahead
          if (!d.sab) order.forEach((o, i) => give(o, Math.max(0, sh[i][1] - sh[i][0]), 5));
        }
      }
      alloc.push(out);
    }
    return { units, doneIdx, alloc };
  };
  const landOf = (x: Sim, o: Objective, seen = new Set<string>()): number | null => {
    if (seen.has(o.id)) return null; seen.add(o.id);
    let d = -1e9;
    for (const m of live) if (m.objectiveId === o.id && m.kind === 'work') { const i = x.doneIdx.get(m.id); if (i === undefined) return null; d = Math.max(d, i); }
    for (const id of o.dependsOn || []) { const p = s.objectives.find((y) => y.id === id); if (p && !p.done) { const v = landOf(x, p, seen); if (v === null) return null; d = Math.max(d, v); } }
    return d === -1e9 ? null : d;
  };
  const late = (x: Sim, o: Objective) => { const d = landOf(x, o), due = diffDays(today, o.due!); return d === null ? due <= H : d > due; };

  // Rest days: used for deadline work only when that's what makes a deadline at his usual pace, and only as much as it takes
  {
    const due = deadlineObjs.filter((o) => diffDays(today, o.due!) <= H);
    const setCap = (c: number) => { sunCap = c; days.forEach((d, i) => { if (d.sab) realW[i] = Math.min(c, d.sabReal); }); };
    const lateAt = (c: number) => { setCap(c); const r = simulate('real'); return due.filter((o) => late(r, o)).map((o) => o.id); };
    const without = lateAt(0), top = Math.max(0, ...days.map((d) => d.sabReal));
    const saved = (c: number) => { const l = lateAt(c); return without.some((id) => !l.includes(id)) && l.every((id) => without.includes(id)); };
    if (without.length && top > 0 && saved(top)) {
      let lo = 0, hi = top;
      while (hi - lo > 15) { const mid = (lo + hi) / 2; if (saved(mid)) hi = mid; else lo = mid; }
      setCap(hi);
    } else setCap(0);
  }
  const plan = simulate('plan'), real = simulate('real'), max = simulate('max');
  const landing: Record<string, string | null> = {};
  const warns: Warn[] = [];
  for (const o of objs) {
    if (!o.due || (!live.some((m) => m.objectiveId === o.id && m.kind === 'work') && !o.dependsOn?.length)) continue;
    const d = landOf(real, o);
    landing[o.id] = d === null ? null : addDays(today, Math.max(0, d));
    if (diffDays(today, o.due) > H) continue;
    const dm = landOf(max, o);
    if (late(max, o)) warns.push({ objectiveId: o.id, title: o.title, due: o.due, lands: dm === null ? null : addDays(today, dm), kind: 'failure' });
    else if (late(real, o)) warns.push({ objectiveId: o.id, title: o.title, due: o.due, lands: landing[o.id], kind: 'pace' });
  }
  // Today's deadline work. FINAL SHOT: skipped, the deadline is lost even giving everything from tomorrow (Off Duty too).
  // DANGER ZONE: at his usual pace the deadline is missed, or would be if this is skipped today.
  const must: Forecast['must'] = {};
  const todayNeeds = plan.alloc[0] || [];
  if (todayNeeds.length) {
    const waits = (id: string, on: string, seen = new Set<string>()): boolean => { if (seen.has(id)) return false; seen.add(id); const m = byId.get(id); return [...(m?.after || []), ...(m?.afterNoWait || [])].some((a) => a === on || waits(a, on, seen)); };
    const after = (mode: 'real' | 'max', drop?: string) => {
      const u = new Map(units0), dn = new Map(done0);
      for (const n of todayNeeds) {
        if (drop && (n.missionId === drop || waits(n.missionId, drop))) continue;
        u.set(n.missionId, Math.max(0, (u.get(n.missionId) || 0) - n.units)); if (!u.get(n.missionId)) dn.set(n.missionId, 0);
      }
      return simulate(mode, 1, u, dn);
    };
    const baseMax = after('max'), baseReal = after('real');
    for (const id of new Set(todayNeeds.map((n) => n.missionId))) {
      const o = deadlineObjs.find((x) => x.id === byId.get(id)?.objectiveId)!;
      const obs = [o, ...objs.filter((x) => x.dependsOn?.includes(o.id))].filter((x) => x.due && diffDays(today, x.due) <= H);
      const lostMax = after('max', id), lostReal = after('real', id);
      const fin = obs.find((ob) => !late(baseMax, ob) && late(lostMax, ob));
      if (fin) { must[id] = { kind: 'final', title: fin.title }; continue; }
      const dz = obs.find((ob) => late(baseReal, ob) || late(lostReal, ob));
      if (dz) must[id] = { kind: 'danger', title: dz.title };
    }
  }
  const lateIds = objs.filter((o) => o.due && diffDays(today, o.due) <= H && late(real, o)).map((o) => o.id);
  const v: Forecast = { today, days: plan.alloc.map((needs, t) => ({ date: days[t].date, needs })), landing, warns, must, lateIds };
  memo = { k, v };
  return v;
}

// ---- When things get done: success by time of day x energy type, learned from what he marks.
const BUCKETS = [720, 1020, 1260, 1e9]; // morning, afternoon, evening, night
const bucketOf = (min: number) => BUCKETS.findIndex((b) => min < b);
export interface Odds { rate: (type: string, b: number) => number; n: (type: string, b: number) => number }
export function successOdds(s: State, today: string): Odds {
  const en = new Map(s.missions.map((m) => [m.id, m.energy]));
  const c = new Map<string, { n: number; ok: number }>();
  const add = (k: string, ok: number) => { const x = c.get(k) || { n: 0, ok: 0 }; x.n++; x.ok += ok; c.set(k, x); };
  const from = addDays(today, -90);
  for (const l of s.logs) if (l.date >= from && l.date < today && l.end > 0) add(`${en.get(l.missionId) || 'none'}|${bucketOf(minsOf(l.start))}`, l.done ? 1 : 0.5);
  for (const [d, r] of Object.entries(s.days)) if (d >= from && d < today) for (const x of realMisses(s, d)) add(`${en.get(x.m) || 'none'}|${bucketOf(x.at)}`, 0);
  return {
    rate: (type, b) => { const x = c.get(`${type}|${b}`); return ((x?.ok || 0) + 1.2) / ((x?.n || 0) + 2); },
    n: (type, b) => c.get(`${type}|${b}`)?.n || 0,
  };
}
const hash = (str: string) => { let h = 2166136261; for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619); return h >>> 0; };

/** What today's plan depends on: when any of it changes, the day is re-planned (time passing alone doesn't). */
export function planSig(s: State, date: string): string {
  const { plan, t, ft, misses, ...d } = s.days[date] || {};
  const ms = JSON.stringify(s.missions.filter((m) => !m.archived).map(({ unitsLeft, doneAt, t: _t, ...rest }) => rest));
  return String(hash(JSON.stringify([d, eventsOn(s, date).map((e) => [e.id, e.start, e.end, e.travel, e.travelBack]), realMisses(s, date).length, s.settingsT || 0, ms])));
}

/** Lay a day out on the clock: fixed blocks, then the day's needs in ranking order into their best times. */
export function layoutDay(s: State, fc: Forecast, date: string, now: number): PlanItem[] {
  const flex = eventsOn(s, date).find((e) => e.leaveWindow);
  if (flex) return flexDay(s, fc, date, now, flex);
  const today = fc.today, isToday = date === today, tIdx = diffDays(today, date);
  const fixed = fixedBlocks(s, date);
  const nowMin = isToday ? minsOf(now) : date < today ? 1e9 : -1;
  const mb0 = fixed.find((b) => b.key === 'f:morning');
  const leftHome = !!mb0 && fixed.some((b) => b.key !== 'f:morning' && b.blocking && (b.kind === 'travel' || b.kind === 'event') && b.start >= mb0.end && b.start <= nowMin);
  const morningOpen = isToday && !s.days[date]?.morningEnd && !leftHome;
  if (morningOpen && mb0 && mb0.end < round5(nowMin)) mb0.end = round5(nowMin);
  if (isToday) for (const meal of ['lunch', 'dinner'] as const) {
    const r = s.days[date]?.dishes?.[meal]; if (!r || r.end !== undefined) continue;
    const b = fixed.find((x) => x.key === (meal === 'lunch' ? 'f:dishes1' : 'f:dishes2'));
    if (b && b.end < round5(nowMin) && nowMin < b.start + 60) b.end = round5(nowMin);
  }
  const eating = isToday ? eatingNow(s, date, nowMin) : null;
  if (eating) { const mb = fixed.find((b) => b.kind === 'meal' && b.meal === eating); if (mb && mb.end < round5(nowMin)) mb.end = round5(nowMin); }
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  const items: PlanItem[] = fixed.map((b) => ({ key: b.key, start: b.start, end: b.end, title: b.title, sub: b.sub, kind: 'fixed' as const, block: b, past: b.end <= nowMin && b.kind !== 'note' && !(morningOpen && b.key === 'f:morning') }));
  const occ = new Map<string, number>();
  const keyFor = (id: string) => { const n = occ.get(id) || 0; occ.set(id, n + 1); return `m:${id}:${n}`; };
  const label = (m: Mission, min: number, units: number, skip = 0) => {
    const bits: string[] = [];
    if (m.rotation?.length) bits.push(rotationAt(s, m, skip).title);
    const named = m.kind === 'work' ? nextLabels(m, units, skip) : [];
    if (named.length) bits.push(describeUnits(named));
    else if (m.kind === 'work' && m.unitName && m.unitsTotal) {
      const at = m.unitsTotal - (m.unitsLeft || 0) + 1 + skip;
      bits.push(units > 1 ? `${m.unitName}s ${at} to ${Math.min(m.unitsTotal, at + units - 1)} of ${m.unitsTotal}` : `${m.unitName} ${Math.min(at, m.unitsTotal)} of ${m.unitsTotal}`);
    }
    bits.push(m.kind === 'habit' ? `${min} min` : `about ${min} min`);
    if (m.energy !== 'none' && m.kind === 'habit') bits.push(m.energy[0].toUpperCase() + m.energy.slice(1));
    return bits.join(' · ');
  };
  for (const l of s.logs.filter((x) => x.date === date && x.done && x.end > 0).sort((a, b) => a.start - b.start)) {
    const m = byId.get(l.missionId); if (!m) continue;
    const stepT = l.step !== undefined ? m.steps?.[l.step]?.title : undefined;
    items.push({ key: l.step !== undefined ? `c:${m.id}:${l.step}` : keyFor(m.id), start: minsOf(l.start), end: Math.max(minsOf(l.start) + 1, minsOf(l.end)), title: stepT || m.title, sub: `${Math.max(1, Math.round((l.end - l.start) / 60000))} min`, detail: m.note, kind: 'mission', missionId: m.id, done: true, logId: l.id });
  }
  if (date < today || tIdx > 14) return items.sort((a, b) => a.start - b.start);

  let slots = freeSlots(fixed, round5(nowMin));
  const carve = (a: number, len: number) => { slots = slots.flatMap(([x, y]) => (y <= a || x >= a + len ? [[x, y]] : [[x, a], [a + len, y]].filter(([p, q]) => q - p >= 5)) as [number, number][]); };
  const run = isToday ? s.running : undefined;
  const used = new Map<string, number>(); // units/blocks already on the clock today, for naming the next ones
  if (run) {
    const m = byId.get(run.missionId);
    if (m) {
      const st = minsOf(run.startedAt), min = Math.round(run.plannedMin * factor(s, m.id)), end = Math.max(round5(nowMin), st + min);
      slots = slots.flatMap(([a, b]) => (b <= end ? [] : [[Math.max(a, end), b] as [number, number]]));
      items.push({ key: run.step !== undefined ? `c:${m.id}:${run.step}` : keyFor(m.id), start: st, end, title: run.step !== undefined ? m.steps?.[run.step]?.title || m.title : m.title, sub: label(m, min, run.units), detail: detailOf(s, m), kind: 'mission', missionId: m.id, units: run.units, baseMin: run.plannedMin, min, step: run.step, running: true });
      used.set(m.id, m.rotation?.length ? 1 : run.units);
    }
  }
  // the plan made earlier today stands until something it depends on changes
  const saved = isToday ? s.days[date]?.plan : undefined;
  if (saved && saved.sig === planSig(s, date)) {
    const gone = (id: string) => { const m = byId.get(id); return !m || m.archived || (m.kind === 'work' && (m.unitsLeft ?? 0) <= 0); };
    for (const p of saved.items) if (!gone(p.missionId) && !items.some((i) => i.key === p.key && (i.done || i.running))) items.push({ ...p, kind: 'mission', ...(fc.must[p.missionId] ? { must: fc.must[p.missionId].kind } : {}) });
    return finish(items, isToday, nowMin);
  }

  const sab = isSabbath(s, date);
  const doneToday = (id: string) => s.logs.filter((l) => l.missionId === id && l.date === date && l.done);
  const unit = (m: Mission) => m.minutes * factor(s, m.id);
  const exCap = exerciseCeiling(s, today).cap;
  const ws = weekStart(date);
  const weekDone = (ids: string[]) => s.logs.filter((l) => ids.includes(l.missionId) && l.date >= ws && l.date < addDays(ws, 7) && l.end > 0 && (l.date < today || isToday)).reduce((a, l) => a + logMin(l), 0);
  const daysLeftInWeek = () => { let n = 0; for (let d = date; weekStart(d) === ws; d = addDays(d, 1)) if (!isSabbath(s, d)) n++; return Math.max(1, n); };
  // what earlier days of the plan already cover (for days after today)
  const pre = new Map<string, number>();
  for (const d of fc.days) { if (d.date >= date) break; for (const n of d.needs) pre.set(n.missionId, (pre.get(n.missionId) || 0) + n.units); }
  const unitsLeftNow = (m: Mission) => Math.max(0, (m.unitsLeft ?? 0) - (pre.get(m.id) || 0) - (run?.missionId === m.id ? run.units : 0));

  // ---- What the day needs, with its row.
  const needs: Need[] = [];
  const add = (m: Mission, row: number, units: number, min: number) => { if (min >= 5 && units > 0 && !(m.skipOn || []).includes(date)) needs.push({ missionId: m.id, units, min: Math.round(min), baseMin: m.kind === 'work' ? units * m.minutes : m.minutes, row }); };
  const last = new Map<string, string | null>();
  if (!isToday) for (const m of s.missions) if (m.kind === 'habit' && m.everyDays) { let ld = lastDone(s, m.id); for (let d = today; d < date; d = addDays(d, 1)) if (habitsDue(s, d, new Map([[m.id, ld]])).some((x) => x.id === m.id)) ld = d; last.set(m.id, ld); }
  for (const m of habitsDue(s, date, isToday ? undefined : last)) {
    if (doneToday(m.id).length || run?.missionId === m.id) continue;
    if (isFloor(m)) { if (m.core) add(m, R.core, 1, unit(m)); else if (!sab) add(m, R.floor, 1, unit(m)); }
    else if (m.notFloor) add(m, R.due, 1, unit(m)); else if (!sab) add(m, R.minor, 1, unit(m));
  }
  for (const m of s.missions) if (m.errand && !m.archived && unitsLeftNow(m) > 0 && (!m.onDate || m.onDate === date) && (!m.notBefore || date >= m.notBefore)) add(m, m.onDate ? R.due : R.minor, unitsLeftNow(m), unitsLeftNow(m) * unit(m) + 2 * (m.travel || 0));
  // deadline work, in blocks no longer than each task allows
  for (const n of fc.days.find((d) => d.date === date)?.needs || []) {
    const m = byId.get(n.missionId); if (!m) continue;
    // later days: work for a deadline that misses at his usual pace (or one that depends on it) is DANGER ZONE
    const inDanger = () => [m.objectiveId, ...s.objectives.filter((o) => o.dependsOn?.includes(m.objectiveId)).map((o) => o.id)].some((id) => fc.lateIds.includes(id));
    const tag = isToday ? fc.must[m.id]?.kind : inDanger() ? 'danger' : undefined;
    // on a rest day, deadline work is only there because it's what saves a deadline: DANGER ZONE
    const row = n.row === 5 ? R.ahead : tag === 'final' ? R.final : tag === 'danger' || sab ? R.danger : R.deadline;
    if (sab && row > R.danger) continue;
    const per = n.min / n.units, max = Math.max(1, m.maxBlockUnits || n.units);
    for (let left = n.units; left > 0; left -= max) { const u = Math.min(max, left); add(m, row, u, u * per); }
  }
  // the big goals, up to their weekly targets; others up to theirs
  const capOf = (m: Mission) => Math.max(m.dailyCapMin || 0, ...Object.values(m.capByLevel || {})) || 120;
  // waits on a task that isn't finished, or whose waiting period (e.g. grading) hasn't run out by this date
  const waitsOnOpen = (m: Mission) => [...(m.after || []).map((a) => [a, 1] as const), ...(m.afterNoWait || []).map((a) => [a, 0] as const)].some(([a, w]) => {
    const p = byId.get(a); if (!p || p.kind !== 'work') return false;
    if ((p.unitsLeft ?? 0) > 0) return true;
    return !!w && !!p.clock && !!p.doneAt && diffDays(p.doneAt, date) < (p.waitDays || 0);
  });
  const extra: Mission[] = [];
  if (!sab) for (const m of s.missions) {
    if (m.archived || m.kind === 'habit' || m.kind === 'chore' || m.errand || (m.notBefore && date < m.notBefore) || waitsOnOpen(m)) continue;
    if (m.kind === 'work' && unitsLeftNow(m) <= 0) continue;
    const isDl = m.kind === 'work' && !isBig(m) && !!s.objectives.find((o) => o.id === m.objectiveId)?.due;
    if (isDl) { extra.push(m); continue; }
    const target = isBig(m) ? weeklyTarget(s, m, date, exCap) : m.weeklyMin || 0;
    const counted = isBig(m) && m.pace ? m.pace.count.filter((id) => byId.get(id)?.kind !== 'habit') : [m.id];
    const todayDone = s.logs.filter((l) => l.missionId === m.id && l.date === date && l.end > 0).reduce((a, l) => a + logMin(l), 0);
    let min = Math.min(capOf(m) - todayDone, Math.max(0, target - weekDone(counted.length ? counted : [m.id])) / daysLeftInWeek());
    if (isExercise(m)) min = Math.min(min, Math.max(0, exCap - exerciseMinWeek(s, ws)) / daysLeftInWeek());
    const u1 = unit(m);
    if (min >= Math.min(15, u1) * 0.6) {
      const units = m.kind === 'work' ? Math.max(1, Math.round(min / u1)) : 1;
      const len = m.kind === 'work' ? units * u1 : Math.max(Math.min(u1, capOf(m)), Math.round(min / 5) * 5);
      if (m.kind !== 'work' && m.sessionMax && len > m.sessionMax) { const n = Math.ceil(len / m.sessionMax); for (let i = 0; i < n; i++) add(m, isBig(m) ? R.big : R.minor, 1, len / n); }
      else add(m, isBig(m) ? R.big : R.minor, units, len + 2 * (m.travel || 0));
    }
    if (!isExercise(m)) extra.push(m);
  }

  // ---- When: success odds for its kind of work at each time of day; one or two untested times a day to learn.
  const odds = successOdds(s, today);
  const typeOf = (m: Mission) => m.energy;
  const openBuckets = [...new Set(slots.flatMap(([a, b]) => { const out: number[] = []; for (let x = a; x < b; x += 15) out.push(bucketOf(x)); return out; }))];
  const explore = new Map<string, number>();
  {
    const cands = needs.filter((n) => n.row >= R.big && !fc.must[n.missionId]).map((n) => byId.get(n.missionId)!).filter((m) => openBuckets.some((b) => odds.n(typeOf(m), b) < 6));
    const h = hash(date);
    for (let i = 0; i < Math.min(2, cands.length); i++) {
      const m = cands[(h + i * 7) % cands.length];
      if (explore.has(m.id)) continue;
      const b = openBuckets.filter((x) => odds.n(typeOf(m), x) < 6).sort((x, y) => odds.n(typeOf(m), x) - odds.n(typeOf(m), y))[0];
      explore.set(m.id, b);
    }
  }
  const sun = s.settings.sun ? sunTimes(date, s.settings.sun.lat, s.settings.sun.lon) : null;
  const deps = (id: string) => { const m = byId.get(id); return [...(m?.after || []), ...(m?.afterNoWait || [])].filter((x) => x !== id); };
  const allDeps = (id: string, seen = new Set<string>()): Set<string> => { for (const d of deps(id)) if (!seen.has(d)) { seen.add(d); allDeps(d, seen); } return seen; };
  const unplaced = new Set<string>();
  const gap = s.settings.mealGap;

  /** Limits a task can't break: meal waits, daylight, its window, an exam the same day, what it waits on. */
  const limits = (m: Mission) => {
    const ride = !!m.bike && !!m.travel;
    const gapM = m.mealGap ?? (ride && !m.workout ? 60 : gap);
    const waits = m.workout || ride || m.mealGap !== undefined;
    const bigGap = m.workout ? Math.max(gapM, s.settings.bigMealGap) : gapM * 2;
    const forbid: [number, number][] = waits ? fixed.filter((b) => b.kind === 'meal').map((b) => [b.start, b.end + (b.big ? bigGap : gapM)] as [number, number]) : [];
    if (waits && mb0) forbid.push([mb0.start, mb0.end + gapM]); // breakfast is the last part of the morning routine
    let lo = 0, hi = 1e9;
    if (m.daylight && sun) { lo = Math.ceil(sun[0] / 5) * 5; hi = Math.floor(sun[1]); }
    if (m.window) { lo = Math.max(lo, m.window[0]); hi = Math.min(hi, m.window[1]); }
    const o = s.objectives.find((x) => x.id === m.objectiveId);
    if (o?.due === date) { const ex = eventsOn(s, date).filter((e) => e.kind === 'exam'); if (ex.length) hi = Math.min(hi, ...ex.map((e) => e.start - e.travel)); }
    for (const it of items) if (it.missionId && allDeps(m.id).has(it.missionId)) lo = Math.max(lo, it.end);
    return { forbid, lo, hi, outdoor: !!m.outdoor || ride };
  };
  const placeAt = (m: Mission, at: number, len: number, units: number, row: number) => {
    carve(at, len);
    if (len >= 45) slots = slots.map(([x, y]) => (x === at + len ? [x + (s.settings.breakMin ?? 10), y] : [x, y]) as [number, number]).filter(([x, y]) => y - x >= 5);
    const skip = used.get(m.id) || 0;
    used.set(m.id, skip + (m.rotation?.length ? 1 : units));
    items.push({ key: keyFor(m.id), start: at, end: at + len, title: m.title, sub: label(m, Math.round(len), units, skip), detail: detailOf(s, m, skip), kind: 'mission', missionId: m.id, units, baseMin: m.kind === 'work' ? units * m.minutes : m.minutes, min: Math.round(len), ...(row === R.final || row === R.danger ? { must: fc.must[m.id]?.kind ?? 'danger' } : {}) });
  };
  /** Best start for a task, or null. Scored by how often this kind of work gets done then. */
  const best = (m: Mission, len: number, row: number) => {
    const L = limits(m);
    const urgent = (row === R.final || row === R.danger || row === R.deadline) && (!!fc.must[m.id] || [...allDeps(m.id)].length === 0 && needs.some((n) => n.missionId !== m.id && allDeps(n.missionId).has(m.id)));
    const ex = explore.get(m.id);
    let top: { a: number; sc: number } | null = null;
    for (const [x, y] of slots) for (let a = round5(Math.max(x, L.lo)); a + len <= Math.min(y, L.hi); a += 5) {
      if (L.forbid.some(([f0, f1]) => a < f1 && f0 < a + len)) continue;
      const b = bucketOf(a);
      let sc = urgent ? -a / 1440 : odds.rate(typeOf(m), b) + (ex === b ? 1 : 0) - a / 1e6;
      if (L.outdoor && sun && a >= sun[0] && a + len <= sun[1]) sc += 0.3;
      if (m.doneBy !== undefined && a + len > m.doneBy) sc -= 0.5;
      if (m.preferAfter?.some((p) => items.some((i) => i.missionId === p && i.end <= a))) sc += 0.05;
      if (!top || sc > top.sc + 1e-9) top = { a, sc };
    }
    return top;
  };
  // regret: how much a task loses if it can't have its best time of day
  const regret = (n: Need) => { const m = byId.get(n.missionId)!; const r = openBuckets.map((b) => odds.rate(typeOf(m), b)).sort((a, b) => b - a); return (r[0] || 0) - (r[1] ?? 0); };
  const queue = [...needs].sort((a, b) => WEIGHT[b.row] + (byId.get(b.missionId)?.priority || 0) - WEIGHT[a.row] - (byId.get(a.missionId)?.priority || 0) || regret(b) - regret(a));
  let chores = false; // chore steps are due-today work: on the clock right after FINAL SHOT work
  while (queue.length) {
    const i = Math.max(0, queue.findIndex((n) => [...allDeps(n.missionId)].every((d) => !queue.some((q) => q.missionId === d))));
    const n = queue.splice(i, 1)[0];
    if (!chores && n.row > R.final) { placeChores(); chores = true; }
    const m = byId.get(n.missionId)!;
    if ([...allDeps(m.id)].some((d) => unplaced.has(d))) { unplaced.add(m.id); continue; }
    let got = best(m, n.min, n.row);
    // FINAL SHOT work that doesn't fit anywhere else may take Off Duty time
    if (!got && n.row === R.final) {
      const off = fixed.find((b) => b.kind === 'offduty');
      if (off) { const keep = slots; slots = [...slots, [Math.max(off.start, round5(nowMin)), off.end] as [number, number]]; got = best(m, n.min, n.row); if (!got) slots = keep; }
    }
    if (got) { placeAt(m, got.a, n.min, n.units, n.row); continue; }
    // doesn't fit whole: work splits across the gaps that are left (15 min or more)
    if (m.kind !== 'work' || n.units < 2 || m.travel) { unplaced.add(m.id); continue; }
    let left = n.units;
    const per = n.min / n.units;
    while (left > 0) {
      let ok = false;
      for (let u = left; u >= 1 && u * per >= 15; u--) { const g = best(m, Math.round(u * per), n.row); if (g) { placeAt(m, g.a, Math.round(u * per), u, n.row); left -= u; ok = true; break; } }
      if (!ok) break;
    }
    if (left > 0) unplaced.add(m.id);
  }
  if (!chores) placeChores();
  // ---- Fill what's left of the day: more of the big goals, then smaller ones, then getting further ahead.
  if (!sab) {
    const order = extra.sort((a, b) => Number(isBig(b)) - Number(isBig(a)) || (b.priority || 0) - (a.priority || 0) || Number(!s.objectives.find((o) => o.id === a.objectiveId)?.due) - Number(!s.objectives.find((o) => o.id === b.objectiveId)?.due));
    for (let guard = 0; guard < 40; guard++) {
      let placed = false;
      for (const m of order) {
        if (unplaced.has(m.id) || (m.skipOn || []).includes(date)) continue;
        const have = items.filter((i) => i.missionId === m.id && !i.done).reduce((a, i) => a + (i.end - i.start), 0) + s.logs.filter((l) => l.missionId === m.id && l.date === date && l.end > 0).reduce((a, l) => a + logMin(l), 0);
        const room = capOf(m) - have;
        const u1 = unit(m);
        if (room < Math.min(15, u1)) continue;
        const piece = Math.min(room, m.sessionMax || Math.max(u1, 30));
        let units = 1, len = piece;
        if (m.kind === 'work') {
          const leftU = unitsLeftNow(m) - (used.get(m.id) || 0) + (run?.missionId === m.id ? run.units : 0);
          units = Math.min(leftU, m.maxBlockUnits || 2, Math.max(1, Math.floor(piece / u1)));
          if (units < 1 || units * u1 > room + 1) continue;
          len = units * u1;
        }
        len += 2 * (m.travel || 0);
        const g = best(m, Math.round(len), R.extra);
        if (g) { placeAt(m, g.a, Math.round(len), units, R.extra); placed = true; }
      }
      if (!placed) break;
    }
  }
  // blocks land out of order (best times), so name each task's blocks in time order
  for (const id of used.keys()) {
    const m = byId.get(id);
    if (!m || !((m.kind === 'work' && (m.labels?.length || m.unitName)) || m.rotation?.length)) continue;
    let skip = (run?.missionId === id ? (m.rotation?.length ? 1 : run.units) : 0) + (pre.get(id) || 0) * (m.rotation?.length ? 0 : 1);
    for (const it of items.filter((x) => x.missionId === id && !x.done && !x.running && x.units && x.step === undefined).sort((x, y) => x.start - y.start)) {
      it.sub = label(m, it.min || 0, it.units!, skip);
      if (m.rotation?.length) it.detail = detailOf(s, m, skip);
      skip += m.rotation?.length ? 1 : it.units!;
    }
  }
  return finish(items, isToday, nowMin);

  /** Chores with steps: each step needs him home; the time between steps is free. */
  function placeChores() {
    for (const m of s.missions) {
      if (m.kind !== 'chore' || m.archived) continue;
      const steps = m.steps?.length ? m.steps : [{ at: 0, min: m.minutes, title: m.title }];
      const ls = s.logs.filter((l) => l.missionId === m.id && l.date === date && l.step !== undefined);
      const doneAt = new Map<number, number>();
      for (const l of ls) if (l.done) doneAt.set(l.step!, Math.max(doneAt.get(l.step!) ?? 0, minsOf(l.end)));
      if (doneAt.has(steps.length - 1)) continue;
      const first = ls.filter((l) => l.step === 0).sort((x, y) => x.start - y.start)[0];
      let anchor = first ? minsOf(first.start) : run?.missionId === m.id && run.step === 0 ? minsOf(run.startedAt) : -1;
      if (anchor < 0) {
        const due = choreDue(s, m);
        if (!due || due > date) continue;
        const offB = fixed.find((x) => x.kind === 'offduty')!;
        const free = [...slots, [offB.start, offB.end] as [number, number]];
        const wake = mb0?.start ?? 0, span = steps[steps.length - 1].at + steps[steps.length - 1].min;
        for (let t = Math.max(round5(nowMin), wake); t + span <= offB.end; t += 5) if (steps.every((st) => free.some(([x, y]) => x <= t + st.at && t + st.at + st.min <= y))) { anchor = t; break; }
        if (anchor < 0) continue;
      }
      let prevEnd = anchor, prevAt = 0;
      steps.forEach((st, i) => {
        if (doneAt.has(i)) { prevEnd = doneAt.get(i)!; prevAt = st.at + st.min; return; }
        if (run?.missionId === m.id && run.step === i) return;
        const want = i === 0 ? anchor : Math.max(prevEnd + (st.at - prevAt), round5(nowMin));
        const slot = i === 0 ? null : slots.find(([x, y]) => y - Math.max(x, want) >= st.min);
        const at = slot ? Math.max(slot[0], want) : want;
        prevEnd = at + st.min; prevAt = st.at + st.min;
        carve(at, st.min);
        items.push({ key: `c:${m.id}:${i}`, start: at, end: at + st.min, title: st.title, sub: `${st.min} min · step ${i + 1} of ${steps.length}`, detail: 'Be home for each step. The time between steps is free.', kind: 'mission', missionId: m.id, units: 1, baseMin: st.min, min: st.min, step: i });
      });
    }
  }
}

function finish(items: PlanItem[], isToday: boolean, nowMin: number): PlanItem[] {
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  const cur = !isToday ? undefined : items.find((i) => i.running)
    || items.find((i) => !i.done && !i.past && i.block?.kind !== 'note' && i.start <= nowMin + 5 && i.end > nowMin)
    || items.find((i) => i.kind === 'mission' && !i.done && i.start <= nowMin && nowMin < i.start + GRACE);
  if (cur) cur.now = true;
  return items;
}

/** An event he lets the app time: the earliest start in its window that still fits the floor, FINAL STAND work and meals at home. */
function flexDay(s: State, fc: Forecast, date: string, now: number, flex: Evt): PlanItem[] {
  const [lo, hi] = flex.leaveWindow!, len = flex.end - flex.start;
  const at = (start: number): State => ({ ...s, events: s.events.map((e) => (e.id === flex.id ? { ...e, start, end: Math.max(start + 1, start + len), leaveWindow: undefined } : e)) });
  const floor = habitsDue(s, date).filter(isFloor).map((m) => m.id);
  const others = eventsOn(s, date).filter((e) => e.id !== flex.id);
  const clash = (t: number) => others.some((e) => t - flex.travel < e.end + (e.travelBack ?? e.travel) && e.start - e.travel < t + len);
  for (let t = lo; t <= hi; t += 15) {
    if (clash(t) && t + 15 <= hi) continue;
    const items = layoutDay(at(t), fc, date, now);
    const fl = items.find((i) => i.block?.evtId === flex.id && i.block.kind === 'event');
    const mealOut = items.some((i) => i.block?.kind === 'note' && i.block.meal && fl && i.start < fl.start && !flex.meals?.includes(i.block.meal));
    const ok = !mealOut && floor.every((id) => items.some((i) => i.missionId === id)) && Object.keys(fc.must).every((id) => items.some((i) => i.missionId === id));
    if (ok || t + 15 > hi) return items;
  }
  return layoutDay(at(hi), fc, date, now);
}

/** First start today at or after `fromMin` with `len` free minutes, around fixed blocks and today's planned blocks. */
export function nextGap(s: State, date: string, fromMin: number, len: number): number | null {
  let slots = freeSlots(fixedBlocks(s, date), round5(fromMin));
  for (const p of s.days[date]?.plan?.items || []) slots = slots.flatMap(([a, b]) => (p.end <= a || p.start >= b ? [[a, b]] : [[a, p.start], [p.end, b]]).filter(([x, y]) => y - x >= 5) as [number, number][]);
  const g = slots.find(([a, b]) => b - a >= len);
  return g ? g[0] : null;
}
