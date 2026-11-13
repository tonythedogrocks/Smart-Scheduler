import type { State, Level, Mission } from './types';
import { addDays, dateOf, diffDays, minsOf, parseD, weekStart, weekday } from './time';
import { eventsOn, isRest } from './schedule';

const mins = (l: { start: number; end: number }) => (l.end > 0 ? Math.max(1, (l.end - l.start) / 60000) : 0);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Real duration vs. estimate for a mission. Acts only once there are 3 finished runs. */
export function factor(s: State, missionId: string): number {
  const ls = s.logs.filter((l) => l.missionId === missionId && l.done && l.plannedMin > 0 && l.end > 0);
  if (ls.length < 3) return 1;
  // plannedMin is the base estimate, so the ratio is the real-world correction.
  return clamp(ls.reduce((a, l) => a + mins(l), 0) / ls.reduce((a, l) => a + l.plannedMin, 0), 0.5, 2.5);
}

const isWork = (s: State) => { const k = new Map(s.missions.map((m) => [m.id, m.kind])); return (id: string) => k.get(id) !== 'habit'; };

export function workMinOn(s: State, date: string): number {
  const w = isWork(s);
  return s.logs.filter((l) => l.date === date && w(l.missionId)).reduce((a, l) => a + mins(l), 0);
}

/** How many minutes of non-habit work a level really gets done. */
export function learnedCapacity(s: State, today: string): Partial<Record<Level, { n: number; mean: number }>> {
  const by: Record<number, number[]> = {};
  for (const [d, r] of Object.entries(s.days)) {
    if (!r.level || d >= today || isRest(s, d)) continue;
    (by[r.level] ||= []).push(workMinOn(s, d));
  }
  const out: Partial<Record<Level, { n: number; mean: number }>> = {};
  for (const k of Object.keys(by)) { const a = by[+k]; out[+k as Level] = { n: a.length, mean: a.reduce((x, y) => x + y, 0) / a.length }; }
  return out;
}

/** Worked days before `today` (newest first), skipping rest days: date, level, focused minutes. */
function workedDays(s: State, today: string, n = 21) {
  const out: { d: string; level: number; o: number }[] = [];
  for (let i = 1; i <= n; i++) {
    const d = addDays(today, -i), r = s.days[d];
    if (!r?.level || isRest(s, d)) continue;
    out.push({ d, level: r.level, o: workMinOn(s, d) });
  }
  return out;
}

/**
 * Sustainable capacity: the best recent day (last 3 weeks, not a Recovery day) that wasn't followed
 * by a crash (the next worked day reached at least 60% of it). Rises as soon as a bigger day holds.
 */
export function sustainableCapacity(s: State, today: string): number | null {
  const xs = workedDays(s, today).filter((x) => x.level !== 1);
  if (xs.length < 2) return null;
  const ok = xs.filter((x, i) => i === 0 || xs[i - 1].o >= 0.6 * x.o).map((x) => x.o);
  const best = ok.length ? Math.max(...ok) : 0;
  return best >= 30 ? Math.round(best) : null;
}

/**
 * How far a Plus Ultra day plans past sustainable capacity. Starts at +25%. Each finished push
 * (a run of level-5 days plus up to 2 dial-back days after) is scored against staying at capacity:
 * came out ahead -> next push 5 points bigger, behind -> 5 points smaller (10% to 50%).
 */
export function pushSize(s: State, today: string) {
  let pct = 0.25;
  const pushes: { start: string; end: string; days: number; total: number; cap: number; net: number }[] = [];
  const dates = Object.keys(s.days).filter((d) => d < today && s.days[d].level && !isRest(s, d)).sort();
  const lv = (d: string) => s.days[d]?.level;
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    if (lv(d) !== 5 || (i > 0 && lv(dates[i - 1]) === 5)) continue;
    let j = i; while (j + 1 < dates.length && lv(dates[j + 1]) === 5) j++;
    const after = dates.slice(j + 1, j + 3).filter((x) => lv(x) !== 5);
    if (j + 2 >= dates.length && after.length < 2) continue; // dial-back not over yet
    const days = [...dates.slice(i, j + 1), ...after];
    const cap = sustainableCapacity(s, d);
    if (cap === null) continue;
    const total = days.reduce((a, x) => a + workMinOn(s, x), 0), net = total - cap * days.length;
    pct = Math.round(clamp(pct + (net >= 0 ? 0.05 : -0.05), 0.1, 0.5) * 100) / 100;
    pushes.push({ start: d, end: dates[j], days: days.length, total: Math.round(total), cap, net: Math.round(net) });
    i = j;
  }
  return { pct, pushes };
}

/** Day-of-week pattern: how a weekday's output compares with the average (needs 3 of that weekday, 10 days). */
export function weekdayFactor(s: State, today: string, wd: number): number {
  const xs = workedDays(s, today, 90);
  const same = xs.filter((x) => weekday(x.d) === wd);
  if (xs.length < 10 || same.length < 3) return 1;
  const all = xs.reduce((a, x) => a + x.o, 0) / xs.length;
  if (all <= 0) return 1;
  return clamp(same.reduce((a, x) => a + x.o, 0) / same.length / all, 0.75, 1.25);
}

export function capacityAt(s: State, level: number, today: string, optimistic = false): number {
  const lc = learnedCapacity(s, today);
  const sus = sustainableCapacity(s, today);
  const base = (l: Level) => {
    const prior = s.settings.capacity[l], got = lc[l];
    if (!got || got.n < 3) return prior;
    const blended = got.n >= 6 ? got.mean : (got.mean + prior) / 2;
    return optimistic ? Math.max(prior, blended) : blended;
  };
  // Once sustainable capacity is known, Active plans to it and Plus Ultra plans a push past it.
  const one = (l: Level) => {
    if (sus === null || l < 4) return base(l);
    const four = Math.max(sus, base(3));
    return l === 4 ? four : four * (1 + pushSize(s, today).pct);
  };
  const lo = clamp(Math.floor(level), 1, 5) as Level, hi = clamp(Math.ceil(level), 1, 5) as Level;
  return one(lo) + (one(hi) - one(lo)) * (level - lo);
}

/** Predicted level for a future day; never above the planning baseline. */
/** Every known daily level (this app's check-ins plus imported history), by date. */
function levelHistory(s: State, today: string): [string, number][] {
  const m = new Map<string, number>();
  for (const p of s.prior || []) if (p.level && p.date < today) m.set(p.date, p.level);
  for (const [d, r] of Object.entries(s.days)) if (r.level && d < today) m.set(d, r.level);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * The level the app predicts for a day, for pacing: his usual level on that weekday (3+ of them),
 * else his recent average (5+ days), else the modest baseline; a day after Plus Ultra drops once
 * that crash pattern is confident. Not capped: the safety buffer before each deadline absorbs misses.
 */
export function learnedLevel(s: State, date: string, today: string): number {
  if (s.days[date]?.level) return s.days[date].level!;
  const h = levelHistory(s, today);
  const same = h.filter(([d]) => weekday(d) === weekday(date)).slice(-6).map(([, l]) => l);
  const recent = h.slice(-14).map(([, l]) => l);
  let p = same.length >= 3 ? same.reduce((a, b) => a + b, 0) / same.length : recent.length >= 5 ? recent.reduce((a, b) => a + b, 0) / recent.length : s.settings.baseline;
  if (crashAfter5(s, today).confident && s.days[addDays(date, -1)]?.level === 5) p -= 1;
  return clamp(p, 1, 5);
}

/** Level assumed for a day not reported yet: Active (optimal), as he asked, until he reports in that day. */
export function predictLevel(s: State, date: string, _today: string): number {
  // a day not reported yet is planned at the level it's predicted to be (that weekday's pattern, else recent days)
  return s.days[date]?.level ?? Math.min(5, Math.max(1, Math.round(learnedLevel(s, date, _today))));
}

export function crashAfter5(s: State, today: string) {
  const all = Object.entries(s.days).filter(([d, r]) => r.level && d < today);
  const next = all.filter(([d]) => s.days[addDays(d, -1)]?.level === 5).map(([, r]) => r.level!);
  const mean = all.length ? all.reduce((a, [, r]) => a + r.level!, 0) / all.length : 0;
  const after = next.length ? next.reduce((a, b) => a + b, 0) / next.length : 0;
  return { n: next.length, after, mean, confident: next.length >= 3 && mean - after >= 0.5 };
}

export function followThrough(s: State) {
  const w = isWork(s);
  const ls = s.logs.filter((l) => w(l.missionId));
  return { n: ls.length, rate: ls.length ? ls.filter((l) => l.done).length / ls.length : 1 };
}

const PARTS = ['Morning', 'Midday', 'Afternoon', 'Evening'];
export const partOf = (min: number) => (min < 660 ? 0 : min < 810 ? 1 : min < 1050 ? 2 : 3);
export const partName = (i: number) => PARTS[i];

/** Time of day x energy type: how often started work gets finished. */
export function contextStats(s: State) {
  const en = new Map(s.missions.map((m) => [m.id, m.energy]));
  const cells: Record<string, { n: number; done: number }> = {};
  for (const l of s.logs) {
    const k = `${en.get(l.missionId) || 'none'}|${partOf(minsOf(l.start))}`;
    const c = (cells[k] ||= { n: 0, done: 0 }); c.n++; if (l.done) c.done++;
  }
  return Object.entries(cells).filter(([, c]) => c.n >= 5).map(([k, c]) => { const [energy, part] = k.split('|'); return { energy, part: PARTS[+part], n: c.n, rate: c.done / c.n }; });
}

/** What tends to come before flares (previous 24 h). */
export function flareStats(s: State) {
  const title = new Map(s.missions.map((m) => [m.id, m.title]));
  const counts: Record<string, number> = {};
  for (const f of s.flares) {
    const seen = new Set<string>();
    for (const l of s.logs) if (l.end <= f.ts && l.end > f.ts - 86400000) seen.add(title.get(l.missionId) || '');
    for (const d of s.doing) if (d.ts <= f.ts && d.ts > f.ts - 86400000) seen.add(d.what);
    for (const e of s.events) if (e.date && e.date >= dateOf(f.ts - 86400000) && e.date <= dateOf(f.ts) && e.kind !== 'exam') seen.add(e.title);
    seen.forEach((t) => { if (t) counts[t] = (counts[t] || 0) + 1; });
  }
  const n = s.flares.length;
  return { n, before: Object.entries(counts).filter(([, c]) => n >= 4 && c / n >= 0.6).map(([t, c]) => ({ t, c })) };
}

/** Flares are spiking: ease training load (PT stays). */
export function flareSpike(s: State, now: number): boolean {
  const recent = s.flares.filter((f) => f.ts > now - 3 * 86400000 && f.ts <= now);
  return recent.length >= 2 || recent.some((f) => (f.rating ?? 0) >= 7 && f.ts > now - 2 * 86400000);
}

/**
 * Morning pattern, for Debrief only (planning assumes an on-time start): what time he's
 * usually ready, and how long from reporting in to Done. Needs 3 mornings.
 */
export function morningStats(s: State) {
  const runs = Object.values(s.days).filter((d) => d.morningEnd);
  if (runs.length < 3) return null;
  const recent = runs.slice(-14);
  const ready = recent.reduce((a, d) => a + minsOf(d.morningEnd!), 0) / recent.length;
  const spans = recent.filter((d) => d.setAt && d.morningEnd! > d.setAt && d.morningEnd! - d.setAt < 4 * 3600000).map((d) => (d.morningEnd! - d.setAt!) / 60000);
  return { n: recent.length, readyAt: Math.round(ready / 5) * 5, span: spans.length >= 3 ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length / 5) * 5 : null };
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
  return last ? addDays(last, choreInterval(s, m).days) : null;
}



/** What a mission start came straight after (within 90 min): a mission's energy, an event, or a "doing now" tap. */
export function cameAfter(s: State, ts: number, skipId?: string): string | null {
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  let best: { at: number; what: string } | null = null;
  const consider = (at: number, what: string) => { if (at <= ts && at > ts - 90 * 60000 && (!best || at > best.at)) best = { at, what }; };
  for (const l of s.logs) if (l.id !== skipId && l.end > 0) { const m = byId.get(l.missionId); if (m && m.energy !== 'none' && m.kind !== 'chore') consider(l.end, isExercise(m) ? 'workout' : m.energy); }
  for (const d of s.doing) consider(d.ts, d.what.toLowerCase());
  const date = dateOf(ts);
  for (const e of s.events) {
    if (e.date !== date) continue;
    const base = parseD(date).getTime() - 12 * 3600000;
    consider(base + (e.end + (e.travelBack ?? e.travel)) * 60000, e.kind === 'event' || e.kind === 'exam' ? 'event' : e.kind);
  }
  return best ? (best as { what: string }).what : null;
}

/**
 * How what came before affects each kind of work. Only reports a pattern with enough
 * cases and a clear gap from that kind of work's usual finish rate.
 */
export function afterStats(s: State) {
  const en = new Map(s.missions.map((m) => [m.id, m]));
  const cells: Record<string, { n: number; done: number }> = {}, base: Record<string, { n: number; done: number }> = {};
  for (const l of s.logs) {
    const m = en.get(l.missionId);
    if (!m || m.kind === 'habit' || m.kind === 'chore' || l.end <= 0) continue;
    const b = (base[m.energy] ||= { n: 0, done: 0 }); b.n++; if (l.done) b.done++;
    const prev = cameAfter(s, l.start, l.id);
    if (!prev) continue;
    const c = (cells[`${prev}|${m.energy}`] ||= { n: 0, done: 0 }); c.n++; if (l.done) c.done++;
  }
  return Object.entries(cells).flatMap(([k, c]) => {
    const [after, energy] = k.split('|');
    const b = base[energy];
    if (c.n < 6 || !b || b.n < 10) return [];
    const rate = c.done / c.n, usual = b.done / b.n;
    return Math.abs(rate - usual) >= 0.25 ? [{ after, energy, n: c.n, rate, usual, worse: rate < usual }] : [];
  });
}

export function bodyFat(neck: number, navel: number, height: number) {
  return 86.01 * Math.log10(navel - neck) - 70.041 * Math.log10(height) + 36.76;
}
