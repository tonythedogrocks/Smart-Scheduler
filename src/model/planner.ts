import type { State, Mission, Level, Objective } from './types';
import { addDays, dateOf, diffDays, minsOf, weekStart, weekday } from './time';
import { fixedBlocks, freeSlots, isRest, type Block } from './schedule';
import { capacityAt, factor, flareSpike, predictLevel, workMinOn } from './learn';

export interface Alloc { missionId: string; units: number; baseMin: number; min: number; habit?: boolean; clock?: boolean }
export interface DayAlloc { date: string; level: number; rest: boolean; blocks: Alloc[]; capMin: number }
export interface Risk { objectiveId: string; title: string; due: string; lands: string | null; note?: string }
export interface Forecast { today: string; days: DayAlloc[]; landing: Record<string, string | null>; risks: Risk[]; eased: boolean }

export interface PlanItem {
  key: string; start: number; end: number; title: string; sub?: string; detail?: string;
  kind: 'mission' | 'fixed';
  missionId?: string; units?: number; baseMin?: number; min?: number;
  done?: boolean; running?: boolean; now?: boolean; past?: boolean;
  block?: Block;
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
  const units = new Map(live.filter((m) => m.kind === 'work').map((m) => [m.id, m.unitsLeft ?? 0]));
  const doneIdx = new Map<string, number>(); // day index a work mission completes
  for (const m of live) if (m.kind === 'work' && (m.unitsLeft ?? 0) <= 0) doneIdx.set(m.id, m.doneAt ? diffDays(today, m.doneAt) : -999);
  const run = s.running;
  if (run && units.has(run.missionId)) units.set(run.missionId, Math.max(0, units.get(run.missionId)! - run.units));
  const last = new Map(live.filter((m) => m.kind === 'habit').map((m) => [m.id, lastDone(s, m.id)]));
  const objs = s.objectives.filter((o) => !o.done);
  const dues = objs.filter((o) => o.due).map((o) => diffDays(today, o.due!));
  const H = clamp(Math.max(14, ...dues.map((d) => d + 30)), 14, 150);
  const eased = flareSpike(s, now);
  const baseCap = Math.max(30, capacityAt(s, s.settings.baseline, today));
  const weekMin = new Map<string, number>();
  const wk = (id: string, date: string) => `${id}|${weekStart(date)}`;
  for (const l of s.logs) if (l.date >= weekStart(today)) weekMin.set(wk(l.missionId, l.date), (weekMin.get(wk(l.missionId, l.date)) || 0) + (l.end - l.start) / 60000);

  const available = (m: Mission, t: number) => (m.after || []).every((a) => {
    const pre = byId.get(a);
    if (!pre) return true;
    const d = doneIdx.get(a);
    return d !== undefined && d + (pre.clock ? pre.waitDays || 0 : 0) <= t;
  });
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
  const objLeft = (oid: string) => live.filter((m) => m.objectiveId === oid && m.kind === 'work').reduce((a, m) => a + (units.get(m.id) || 0) * m.minutes * f.get(m.id)!, 0);

  const days: DayAlloc[] = [];
  for (let t = 0; t <= H; t++) {
    const date = addDays(today, t);
    const rest = isRest(s, date);
    const real = s.days[date]?.level;
    const level = t === 0 && real ? real : predictLevel(s, date, today);
    const blocks: Alloc[] = [];
    const fixed = fixedBlocks(s, date);
    const from = t === 0 ? round5(minsOf(now)) : 0;
    let freeMin = freeSlots(fixed, from).reduce((a, [x, y]) => a + (y - x), 0);
    if (t === 0 && run) freeMin -= Math.max(0, run.plannedMin * (f.get(run.missionId) || 1) - (now - run.startedAt) / 60000);

    for (const m of habitsDue(s, date, level, last)) {
      const doneToday = t === 0 && s.logs.some((l) => l.missionId === m.id && l.date === date && l.done);
      if (doneToday || (t === 0 && run?.missionId === m.id)) continue;
      const base = habitMin(m, level), min = Math.round(base * f.get(m.id)!);
      blocks.push({ missionId: m.id, units: 1, baseMin: base, min, habit: true });
      freeMin -= min;
      if (t > 0 && m.everyDays) last.set(m.id, date);
    }

    let cap = capacityAt(s, level, today, t === 0);
    if (t === 0) cap -= workMinOn(s, date) + (run && byId.get(run.missionId)?.kind !== 'habit' ? run.plannedMin : 0);
    cap = Math.min(cap, freeMin);
    const capMin = Math.max(0, cap);
    const usedObj = new Map<string, number>(), usedSkill = new Map<string, number>(), usedMis = new Map<string, number>();
    const doneTodayMin = (id: string) => (t === 0 ? s.logs.filter((l) => l.missionId === id && l.date === date).reduce((a, l) => a + (l.end - l.start) / 60000, 0) : 0);

    // Even pace each dated mission needs today to land on time.
    const need = new Map<string, { min: number; dueIn: number }>();
    for (const m of live) {
      if (m.kind !== 'work' || (units.get(m.id) || 0) <= 0) continue;
      const o = s.objectives.find((x) => x.id === m.objectiveId);
      if (!o?.due || o.done) continue;
      const dueIn = diffDays(date, o.due) - tail(m);
      need.set(m.id, { min: ((units.get(m.id) || 0) * m.minutes * f.get(m.id)!) / Math.max(1, dueIn), dueIn });
    }
    for (let guard = 0; guard < 40 && cap >= 10; guard++) {
      let best: { m: Mission; score: number; u: number; min: number } | null = null;
      for (const m of live) {
        // a 2.5 baseline day is a blend of Standby and On Duty, so On Duty work is eligible
        if (m.kind === 'habit' || Math.ceil(level) < m.minLevel) continue;
        if (rest && !m.restOk) continue;
        if (m.workout && eased) continue;
        const o = s.objectives.find((x) => x.id === m.objectiveId);
        if (o?.done) continue;
        const ff = f.get(m.id)!;
        const spent = (usedMis.get(m.id) || 0) + doneTodayMin(m.id);
        let score: number, u: number, min: number;
        if (m.kind === 'work') {
          const left = units.get(m.id) || 0;
          if (left <= 0 || !available(m, t)) continue;
          const unit = m.minutes * ff;
          u = Math.min(m.maxBlockUnits || 3, left, Math.max(1, Math.floor((cap + unit * 0.4) / unit)));
          if (m.dailyCapMin) u = Math.min(u, Math.floor((m.dailyCapMin - spent) / unit));
          if (u < 1 || unit * 0.6 > cap) continue;
          min = Math.round(u * unit);
          const dueIn = o?.due ? Math.max(1, diffDays(date, o.due)) : 0;
          score = dueIn ? clamp((objLeft(m.objectiveId) / dueIn / baseCap) * 2, 0.3, 3) : 0.3;
          if (m.clock) score *= 2;
        } else {
          if (m.dailyCapMin && spent + m.minutes * 0.5 > m.dailyCapMin) continue;
          min = Math.round(m.minutes * ff); u = 1;
          if (min * 0.6 > cap) continue;
          const wd = weekMin.get(wk(m.id, date)) || 0;
          score = 0.6 * Math.max(0.15, 1 - wd / (m.weeklyMin || 120));
        }
        const nd = need.get(m.id);
        // Behind today's pace for a real deadline: nearest deadline goes first.
        if (nd && capMin - cap < capMin * PACE_SHARE && (usedMis.get(m.id) || 0) + doneTodayMin(m.id) < nd.min) score = 1000 - nd.dueIn;
        else
        // diminishing returns within a day: per Objective, and more gently per Skill
        score *= Math.pow(0.6, usedObj.get(m.objectiveId) || 0) * Math.pow(0.85, usedSkill.get(o?.skillId || '') || 0);
        if (!best || score > best.score) best = { m, score, u, min };
      }
      if (!best) break;
      const { m, u, min } = best;
      blocks.push({ missionId: m.id, units: u, baseMin: m.kind === 'work' ? u * m.minutes : m.minutes, min, clock: m.clock });
      cap -= min;
      usedObj.set(m.objectiveId, (usedObj.get(m.objectiveId) || 0) + 1);
      usedMis.set(m.id, (usedMis.get(m.id) || 0) + min);
      const sk = s.objectives.find((x) => x.id === m.objectiveId)?.skillId || '';
      usedSkill.set(sk, (usedSkill.get(sk) || 0) + 1);
      if (m.kind === 'work') {
        const left = units.get(m.id)! - u;
        units.set(m.id, left);
        if (left <= 0) doneIdx.set(m.id, t);
      } else weekMin.set(wk(m.id, date), (weekMin.get(wk(m.id, date)) || 0) + min);
    }
    days.push({ date, level, rest, blocks, capMin });
  }

  const landing: Record<string, string | null> = {};
  const landOf = (o: Objective): number | null => {
    const ms = live.filter((m) => m.objectiveId === o.id && m.kind === 'work');
    let worst = -999;
    for (const m of ms) {
      const d = doneIdx.get(m.id);
      if (d === undefined) return null;
      worst = Math.max(worst, d + (m.clock && d >= 0 ? m.waitDays || 0 : 0));
    }
    for (const dep of o.dependsOn || []) {
      const od = s.objectives.find((x) => x.id === dep);
      if (!od || od.done) continue;
      const d = landOf(od);
      if (d === null) return null;
      worst = Math.max(worst, d);
    }
    return worst;
  };
  const risks: Risk[] = [];
  for (const o of objs) {
    const hasWork = live.some((m) => m.objectiveId === o.id && m.kind === 'work') || (o.dependsOn || []).length > 0;
    if (!hasWork) continue;
    const d = landOf(o);
    landing[o.id] = d === null ? null : addDays(today, Math.max(0, d));
    if (o.due && (d === null || d > diffDays(today, o.due))) risks.push({ objectiveId: o.id, title: o.title, due: o.due, lands: landing[o.id], note: o.riskNote });
  }
  const v = { today, days, landing, risks, eased };
  memo = { k, v };
  return v;
}

/** Lay a day's allocation onto the clock. Today is laid from "now"; nothing is ever overdue. */
export function layoutDay(s: State, fc: Forecast, date: string, now: number): PlanItem[] {
  const today = fc.today;
  const fixed = fixedBlocks(s, date);
  const isToday = date === today;
  const nowMin = isToday ? minsOf(now) : date < today ? 1e9 : -1;
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  const items: PlanItem[] = fixed.map((b) => ({ key: b.key, start: b.start, end: b.end, title: b.title, sub: b.sub, kind: 'fixed' as const, block: b, past: b.end <= nowMin && b.kind !== 'note' }));
  const occ = new Map<string, number>();
  const keyFor = (id: string) => { const n = occ.get(id) || 0; occ.set(id, n + 1); return `m:${id}:${n}`; };
  const level = s.days[date]?.level ?? fc.days.find((d) => d.date === date)?.level ?? 3;
  const label = (m: Mission, min: number, units: number) => {
    const bits: string[] = [];
    if (m.kind === 'work' && m.unitName && m.unitsTotal) {
      const at = m.unitsTotal - (m.unitsLeft || 0) + 1;
      bits.push(units > 1 ? `${m.unitName}s ${at} to ${Math.min(m.unitsTotal, at + units - 1)} of ${m.unitsTotal}` : `${m.unitName} ${Math.min(at, m.unitsTotal)} of ${m.unitsTotal}`);
    }
    bits.push(m.kind === 'habit' ? `${min} min` : `about ${min} min`);
    if (m.energy !== 'none' && m.kind === 'habit') bits.push(m.energy[0].toUpperCase() + m.energy.slice(1));
    return bits.join(' · ');
  };

  for (const l of s.logs.filter((x) => x.date === date && x.done && x.end > 0).sort((a, b) => a.start - b.start)) {
    const m = byId.get(l.missionId); if (!m) continue;
    items.push({ key: keyFor(m.id), start: minsOf(l.start), end: Math.max(minsOf(l.start) + 1, minsOf(l.end)), title: m.kind === 'habit' ? habitTitle(m, l.level ?? level) : m.title, sub: `${Math.max(1, Math.round((l.end - l.start) / 60000))} min`, detail: m.note, kind: 'mission', missionId: m.id, done: true });
  }
  if (date < today) return items.sort((a, b) => a.start - b.start);
  if (!isToday) return items.sort((a, b) => a.start - b.start);

  let slots = freeSlots(fixed, round5(nowMin));
  const take = (len: number, notBefore = 0, forbid: [number, number][] = []): number => {
    for (let i = 0; i < slots.length; i++) {
      let [a, b] = slots[i];
      a = Math.max(a, notBefore);
      for (const [f0, f1] of forbid) if (a < f1 && f0 < a + len) a = f1;
      if (b - a >= len) {
        const rest: [number, number][] = [];
        if (a - slots[i][0] >= 5) rest.push([slots[i][0], a]);
        if (b - (a + len) >= 5) rest.push([a + len, b]);
        slots.splice(i, 1, ...rest);
        return a;
      }
    }
    return -1;
  };
  const run = s.running;
  if (run) {
    const m = byId.get(run.missionId);
    if (m) {
      const st = minsOf(run.startedAt);
      const min = Math.round(run.plannedMin * factor(s, m.id));
      const end = Math.max(round5(nowMin), st + min);
      slots = slots.flatMap(([a, b]) => (b <= end ? [] : [[Math.max(a, end), b] as [number, number]]));
      items.push({ key: keyFor(m.id), start: st, end, title: m.kind === 'habit' ? habitTitle(m, level) : m.title, sub: label(m, min, run.units), detail: m.note, kind: 'mission', missionId: m.id, units: run.units, baseMin: run.plannedMin, min, running: true });
    }
  }
  const day = fc.days[0];
  const gap = s.settings.mealGap;
  const meals: [number, number][] = fixed.filter((b) => b.kind === 'meal').map((b) => [b.start, b.end + gap]);
  const order = [...day.blocks].sort((a, b) => Number(!!b.habit) - Number(!!a.habit) || Number(!!b.clock) - Number(!!a.clock));
  for (const a of order) {
    const m = byId.get(a.missionId); if (!m) continue;
    const at = take(a.min, 0, m.workout ? meals : []);
    if (at < 0) continue; // doesn't fit today: back to the pool, silently
    if (!a.habit && a.min >= 45) {
      // breathing room after a real block
      slots = slots.map(([x, y]) => (x === at + a.min ? [x + s.settings.breakMin, y] : [x, y]) as [number, number]).filter(([x, y]) => y - x >= 5);
    }
    items.push({ key: keyFor(m.id), start: at, end: at + a.min, title: a.habit ? habitTitle(m, level) : m.title, sub: label(m, a.min, a.units), detail: m.note, kind: 'mission', missionId: m.id, units: a.units, baseMin: a.baseMin, min: a.min });
  }
  items.sort((a, b) => a.start - b.start || a.end - b.end);
  const cur = items.find((i) => i.running) || items.find((i) => !i.done && !i.past && i.block?.kind !== 'note' && i.start <= nowMin + 5 && i.end > nowMin);
  if (cur) cur.now = true;
  return items;
}

/** Orders: the single thing to do now, and what follows. */
export function orders(items: PlanItem[]) {
  const i = items.findIndex((x) => x.now);
  const now = i >= 0 ? items[i] : null;
  const next = items.find((x, j) => j > i && !x.done && !x.past && x.kind === 'mission' && !x.now) || null;
  return { now, next };
}
