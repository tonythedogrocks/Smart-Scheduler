import type { State, Mission } from './types';
import { addDays, diffDays, minsOf, parseD, weekStart, weekday } from './time';
import { eventsOn, holidayName } from './schedule';

const mins = (l: { start: number; end: number }) => (l.end > 0 ? Math.max(1, (l.end - l.start) / 60000) : 0);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** A record long enough to learn from (Start and Done tapped back to back teaches nothing). */
export const real = (l: { start: number; end: number }) => l.end > 0 && l.end - l.start >= 60000;

/** Real duration vs. estimate for a mission. Acts only once there are 3 finished runs. */
export function factor(s: State, missionId: string): number {
  const ls = s.logs.filter((l) => l.missionId === missionId && l.done && l.plannedMin > 0 && real(l));
  if (ls.length < 3) return 1;
  // plannedMin is the base estimate, so the ratio is the real-world correction.
  return clamp(ls.reduce((a, l) => a + mins(l), 0) / ls.reduce((a, l) => a + l.plannedMin, 0), 0.5, 2.5);
}

/** Minutes it really takes to cook, for himself or for the family: the setting until 2 real runs, then the recent average. */
export function cookMinutes(s: State, family = false): number {
  const runs = Object.values(s.days).filter((d) => !!d.cook && (d.cook === 'family') === family && d.cookStart && d.cookEnd && d.cookEnd > d.cookStart).map((d) => (d.cookEnd! - d.cookStart!) / 60000).filter((m) => m >= 5 && m <= 240);
  if (runs.length < 2) return family ? s.settings.cookFamilyMin : s.settings.cookMin;
  const recent = runs.slice(-6);
  return Math.round(recent.reduce((a, b) => a + b, 0) / recent.length / 5) * 5;
}

/** Missions that count toward weekly exercise. Daily base routines (habits) never do. */
export const isExercise = (m?: Mission) => !!m && m.kind !== 'habit' && m.kind !== 'chore' && (!!m.workout || m.energy === 'physical');

export function exerciseMinWeek(s: State, weekStartDate: string): number {
  const ph = new Map<string, Mission>(s.missions.map((m) => [m.id, m]));
  const end = addDays(weekStartDate, 7);
  let t = s.logs.filter((l) => l.date >= weekStartDate && l.date < end && isExercise(ph.get(l.missionId))).reduce((a, l) => a + mins(l), 0);
  for (const e of s.events) if (e.date && e.date >= weekStartDate && e.date < end && e.kind === 'workout') t += e.exerciseMin ?? e.end - e.start;
  // biking there and back counts: commitments (dated or weekly) and errands done by bike
  for (let i = 0; i < 7; i++) for (const e of eventsOn(s, addDays(weekStartDate, i))) if (e.bike || (e.kind === 'shift' && s.settings.shift.bike)) t += e.travel + (e.travelBack ?? e.travel);
  for (const l of s.logs) { const m = ph.get(l.missionId); if (m?.bike && m.travel && l.done && l.date >= weekStartDate && l.date < end) t += 2 * m.travel; }
  return t;
}

const spikeIn = (s: State, from: number, to: number) => {
  const f = s.flares.filter((x) => x.ts >= from && x.ts < to);
  return f.length >= 2 || f.some((x) => (x.rating ?? 0) >= 7);
};

/**
 * Weekly exercise ceiling. Starts at the low end of the guideline and grows about 10% a week,
 * but only after a week where most of it was actually done and flares stayed quiet.
 * A week with a flare spike steps it back. Never below the start or above the top.
 */
export function exerciseCeiling(s: State, today: string): { cap: number; done: number; growing: boolean } {
  const { exStart, exTop, exGrowth } = s.settings;
  const first = Object.keys(s.days).sort()[0] || today;
  let wk = weekStart(first <= today ? first : today), cap = exStart, growing = true;
  const cur = weekStart(today);
  while (wk < cur) {
    const t0 = parseD(wk).getTime() - 12 * 3600000, t1 = t0 + 7 * 86400000;
    if (spikeIn(s, t0, t1)) { cap = Math.max(exStart, cap * (1 - exGrowth)); growing = false; }
    else if (exerciseMinWeek(s, wk) >= cap * 0.6) { cap = Math.min(exTop, cap * (1 + exGrowth)); growing = true; }
    else growing = false;
    wk = addDays(wk, 7);
  }
  return { cap: Math.round(cap / 5) * 5, done: exerciseMinWeek(s, cur), growing };
}

/** Days between runs of a repeating chore: the mission's setting until there are 2 real gaps to learn from. */
export function choreInterval(s: State, m: Mission): { days: number; learned: boolean } {
  const ends = [...new Set(s.logs.filter((l) => l.missionId === m.id && l.done && l.step === (m.steps?.length || 1) - 1).map((l) => l.date))].sort();
  if (m.lastAt && !ends.includes(m.lastAt)) ends.push(m.lastAt), ends.sort();
  const gaps = ends.slice(1).map((d, i) => diffDays(ends[i], d)).filter((g) => g > 0);
  if (gaps.length < 2) return { days: m.everyDays || 7, learned: false };
  const recent = gaps.slice(-6);
  return { days: Math.max(1, Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)), learned: true };
}
export function choreLast(s: State, m: Mission): string | null {
  let d = m.lastAt || null;
  for (const l of s.logs) if (l.missionId === m.id && l.done && l.step === (m.steps?.length || 1) - 1 && (!d || l.date > d)) d = l.date;
  return d;
}
/** Date the chore is next needed, or null if it has never been done or dated. */
export function choreDue(s: State, m: Mission): string | null {
  const last = choreLast(s, m);
  const due = last ? addDays(last, choreInterval(s, m).days) : null;
  // asked for sooner (and not done since)
  if (m.dueBy && (!last || last < m.dueBy) && (!due || m.dueBy < due)) return m.dueBy;
  return due;
}

export function bodyFat(neck: number, navel: number, height: number) {
  return 86.01 * Math.log10(navel - neck) - 70.041 * Math.log10(height) + 36.76;
}

/**
 * Plans that come up during the week: on average, how many minutes of one-off events (not weekly ones,
 * travel included) each weekday has had, from the past 8 weeks. Needs 2 of that weekday to count.
 */
export function expectedBusy(s: State, today: string, wd: number): number {
  const xs: number[] = [];
  for (let i = 1; i <= 56; i++) {
    const d = addDays(today, -i);
    if (weekday(d) !== wd || !(s.days[d]?.level || s.logs.some((l) => l.date === d))) continue; // only days he actually used the app
    if (holidayName(d) || holidayName(addDays(d, 1))) continue; // a holiday (or its eve) says nothing about a normal week
    xs.push(s.events.filter((e) => e.date === d && e.kind !== 'exam').reduce((a, e) => a + (e.end - e.start) + e.travel + (e.travelBack ?? e.travel), 0));
  }
  return xs.length >= 2 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/** Today's misses that really were misses (not ones where he was in fact doing that task then). Skips count too. */
export function realMisses(s: State, date: string): { m: string; at: number; skip?: boolean }[] {
  const logs = s.logs.filter((l) => l.date === date);
  return (s.days[date]?.misses || []).filter((x) => !logs.some((l) => l.missionId === x.m && minsOf(l.start) <= x.at + 5 && (l.end <= 0 || minsOf(l.end) >= x.at)));
}
