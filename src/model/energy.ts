import type { State } from './types';
import { dateOf, minsOf, weekday } from './time';

/**
 * Energy model: predicted energy in 30-minute slots across the day, per weekday.
 * Day 1 is flat. Each observed day blends in with weight max(1/n, 0.1): the first day sets the
 * curve, later days move it less, never under 10%, so it keeps adapting. No confidence gate.
 */
export const SLOT = 30;
const SLOTS = 48;
const LEVEL_MULT: Record<number, number> = { 1: 0.4, 2: 0.7, 3: 1, 4: 1.15, 5: 1.3 };
export const levelMult = (l: number) => {
  const lo = Math.max(1, Math.min(5, Math.floor(l))), hi = Math.max(1, Math.min(5, Math.ceil(l)));
  return LEVEL_MULT[lo] + (LEVEL_MULT[hi] - LEVEL_MULT[lo]) * (l - lo);
};
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Signals for one day, per slot: finished on pace ~1, stopped partway 0.6, missed 0.2; normalized by that day's check-in. */
export function dayObservations(s: State, date: string): Map<number, number> {
  const raw = new Map<number, number[]>();
  const add = (fromMin: number, toMin: number, v: number) => {
    for (let k = Math.floor(fromMin / SLOT); k <= Math.floor(Math.max(fromMin, toMin - 1) / SLOT) && k < SLOTS; k++) (raw.get(k) || raw.set(k, []).get(k)!).push(v);
  };
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  for (const l of s.logs) {
    if (l.date !== date || l.end <= l.start) continue;
    const m = byId.get(l.missionId);
    if (!m || m.kind === 'chore') continue;
    const actual = Math.max(1, (l.end - l.start) / 60000);
    const planned = m.kind === 'work' && l.units ? l.units * m.minutes : l.plannedMin;
    const pace = clamp(planned / actual, 0.6, 1.4);
    add(minsOf(l.start), minsOf(l.end), l.done ? pace : l.units > 0 ? 0.6 : 0.4);
  }
  for (const x of realMisses(s, date)) add(x.at, x.at + SLOT, 0.2);
  for (const p of s.prior || []) if (p.date === date) for (const b of p.blocks) add(b.s, b.e, b.v);
  const level = s.days[date]?.level ?? (s.prior || []).find((p) => p.date === date)?.level ?? 3;
  const out = new Map<number, number>();
  for (const [k, vs] of raw) out.set(k, clamp(vs.reduce((a, b) => a + b, 0) / vs.length / levelMult(level), 0.1, 2));
  return out;
}

let memo: { k: string; v: ReturnType<typeof build> } | null = null;
function build(s: State, before: string) {
  const g = new Array(SLOTS).fill(1), wd: number[][] = Array.from({ length: 7 }, () => new Array(SLOTS).fill(1));
  let ng = 0; const nwd = new Array(7).fill(0);
  const dates = [...new Set([...Object.keys(s.days), ...(s.prior || []).map((p) => p.date), ...s.logs.map((l) => l.date)])].filter((d) => d < before).sort();
  for (const d of dates) {
    const obs = dayObservations(s, d);
    if (!obs.size) continue;
    ng++; const w = weekday(d); nwd[w]++;
    const a = Math.max(1 / ng, 0.1), b = Math.max(1 / nwd[w], 0.1);
    for (const [k, v] of obs) { g[k] = g[k] * (1 - a) + v * a; wd[w][k] = wd[w][k] * (1 - b) + v * b; }
  }
  return { g, wd, ng, nwd };
}
export function curves(s: State, before: string) {
  const k = `${s.updatedAt}|${before}|${(s.prior || []).length}`;
  if (memo && memo.k === k) return memo.v;
  const v = build(s, before);
  memo = { k, v };
  return v;
}

/** Predicted energy for each 30-minute slot of a date at a check-in level (smoothed across neighbors). */
export function predictedCurve(s: State, date: string, level: number, today: string): number[] {
  const c = curves(s, today);
  const w = weekday(date);
  const base = c.nwd[w] ? c.wd[w] : c.g;
  const sm = base.map((v, i) => 0.25 * (base[i - 1] ?? v) + 0.5 * v + 0.25 * (base[i + 1] ?? v));
  const lm = levelMult(level);
  const out = sm.map((v) => v * lm);
  if (date === today) for (const x of realMisses(s, date)) { const k = Math.floor(x.at / SLOT); if (out[k] !== undefined) out[k] *= 0.6; }
  return out;
}

/** Average predicted energy between two times of day. */
export function energyBetween(curve: number[], fromMin: number, toMin: number): number {
  const a = Math.floor(fromMin / SLOT), b = Math.max(a, Math.floor((toMin - 1) / SLOT));
  let t = 0, n = 0;
  for (let k = a; k <= b && k < curve.length; k++) { t += curve[k]; n++; }
  return n ? t / n : 1;
}

/** Where today's energy usually peaks, for Debrief (null until there's a day of data). */
export function energyPeak(s: State, today: string): { from: number; to: number } | null {
  const c = curves(s, today);
  if (!c.ng) return null;
  let best = -1, at = 0;
  for (let k = 16; k < 44; k++) { const v = c.g[k] + c.g[k + 1]; if (v > best) { best = v; at = k; } }
  return Math.abs(best / 2 - 1) < 0.05 ? null : { from: at * SLOT, to: (at + 2) * SLOT };
}
void dateOf;

/** Today's misses that really were misses: not ones where he was in fact doing that task at the time
 * (a device on old data can log those). */
export function realMisses(s: State, date: string): { m: string; at: number }[] {
  const logs = s.logs.filter((l) => l.date === date);
  return (s.days[date]?.misses || []).filter((x) => !logs.some((l) => l.missionId === x.m && minsOf(l.start) <= x.at + 5 && (l.end <= 0 || minsOf(l.end) >= x.at)));
}
