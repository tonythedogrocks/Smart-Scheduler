import type { State, Mission, Level, Objective } from './types';
import { addDays, dateOf, diffDays, minsOf, weekStart, weekday } from './time';
import { energyBetween, predictedCurve } from './energy';
import { eventsOn, fixedBlocks, freeSlots, isRest, sunTimes, type Block } from './schedule';
import { afterStats, weekdayFactor, learnedLevel, capacityAt, choreDue, exerciseCeiling, exerciseMinWeek, factor, flareSpike, isExercise, partOf, predictLevel, workMinOn } from './learn';

export interface Alloc { missionId: string; units: number; baseMin: number; min: number; habit?: boolean; clock?: boolean; deadline?: boolean; must?: boolean }
export interface DayAlloc { date: string; level: number; rest: boolean; blocks: Alloc[]; capMin: number; deadlineMin: number; lock: boolean }
/** Lock-in: deadlines need more than a comfortable day. Which one, roughly how much a day, until when. */
export interface LockIn { objectiveId: string; title: string; perDay: number; until: string; today: number; comfort: number; late: string[] }
export interface Risk { objectiveId: string; title: string; due: string; lands: string | null; note?: string }
export interface Forecast { today: string; days: DayAlloc[]; landing: Record<string, string | null>; risks: Risk[]; eased: boolean; lockIn: LockIn | null }

export interface PlanItem {
  key: string; start: number; end: number; title: string; sub?: string; detail?: string;
  kind: 'mission' | 'fixed';
  missionId?: string; units?: number; baseMin?: number; min?: number; step?: number;
  done?: boolean; running?: boolean; now?: boolean; past?: boolean;
  block?: Block;
}

/**
 * Describe a run of units from their labels: "Chapter 2: lessons 3–5 + chapter quiz",
 * joining groups with " · ". Repeated labels (an item spread over units) show once.
 */
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
/** The labels for the next `units` units of a work mission. */
export function nextLabels(m: Mission, units: number, skip = 0): string[] {
  if (!m.labels?.length) return [];
  const at = m.labels.length - (m.unitsLeft ?? 0) + skip;
  return m.labels.slice(Math.max(0, at), Math.max(0, at) + units);
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const round5 = (x: number) => Math.ceil(x / 5) * 5;

export function habitMin(m: Mission, level: number) { return level >= 5 && m.minutesAt5 ? m.minutesAt5 : m.minutes; }
export function habitTitle(m: Mission, level: number) { return level <= 2 && m.lowTitle ? `${m.title.split(':')[0]}: ${m.lowTitle}` : m.title; }

export function lastDone(s: State, id: string, before?: string): string | null {
  let d: string | null = null;
  for (const l of s.logs) if (l.missionId === id && l.done && (!before || l.date < before) && (!d || l.date > d)) d = l.date;
  return d;
}

/** Habits that make up the floor on a given day and level. */
export function habitsDue(s: State, date: string, level: number, last?: Map<string, string | null>): Mission[] {
  const sab = isRest(s, date);
  return s.missions.filter((m) => {
    if (m.kind !== 'habit' || m.archived || level < m.minLevel) return false;
    if (m.days && !m.days.includes(weekday(date))) return false;
    if (sab && !m.restOk) return false;
    if (m.everyDays && m.everyDays > 1) {
      const ld = last ? last.get(m.id) ?? null : lastDone(s, m.id, date);
      if (ld && diffDays(ld, date) < m.everyDays) return false;
    }
    return true;
  });
}

/** Share of a day that keeps pace with real deadlines; the rest is weighed across every goal. */
const PACE_SHARE = 0.8;

let memo: { k: string; v: Forecast } | null = null;

/**
 * Horizon plan. Walks forward day by day, giving each day's capacity to the goals where it
 * matters most, and reports when each Objective lands. Today uses the real level; later days
 * use the modest baseline, so good days build a hidden buffer and bad days spend it.
 */
export function forecast(s: State, now: number): Forecast {
  const today = dateOf(now);
  const k = `${s.updatedAt}|${Math.floor(now / 300000)}`;
  if (memo && memo.k === k) return memo.v;

  const live = s.missions.filter((m) => !m.archived);
  const byId = new Map(live.map((m) => [m.id, m]));
  const f = new Map(live.map((m) => [m.id, factor(s, m.id)]));
  const unit = (m: Mission) => m.minutes * f.get(m.id)!;
  const units0 = new Map(live.filter((m) => m.kind === 'work').map((m) => [m.id, m.unitsLeft ?? 0]));
  const done0 = new Map<string, number>(); // day index a work mission completes
  for (const m of live) if (m.kind === 'work' && (m.unitsLeft ?? 0) <= 0) done0.set(m.id, m.doneAt ? diffDays(today, m.doneAt) : -999);
  const run = s.running;
  if (run && units0.has(run.missionId)) units0.set(run.missionId, Math.max(0, units0.get(run.missionId)! - run.units));
  const objs = s.objectives.filter((o) => !o.done);
  const dues = objs.filter((o) => o.due).map((o) => diffDays(today, o.due!));
  const H = clamp(Math.max(14, ...dues.map((d) => d + 30)), 14, 150);
  const eased = flareSpike(s, now);
  const exCap = exerciseCeiling(s, today).cap;
  const wk = (id: string, date: string) => `${id}|${weekStart(date)}`;

  // Days a mission must be finished ahead of its Objective's deadline, because of waiting periods downstream.
  const tailMemo = new Map<string, number>();
  const tail = (m: Mission): number => {
    if (tailMemo.has(m.id)) return tailMemo.get(m.id)!;
    tailMemo.set(m.id, 0);
    const succ = live.filter((x) => (x.after || []).includes(m.id));
    const v = (m.clock ? m.waitDays || 0 : 0) + Math.max(0, ...succ.map(tail));
    tailMemo.set(m.id, v);
    return v;
  };

  // ---- 1. Each day: free time, routines, comfortable capacity, predicted energy.
  interface DayInfo { date: string; rest: boolean; level: number; avail: number; comfort: number; weight: number; routines: Alloc[] }
  const last = new Map(live.filter((m) => m.kind === 'habit').map((m) => [m.id, lastDone(s, m.id)]));
  const infos: DayInfo[] = [];
  for (let t = 0; t <= H; t++) {
    const date = addDays(today, t);
    const rest = isRest(s, date);
    const real = s.days[date]?.level;
    const level = t === 0 && real ? real : predictLevel(s, date, today);
    const paceLevel = t === 0 || real ? level : learnedLevel(s, date, today);
    const fixed = fixedBlocks(s, date);
    const from = t === 0 ? round5(minsOf(now)) : 0;
    const slots = freeSlots(fixed, from);
    let freeMin = slots.reduce((a, [x, y]) => a + (y - x), 0);
    if (t === 0 && run) freeMin -= Math.max(0, run.plannedMin * (f.get(run.missionId) || 1) - (now - run.startedAt) / 60000);
    const routines: Alloc[] = [];
    for (const m of habitsDue(s, date, level, last)) {
      const doneToday = t === 0 && s.logs.some((l) => l.missionId === m.id && l.date === date && l.done);
      if (doneToday || (t === 0 && run?.missionId === m.id)) continue;
      const base = habitMin(m, level), min = Math.round(base * f.get(m.id)!);
      routines.push({ missionId: m.id, units: 1, baseMin: base, min, habit: true });
      freeMin -= min;
      if (t > 0 && m.everyDays) last.set(m.id, date);
    }
    // things pinned to this date are reserved first, whatever the level
    for (const m of live) {
      if (m.onDate !== date || m.kind !== 'work' || (units0.get(m.id) || 0) <= 0) continue;
      const min = Math.round(unit(m)) + 2 * (m.travel || 0);
      routines.push({ missionId: m.id, units: 1, baseMin: m.minutes, min, must: true });
      freeMin -= min;
    }
    let comfort = capacityAt(s, level, today, t === 0) * (t === 0 ? 1 : weekdayFactor(s, today, weekday(date)));
    if (t === 0) comfort -= workMinOn(s, date) + (run && byId.get(run.missionId)?.kind !== 'habit' ? run.plannedMin : 0);
    const avail = Math.max(0, freeMin);
    comfort = Math.max(0, Math.min(comfort, avail));
    // pacing judges unreported days at their predicted level, never the optimistic preview level
    const curve = predictedCurve(s, date, paceLevel, today);
    const span = slots.length ? energyBetween(curve, slots[0][0], slots[slots.length - 1][1]) : 0;
    // Deadline pacing weighs days not reported yet at the level predicted from his history; how a future
    // day looks (its room, its timeline) uses the optimistic preview level.
    const paceComfort = t === 0 || real ? comfort : Math.min(avail, capacityAt(s, paceLevel, today) * weekdayFactor(s, today, weekday(date)));
    const weight = rest || avail <= 0 ? 0 : Math.max(paceComfort, avail * 0.25) * span;
    infos.push({ date, rest, level, avail, comfort, weight, routines });
  }

  // ---- 2. Deadline work: paced across the whole horizon toward a safe date before each due date.
  const deadlineObjs = objs.filter((o) => o.due && live.some((m) => m.objectiveId === o.id && m.kind === 'work' && !m.errand));
  const safeOf = new Map<string, number>();
  for (const o of deadlineObjs) {
    const dueIdx = diffDays(today, o.due!);
    const maxTail = Math.max(0, ...live.filter((m) => m.objectiveId === o.id && m.kind === 'work' && (units0.get(m.id) || 0) > 0).map(tail));
    const buffer = Math.max(1, Math.round(0.1 * Math.max(0, dueIdx)));
    safeOf.set(o.id, Math.max(0, dueIdx - buffer - maxTail));
  }
  const order = [...deadlineObjs].sort((x, y) => safeOf.get(x.id)! - safeOf.get(y.id)!);
  const avgW = infos.reduce((a, d) => a + d.weight, 0) / Math.max(1, infos.length);

  interface Sim { units: Map<string, number>; doneIdx: Map<string, number>; days: { blocks: Alloc[]; deadline: number; perObj: Map<string, number> }[] }
  const simulate = (boost: Map<string, number>, riskSet: Set<string>): Sim => {
    const units = new Map(units0), doneIdx = new Map(done0), owed = new Map<string, number>();
    const available = (m: Mission, t: number) => (!m.notBefore || addDays(today, t) >= m.notBefore)
      && (m.afterNoWait || []).every((a) => !byId.get(a) || (doneIdx.get(a) !== undefined && doneIdx.get(a)! <= t)) && (m.after || []).every((a) => {
        const pre = byId.get(a);
        if (!pre) return true;
        const d = doneIdx.get(a);
        return d !== undefined && d + (pre.clock ? pre.waitDays || 0 : 0) <= t;
      });
    const remaining = (oid: string) => live.filter((m) => m.objectiveId === oid && m.kind === 'work').reduce((a, m) => a + (units.get(m.id) || 0) * unit(m), 0);
    const out: Sim['days'] = [];
    for (let t = 0; t <= H; t++) {
      const d = infos[t];
      let left = d.avail;
      const blocks: Alloc[] = [], perObj = new Map<string, number>();
      for (const o of order) {
        const rem = remaining(o.id);
        if (rem <= 0) continue;
        const dueIdx = diffDays(today, o.due!);
        // Recovery day today: only work due within a day, or at risk
        if (t === 0 && d.level < 1.5 && dueIdx > 1 && !riskSet.has(o.id)) continue;
        const ready = () => live.filter((m) => m.objectiveId === o.id && m.kind === 'work' && !m.errand && (units.get(m.id) || 0) > 0 && available(m, t) && (!d.rest || m.restOk))
          .sort((a, b) => Number(!!b.clock) - Number(!!a.clock) || tail(b) - tail(a));
        if (!ready().length) continue;
        const safe = safeOf.get(o.id)!;
        let share: number;
        if (t >= safe) share = rem;
        else {
          let denom = 0;
          for (let j = t; j <= Math.min(safe, H); j++) denom += infos[j].weight;
          if (safe > H) denom += (safe - H) * avgW;
          share = denom > 0 ? (rem * d.weight) / denom : rem;
        }
        share = Math.min(left, share * (boost.get(o.id) || 1));
        let ow = Math.min(rem, (owed.get(o.id) || 0) + share);
        // keep going down the chain the same day: finishing one step can unlock the next
        for (let progressed = true; progressed;) {
          progressed = false;
          for (const m of ready()) {
            const u1 = unit(m);
            const minChunk = (lft0: number) => Math.min(15, lft0 * u1);
            while ((units.get(m.id) || 0) > 0 && ow >= Math.max(u1 * 0.5, minChunk(units.get(m.id)!)) && left >= Math.max(u1 * 0.5, minChunk(units.get(m.id)!)) && available(m, t)) {
              const lft = units.get(m.id)!;
              let u = Math.max(1, Math.min(m.maxBlockUnits || 3, lft, Math.floor((ow + u1 * 0.5) / u1), Math.floor((left + u1 * 0.5) / u1)));
              if (m.labels?.length) { const at0 = m.labels.length - lft; while (u < lft && m.labels[at0 + u] === m.labels[at0 + u - 1]) u++; }
              const min = Math.round(u * u1);
              blocks.push({ missionId: m.id, units: u, baseMin: u * m.minutes, min, clock: m.clock, deadline: true });
              ow -= min; left -= min; progressed = true;
              perObj.set(o.id, (perObj.get(o.id) || 0) + min);
              units.set(m.id, lft - u);
              if (lft - u <= 0) doneIdx.set(m.id, t);
            }
          }
        }
        owed.set(o.id, Math.max(0, Math.min(ow, rem)));
      }
      out.push({ blocks, deadline: d.avail - left, perObj });
    }
    return { units, doneIdx, days: out };
  };

  const landOf = (sim: Sim, o: Objective): number | null => {
    const ms = live.filter((m) => m.objectiveId === o.id && m.kind === 'work');
    let worst = -999;
    for (const m of ms) {
      const d = sim.doneIdx.get(m.id);
      if (d === undefined) return null;
      worst = Math.max(worst, d + (m.clock && d >= 0 ? m.waitDays || 0 : 0));
    }
    for (const dep of o.dependsOn || []) {
      const od = s.objectives.find((x) => x.id === dep);
      if (!od || od.done) continue;
      const d = landOf(sim, od);
      if (d === null) return null;
      worst = Math.max(worst, d);
    }
    return worst;
  };
  const late = (sim: Sim) => new Set(objs.filter((o) => {
    if (!o.due) return false;
    const d = landOf(sim, o), dueIdx = diffDays(today, o.due);
    return d === null ? dueIdx <= H && (live.some((m) => m.objectiveId === o.id && m.kind === 'work') || !!o.dependsOn?.length) : d > dueIdx;
  }).map((o) => o.id));

  // ---- 3. Risk feeds back: raise the share of anything landing late, using free time, until it lands or there's no room left.
  const boost = new Map<string, number>();
  let sim = simulate(boost, new Set());
  let risky = late(sim);
  const landIdx = (x: Sim, id: string) => { const o = s.objectives.find((y) => y.id === id)!; const d = landOf(x, o); return d === null ? 1e9 : d; };
  const frozen = new Set<string>();
  for (let pass = 0; pass < 8 && [...risky].some((id) => !frozen.has(id)); pass++) {
    const tryBoost = new Map(boost);
    const lifted: string[] = [];
    for (const id of risky) {
      if (frozen.has(id)) continue;
      const o = s.objectives.find((x) => x.id === id)!;
      // a dependent objective is lifted through what it waits on
      for (const x of [id, ...(o.dependsOn || [])]) if ((tryBoost.get(x) || 1) < 8) { tryBoost.set(x, (tryBoost.get(x) || 1) * 1.6); lifted.push(id); }
    }
    if (!lifted.length) break;
    const next = simulate(tryBoost, risky);
    let helped = false;
    for (const id of new Set(lifted)) {
      if (landIdx(next, id) < landIdx(sim, id)) helped = true;
      else frozen.add(id); // pushing harder doesn't pull it in (waiting periods, prerequisites): stop pushing
    }
    if (!helped) break;
    // keep the extra push only for objectives it actually helped
    for (const [x, v] of tryBoost) {
      const owner = [...new Set(lifted)].find((id) => id === x || (s.objectives.find((o) => o.id === id)?.dependsOn || []).includes(x));
      if (!owner || !frozen.has(owner)) boost.set(x, v);
    }
    sim = simulate(boost, risky);
    risky = late(sim);
  }

  // ---- 4. Compose each day: routines, deadline work, then flexible goals in the comfortable room left.
  const exUsed = new Map<string, number>();
  const exOf = (date: string) => { const w = weekStart(date); if (!exUsed.has(w)) exUsed.set(w, exerciseMinWeek(s, w)); return exUsed.get(w)!; };
  const weekMin = new Map<string, number>();
  for (const l of s.logs) if (l.date >= weekStart(today)) weekMin.set(wk(l.missionId, l.date), (weekMin.get(wk(l.missionId, l.date)) || 0) + (l.end - l.start) / 60000);
  const flexUnits = new Map(sim.units);
  const days: DayAlloc[] = [];
  for (let t = 0; t <= H; t++) {
    const d = infos[t], sd = sim.days[t];
    const blocks: Alloc[] = [...d.routines, ...sd.blocks];
    const lock = sd.deadline > d.comfort + 5;
    let room = lock ? 0 : Math.max(0, Math.min(d.comfort - sd.deadline, d.avail - sd.deadline));
    const usedMis = new Map<string, number>(), usedObj = new Map<string, number>();
    const doneTodayMin = (id: string) => (t === 0 ? s.logs.filter((l) => l.missionId === id && l.date === d.date).reduce((a, l) => a + (l.end - l.start) / 60000, 0) : 0);
    for (let guard = 0; guard < 30 && room >= 10; guard++) {
      let best: { m: Mission; score: number; u: number; min: number } | null = null;
      for (const m of live) {
        if (m.kind === 'habit' || m.kind === 'chore' || Math.ceil(d.level) < m.minLevel) continue;
        if (d.rest && !m.restOk) continue;
        if (m.workout && eased) continue;
        const o = s.objectives.find((x) => x.id === m.objectiveId);
        if (o?.done) continue;
        // flexible goals only: practice, errands, and work with no deadline
        if (m.kind === 'work' && o?.due && !m.errand) continue;
        if (m.notBefore && d.date < m.notBefore) continue;
        if (m.onDate) continue;
        if (m.kind === 'work' && (m.after || []).some((a) => byId.get(a) && (sim.doneIdx.get(a) === undefined || sim.doneIdx.get(a)! > t))) continue;
        const spent = (usedMis.get(m.id) || 0) + doneTodayMin(m.id);
        let score: number, u = 1, min: number;
        if (m.kind === 'work') {
          const lft = flexUnits.get(m.id) || 0;
          if (lft <= 0) continue;
          u = Math.min(m.maxBlockUnits || 3, lft, Math.max(1, Math.floor((room + unit(m) * 0.4) / unit(m))));
          if (m.dailyCapMin) u = Math.min(u, Math.floor((m.dailyCapMin - spent) / unit(m)));
          if (u < 1) continue;
          min = Math.round(u * unit(m)) + 2 * (m.travel || 0);
          score = m.errand ? 5 : 0.3;
        } else {
          if (m.dailyCapMin && spent + m.minutes * 0.5 > m.dailyCapMin) continue;
          min = Math.round(unit(m)) + 2 * (m.travel || 0);
          const wd = weekMin.get(wk(m.id, d.date)) || 0;
          score = 0.6 * Math.max(0.15, 1 - wd / (m.weeklyMin || 120));
        }
        if (min * 0.6 > room) continue;
        if (isExercise(m) && exOf(d.date) + min > exCap) continue;
        score *= Math.pow(0.6, usedObj.get(m.objectiveId) || 0);
        if (!best || score > best.score) best = { m, score, u, min };
      }
      if (!best) break;
      const { m, u, min } = best;
      blocks.push({ missionId: m.id, units: u, baseMin: m.kind === 'work' ? u * m.minutes : m.minutes, min });
      room -= min;
      if (isExercise(m)) exUsed.set(weekStart(d.date), exOf(d.date) + min);
      usedMis.set(m.id, (usedMis.get(m.id) || 0) + min);
      usedObj.set(m.objectiveId, (usedObj.get(m.objectiveId) || 0) + 1);
      if (m.kind === 'work') flexUnits.set(m.id, (flexUnits.get(m.id) || 0) - u);
      else weekMin.set(wk(m.id, d.date), (weekMin.get(wk(m.id, d.date)) || 0) + min);
    }
    days.push({ date: d.date, level: d.level, rest: d.rest, blocks, capMin: d.comfort, deadlineMin: sd.deadline, lock });
  }

  // ---- 5. Landing dates, risks, and lock-in.
  const landing: Record<string, string | null> = {};
  const risks: Risk[] = [];
  for (const o of objs) {
    const hasWork = live.some((m) => m.objectiveId === o.id && m.kind === 'work') || (o.dependsOn || []).length > 0;
    if (!hasWork) continue;
    const d = landOf(sim, o);
    landing[o.id] = d === null ? null : addDays(today, Math.max(0, d));
    if (risky.has(o.id)) risks.push({ objectiveId: o.id, title: o.title, due: o.due!, lands: landing[o.id], note: o.riskNote });
  }
  let lockIn: LockIn | null = null;
  if (days[0].lock || risks.length) {
    const share = sim.days[0].perObj;
    const top = [...share.entries()].sort((a, b) => b[1] - a[1])[0];
    const o = top ? s.objectives.find((x) => x.id === top[0]) : risks[0] && s.objectives.find((x) => x.id === risks[0].objectiveId);
    if (o) {
      const safe = Math.min(safeOf.get(o.id) ?? 0, H);
      let tot = 0, n = 0;
      for (let t = 0; t <= safe; t++) if (!infos[t].rest) { tot += sim.days[t].perObj.get(o.id) || 0; n++; }
      lockIn = { objectiveId: o.id, title: o.title, perDay: Math.round(tot / Math.max(1, n)), until: addDays(today, safe), today: Math.round(sim.days[0].deadline), comfort: Math.round(infos[0].comfort), late: risks.map((r) => r.title) };
    }
  }
  const v = { today, days, landing, risks, eased, lockIn };
  memo = { k, v };
  return v;
}

/** Which session of a rotation is next (skip = sessions already placed earlier today). */
export function rotationAt(s: State, m: Mission, skip = 0) {
  const r = m.rotation!;
  const done = s.logs.filter((l) => l.missionId === m.id && l.done).length;
  return r[(done + skip) % r.length];
}
const detailOf = (s: State, m: Mission, skip = 0) => (m.rotation?.length ? [rotationAt(s, m, skip).detail, m.note].filter(Boolean).join('\n\n') : m.note);

/** Minutes of grace before an unstarted block counts as missed. */
export const GRACE = 5;

/**
 * What today's fixed plan depends on. If any of it changes (level, commitments, meals, cooking,
 * a miss, the morning routine finishing, missions added or retired), the plan is rebuilt. Starting,
 * finishing or stopping a block does not change it, so the rest of the day stays put.
 */
/** Short fingerprint of how every task is set up (length, travel, meal gaps, windows...), leaving out
 * what doing the work changes (units left, finished date), so editing a task re-plans but working doesn't. */
function missionsHash(s: State): string {
  const txt = JSON.stringify(s.missions.filter((m) => !m.archived).map(({ unitsLeft, doneAt, t, ...rest }) => rest));
  let h = 0;
  for (let i = 0; i < txt.length; i++) h = (h * 31 + txt.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function planSig(s: State, date: string): string {
  const d = s.days[date] || {};
  return JSON.stringify([d.level, d.morningEnd ? 1 : 0, eventsOn(s, date).map((e) => [e.id, e.start, e.end, e.travel]), d.ate, d.cook, d.cookAt, d.cookStart ? 1 : 0, d.cookEnd ? 1 : 0, d.dinnerAt, d.lunchAt, d.lunchMin, d.dinnerMin, d.starts, (d.misses || []).length,
    s.missions.filter((m) => !m.archived).map((m) => m.id).join(','), s.settingsT || 0, missionsHash(s)]);
}

/** Lay a day's allocation onto the clock. Today is laid from "now"; nothing is ever overdue. */
export function layoutDay(s: State, fc: Forecast, date: string, now: number): PlanItem[] {
  const today = fc.today;
  const fixed = fixedBlocks(s, date);
  const isToday = date === today;
  const nowMin = isToday ? minsOf(now) : date < today ? 1e9 : -1;
  // Today the morning routine isn't over until he taps Done: it runs on to now, and nothing starts before it ends.
  const morningOpen = isToday && !s.days[date]?.morningEnd;
  if (morningOpen) { const mb = fixed.find((b) => b.key === 'f:morning'); if (mb && mb.end < round5(nowMin)) mb.end = round5(nowMin); }
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  const items: PlanItem[] = fixed.map((b) => ({ key: b.key, start: b.start, end: b.end, title: b.title, sub: b.sub, kind: 'fixed' as const, block: b, past: b.end <= nowMin && b.kind !== 'note' && !(morningOpen && b.key === 'f:morning') }));
  const occ = new Map<string, number>();
  const keyFor = (id: string) => { const n = occ.get(id) || 0; occ.set(id, n + 1); return `m:${id}:${n}`; };
  const level = s.days[date]?.level ?? fc.days.find((d) => d.date === date)?.level ?? 3;
  const usedUnits = new Map<string, number>();
  const label = (m: Mission, min: number, units: number, skip = 0) => {
    const bits: string[] = [];
    if (m.rotation?.length) bits.push(rotationAt(s, m, skip).title);
    const named = m.kind === 'work' ? nextLabels(m, units, skip) : [];
    if (named.length) bits.push(describeUnits(named));
    else if (m.kind === 'work' && m.unitName && m.unitsTotal) {
      const at = m.unitsTotal - (m.unitsLeft || 0) + 1;
      bits.push(units > 1 ? `${m.unitName}s ${at} to ${Math.min(m.unitsTotal, at + units - 1)} of ${m.unitsTotal}` : `${m.unitName} ${Math.min(at, m.unitsTotal)} of ${m.unitsTotal}`);
    }
    bits.push(m.kind === 'habit' ? `${min} min` : `about ${min} min`);
    if (m.energy !== 'none' && m.kind === 'habit') bits.push(m.energy[0].toUpperCase() + m.energy.slice(1));
    return bits.join(' · ');
  };

  for (const l of s.logs.filter((x) => x.date === date && x.done && x.end > 0).sort((a, b) => a.start - b.start)) {
    const m = byId.get(l.missionId); if (!m) continue;
    const stepT = l.step !== undefined ? m.steps?.[l.step]?.title : undefined;
    items.push({ key: l.step !== undefined ? `c:${m.id}:${l.step}` : keyFor(m.id), start: minsOf(l.start), end: Math.max(minsOf(l.start) + 1, minsOf(l.end)), title: stepT || (m.kind === 'habit' ? habitTitle(m, l.level ?? level) : m.title), sub: `${Math.max(1, Math.round((l.end - l.start) / 60000))} min`, detail: m.note, kind: 'mission', missionId: m.id, done: true });
  }
  if (date < today) return items.sort((a, b) => a.start - b.start);
  const tIdx = diffDays(today, date);
  if (!isToday && tIdx !== 1) return items.sort((a, b) => a.start - b.start); // today and tomorrow are planned in full

  let slots = freeSlots(fixed, round5(nowMin));
  /** First start at or after notBefore that fits, avoiding forbidden windows. Does not reserve it. */
  const find = (len: number, notBefore = 0, forbid: [number, number][] = [], notAfter = 1e9): { i: number; a: number } | null => {
    for (let i = 0; i < slots.length; i++) {
      let a = Math.max(slots[i][0], notBefore);
      for (let moved = true; moved;) { moved = false; for (const [f0, f1] of forbid) if (a < f1 && f0 < a + len) { a = f1; moved = true; } }
      if (slots[i][1] - a >= len && a + len <= notAfter) return { i, a };
    }
    return null;
  };
  const carve = (a: number, len: number) => {
    const i = slots.findIndex(([x, y]) => x <= a && a + len <= y);
    if (i < 0) { slots = slots.flatMap(([x, y]) => (y <= a || x >= a + len ? [[x, y]] : [[x, a], [a + len, y]].filter(([p, q]) => q - p >= 5)) as [number, number][]); return; }
    const [x, y] = slots[i], rest: [number, number][] = [];
    if (a - x >= 5) rest.push([x, a]);
    if (y - (a + len) >= 5) rest.push([a + len, y]);
    slots.splice(i, 1, ...rest);
  };
  const stepTitle = (m: Mission, i: number) => (m.steps && m.steps[i] ? m.steps[i].title : m.title);
  const run = isToday ? s.running : undefined;
  // tomorrow's named steps pick up after what today's plan covers
  const preUnits = new Map<string, number>();
  if (!isToday) for (const d of fc.days) { if (d.date >= date) break; for (const b of d.blocks) if (!b.habit) preUnits.set(b.missionId, (preUnits.get(b.missionId) || 0) + (byId.get(b.missionId)?.rotation?.length ? 1 : b.units)); }
  if (run) {
    const m = byId.get(run.missionId);
    if (m) {
      const st = minsOf(run.startedAt);
      const min = Math.round(run.plannedMin * factor(s, m.id));
      const end = Math.max(round5(nowMin), st + min);
      slots = slots.flatMap(([a, b]) => (b <= end ? [] : [[Math.max(a, end), b] as [number, number]]));
      const title = run.step !== undefined ? stepTitle(m, run.step) : m.kind === 'habit' ? habitTitle(m, level) : m.title;
      items.push({ key: run.step !== undefined ? `c:${m.id}:${run.step}` : keyFor(m.id), start: st, end, title, sub: label(m, min, run.units), detail: detailOf(s, m), kind: 'mission', missionId: m.id, units: run.units, baseMin: run.plannedMin, min, step: run.step, running: true });
    }
  }

  if (run) usedUnits.set(run.missionId, run.units);
  for (const [k2, v2] of preUnits) if (!usedUnits.has(k2)) usedUnits.set(k2, v2);

  // Chores with steps: every step needs you home, the time between steps is free.
  for (const m of s.missions) {
    if (m.kind !== 'chore' || m.archived || (isRest(s, date) && !m.restOk)) continue;
    const steps = m.steps?.length ? m.steps : [{ at: 0, min: m.minutes, title: m.title }];
    const doneSteps = new Set(s.logs.filter((l) => l.missionId === m.id && l.date === date && l.done && l.step !== undefined).map((l) => l.step!));
    if (doneSteps.has(steps.length - 1)) continue;
    const first = s.logs.filter((l) => l.missionId === m.id && l.date === date && l.step === 0).sort((x, y) => x.start - y.start)[0];
    let anchor = -1;
    if (first) anchor = minsOf(first.start);
    else if (run?.missionId === m.id && run.step === 0) anchor = minsOf(run.startedAt);
    else {
      const due = choreDue(s, m);
      if (!due || due > date) continue;
      const off = fixed.find((x) => x.kind === 'offduty')!.start;
      for (let t = round5(nowMin); t + steps[steps.length - 1].at + steps[steps.length - 1].min <= off; t += 5) {
        if (steps.every((st) => slots.some(([x, y]) => x <= t + st.at && t + st.at + st.min <= y))) { anchor = t; break; }
      }
      if (anchor < 0) continue; // no stretch at home long enough today: it waits, quietly
    }
    steps.forEach((st, i) => {
      if (doneSteps.has(i) || (run?.missionId === m.id && run.step === i)) return;
      const at = Math.max(anchor + st.at, i === 0 ? 0 : round5(nowMin));
      carve(at, st.min);
      items.push({ key: `c:${m.id}:${i}`, start: at, end: at + st.min, title: st.title, sub: `${st.min} min · step ${i + 1} of ${steps.length}`, detail: 'Be home for each step. The time between steps is free.', kind: 'mission', missionId: m.id, units: 1, baseMin: st.min, min: st.min, step: i });
    });
  }

  const day = fc.days.find((d) => d.date === date)!;
  const gap = s.settings.mealGap;
  // Learned patterns, used only once they're confident.
  const avoid = new Map<string, Set<string>>();
  for (const a of afterStats(s)) if (a.worse) (avoid.get(a.energy) || avoid.set(a.energy, new Set()).get(a.energy)!).add(a.after);
  const evKind = new Map(s.events.map((e) => [e.id, e.kind === 'event' || e.kind === 'exam' ? 'event' : e.kind]));
  const catOf = (it: PlanItem): string | null => {
    if (it.kind === 'fixed') return it.block?.evtId && it.block.kind !== 'travel' ? evKind.get(it.block.evtId) || null : null;
    const m = it.missionId ? byId.get(it.missionId) : undefined;
    return !m || m.energy === 'none' || m.kind === 'chore' ? null : isExercise(m) ? 'workout' : m.energy;
  };
  // Hardest work first, into the highest predicted energy; routines and light work go in the dips.
  const curve = predictedCurve(s, date, level, today);
  const hardness = (a: Alloc) => { const m = byId.get(a.missionId); return a.habit || !m ? 0 : (a.deadline ? 3 : 1) + (m.energy === 'mental' ? 1 : 0) + (a.clock ? 0.5 : 0); };
  // anything pinned to today first (it can't move to another day), then routines (into the dips) so the floor fits; then hardest work into the best of what's left
  const order = [...day.blocks].sort((a, b) => Number(!!b.must && !b.habit) - Number(!!a.must && !a.habit) || Number(!!b.habit) - Number(!!a.habit) || Number(!!b.must) - Number(!!a.must) || hardness(b) - hardness(a));
  const sun = s.settings.sun ? sunTimes(date, s.settings.sun.lat, s.settings.sun.lon) : null;
  /** Every start (5-min steps) that fits, scored by predicted energy; hard work takes the best, light work the dips. */
  const pick = (len: number, lo: number, fb: [number, number][], hi: number, light: boolean, outdoor = false): { i: number; a: number } | null => {
    let best: { i: number; a: number; sc: number } | null = null;
    for (let i = 0; i < slots.length; i++) {
      for (let a = Math.max(slots[i][0], lo); a + len <= Math.min(slots[i][1], hi); a += 5) {
        if (fb.some(([f0, f1]) => a < f1 && f0 < a + len)) continue;
        const e = energyBetween(curve, a, a + len);
        // outside: daylight strongly preferred, night still allowed
        const sc = (light ? -e : e) + (outdoor && sun && a >= sun[0] && a + len <= sun[1] ? 10 : 0);
        if (!best || sc > best.sc + 0.01) best = { i, a, sc };
      }
    }
    return best ? { i: best.i, a: best.a } : null;
  };
  for (const a of order) {
    const m = byId.get(a.missionId); if (!m) continue;
    // biking there and back is light cardio: about an hour after a regular meal
    const ride = !!m.bike && !!m.travel;
    const gapM = m.mealGap ?? (ride && !m.workout ? 60 : gap);
    // workouts wait after meals; so do rides and anything with its own meal gap (e.g. a strength routine), doubled after a large meal
    const waits = m.workout || ride || m.mealGap !== undefined;
    const bigGap = m.workout ? Math.max(gapM, s.settings.bigMealGap) : gapM * 2;
    const forbid: [number, number][] = waits ? fixed.filter((b) => b.kind === 'meal').map((b) => [b.start, b.end + (b.big ? bigGap : gapM)] as [number, number]) : [];
    // daylight-only (sunrise to sunset) and errand windows, travel included
    let lo = 0, hi = 1e9;
    if (m.daylight && s.settings.sun) { const [rise, set] = sunTimes(date, s.settings.sun.lat, s.settings.sun.lon); lo = Math.ceil(rise / 5) * 5; hi = Math.floor(set); }
    if (m.window) { lo = Math.max(lo, m.window[0]); hi = Math.min(hi, m.window[1]); }
    const bad = !a.habit ? avoid.get(m.energy) : undefined;
    const soft: [number, number][] = [];
    if (bad) for (const it of items) { const c = catOf(it); if (c && bad.has(c)) soft.push([it.end, it.end + 45]); }
    let got: { i: number; a: number } | null = null;
    const light = (!!a.habit || m.energy === 'none') && !a.must;
    for (const fb of soft.length ? [[...forbid, ...soft], forbid] : [forbid]) {
      got = pick(a.min, lo, fb, hi, light, !!m.outdoor);
      if (got) break;
    }
    const placeAt = (at: number, units: number, len: number) => {
      carve(at, len);
      if (!a.habit && len >= 45) {
        // breathing room after a real block
        slots = slots.map(([x, y]) => (x === at + len ? [x + s.settings.breakMin, y] : [x, y]) as [number, number]).filter(([x, y]) => y - x >= 5);
      }
      const skip = usedUnits.get(m.id) || 0;
      usedUnits.set(m.id, skip + units);
      items.push({ key: keyFor(m.id), start: at, end: at + len, title: a.habit ? habitTitle(m, level) : m.title, sub: label(m, len, units, skip), detail: detailOf(s, m, skip), kind: 'mission', missionId: m.id, units, baseMin: Math.round(a.baseMin * units / Math.max(1, a.units)), min: len });
    };
    if (got) { placeAt(got.a, a.units, a.min); continue; }
    // Doesn't fit whole: split goal work across the gaps that are left (pieces of 15 min or more), instead of dropping it.
    if (m.kind !== 'work' || a.units < 2 || m.travel) continue; // the rest goes back to the pool, silently
    const unitLen = a.min / a.units;
    let left = a.units;
    while (left > 0) {
      let placed = false;
      for (let u = left; u >= 1; u--) {
        const len = Math.round(u * unitLen);
        if (len < 15) break;
        const g = find(len, lo, forbid, hi);
        if (g) { placeAt(g.a, u, len); left -= u; placed = true; break; }
      }
      if (!placed) break;
    }
  }
  // Blocks can land out of planning order (best times, gaps), so name each mission's blocks in time order.
  for (const id of usedUnits.keys()) {
    const m = byId.get(id);
    if (!m || !((m.kind === 'work' && m.labels?.length) || m.rotation?.length)) continue;
    let skip = run?.missionId === id ? (m.rotation?.length ? 1 : run.units) : preUnits.get(id) || 0;
    for (const it of items.filter((x) => x.missionId === id && !x.done && !x.running && x.units).sort((x, y) => x.start - y.start)) {
      it.sub = label(m, it.min || 0, it.units!, skip);
      if (m.rotation?.length) it.detail = detailOf(s, m, skip);
      skip += m.rotation?.length ? 1 : it.units!;
    }
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  // Once the day has started, keep today's plan as it was fixed: only what changed since (done, running) differs.
  const stored = isToday && !morningOpen ? s.days[date]?.plan : undefined;
  if (stored && stored.sig === planSig(s, date)) {
    const keep = items.filter((i) => i.kind !== 'mission' || i.done || i.running);
    const have = new Set(keep.filter((i) => i.kind === 'mission').map((i) => i.key));
    for (const p of stored.items) if (!have.has(p.key)) keep.push({ ...p, kind: 'mission' });
    items.length = 0; items.push(...keep);
    items.sort((a, b) => a.start - b.start || a.end - b.end);
  }
  const cur = !isToday ? undefined : items.find((i) => i.running)
    || items.find((i) => !i.done && !i.past && i.block?.kind !== 'note' && i.start <= nowMin + 5 && i.end > nowMin)
    || items.find((i) => i.kind === 'mission' && !i.done && !i.running && i.start <= nowMin && nowMin < i.start + GRACE); // a little late: still this one
  if (cur) cur.now = true;
  return items;
}

/**
 * Today's routines the app's own rules kept out: not placed although a free gap long enough
 * exists (so a rule like a meal gap or daylight blocked it, not running out of day).
 */
export function excusedHabits(s: State, now: number): Set<string> {
  const date = dateOf(now);
  const fc = forecast(s, now);
  const placed = new Set(layoutDay(s, fc, date, now).filter((i) => i.kind === 'mission').map((i) => i.missionId));
  const slots = freeSlots(fixedBlocks(s, date), round5(minsOf(now)));
  const out = new Set<string>();
  for (const b of fc.days[0].blocks) if (b.habit && !placed.has(b.missionId) && slots.some(([a, c]) => c - a >= b.min)) out.add(b.missionId);
  return out;
}

/** First start time today at or after `fromMin` with `len` free minutes, around fixed blocks and today's planned blocks. */
export function nextGap(s: State, date: string, fromMin: number, len: number): number | null {
  let slots = freeSlots(fixedBlocks(s, date), round5(fromMin));
  for (const p of s.days[date]?.plan?.items || []) slots = slots.flatMap(([a, b]) => (p.end <= a || p.start >= b ? [[a, b]] : [[a, p.start], [p.end, b]]).filter(([x, y]) => y - x >= 5) as [number, number][]);
  const g = slots.find(([a, b]) => b - a >= len);
  return g ? g[0] : null;
}

/** Orders: the single thing to do now, and what follows. */
export function orders(items: PlanItem[]) {
  const i = items.findIndex((x) => x.now);
  const now = i >= 0 ? items[i] : null;
  const next = items.find((x, j) => j > i && !x.done && !x.past && x.kind === 'mission' && !x.now) || null;
  return { now, next };
}
