import type { State, Evt } from './types';
import { addDays, dateOf, fmtT, minsOf, parseD, weekStart, weekday } from './time';
import { cookMinutes } from './learn';

export interface Block {
  key: string; start: number; end: number; title: string; sub?: string;
  kind: 'routine' | 'meal' | 'event' | 'travel' | 'offduty' | 'sleep' | 'note';
  evtId?: string; meal?: 'lunch' | 'dinner'; blocking: boolean; ate?: boolean; big?: boolean;
}

/** The weekly rest day: the floor and what's due that day, nothing more. */
export const isSabbath = (s: State, date: string) => s.days[date]?.sabbath ?? (s.settings.restDay !== null && weekday(date) === s.settings.restDay);

/** Sunrise and sunset in local minutes (NOAA approximation). */
export function sunTimes(date: string, lat: number, lon: number): [number, number] {
  const d = parseD(date), start = new Date(d.getFullYear(), 0, 1, 12);
  const n = Math.round((d.getTime() - start.getTime()) / 86400000) + 1, g = (2 * Math.PI / 365) * (n - 1);
  const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const r = Math.PI / 180, la = lat * r;
  const ha = Math.acos(Math.min(1, Math.max(-1, Math.cos(90.833 * r) / (Math.cos(la) * Math.cos(decl)) - Math.tan(la) * Math.tan(decl)))) / r;
  const tz = -d.getTimezoneOffset();
  return [720 - 4 * (lon + ha) - eq + tz, 720 - 4 * (lon - ha) - eq + tz];
}

/** Usual dinner time, learned from "Dinner now" taps: same weekday first, then any recent day. */
export function learnedDinner(s: State, date: string): number | null {
  const taps = Object.entries(s.days).filter(([d, r]) => r.dinnerTap !== undefined && d < date).sort(([a], [b]) => b.localeCompare(a));
  const med = (xs: number[]) => { const a = [...xs].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
  const same = taps.filter(([d]) => weekday(d) === weekday(date)).slice(0, 8).map(([, r]) => r.dinnerTap!);
  const any = taps.slice(0, 14).map(([, r]) => r.dinnerTap!);
  const m = same.length >= 3 ? med(same) : any.length >= 3 ? med(any) : null;
  return m === null ? null : Math.min(1140, Math.max(1020, Math.round(m / 5) * 5));
}

/** Which week of the month a date falls in (1-4), and whether it is the last one. */
export function inWeeks(date: string, nth: number[]): boolean {
  const d = parseD(date), n = Math.ceil(d.getDate() / 7);
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() < 7;
  return nth.includes(n) || (last && nth.includes(5));
}

export function eventsOn(s: State, date: string): Evt[] {
  const wd = weekday(date);
  return s.events
    .filter((e) => (e.date ? e.date === date : e.weekday === wd && (!e.nth || inWeeks(date, e.nth))) && !(e.skip || []).includes(date))
    .map((e) => {
      const st = e.choices ? s.days[date]?.starts?.[e.id] : undefined;
      return st === undefined ? e : { ...e, start: st, end: st + (e.end - e.start) };
    })
    .sort((a, b) => a.start - b.start);
}

/** Wake time: 8:00, or earlier when the first commitment needs it. */
export function wakeFor(s: State, date: string, withLate = true): number {
  // the first thing that starts after 4 AM (an overnight event carried over from yesterday isn't an early start)
  const ev = eventsOn(s, date).find((e) => e.start - e.travel >= 240);
  const late = withLate ? s.days[date]?.lateBy || 0 : 0; // what-if only: getting up this many minutes late
  if (!ev) return s.settings.wake + late;
  return Math.min(s.settings.wake, ev.start - ev.travel - s.settings.morningMin) + late;
}

/** Start of getting ready for bed; moves earlier when tomorrow starts early. */
export function bedPrepFor(s: State, date: string): number {
  // bedtime follows when he's meant to get up, not a what-if late start
  return s.settings.bedPrep - (s.settings.wake - wakeFor(s, addDays(date, 1), false));
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

export function fixedBlocks(s: State, date: string): Block[] {
  const st = s.settings;
  const out: Block[] = [];
  // Planning assumes he starts on time.
  const wake = wakeFor(s, date);
  const prep = bedPrepFor(s, date);
  const off = prep - (s.days[date]?.offDutyMin ?? st.offDutyMin);
  // Planned length; on the day it lasts until he taps Done (see layoutDay).
  const mEnd = s.days[date]?.morningEnd;
  const morningEnd = mEnd && dateOf(mEnd) === date ? Math.max(wake + 1, minsOf(mEnd)) : wake + st.morningMin;
  const busy: [number, number][] = [[wake, morningEnd]];
  out.push({ key: 'f:morning', start: wake, end: morningEnd, title: 'Awake, ready, breakfast', kind: 'routine', blocking: true });
  for (const e0 of eventsOn(s, date)) {
    // open-ended: runs to bedtime until he taps I'm back; then it ended a trip home before that
    const ba = e0.untilBack ? s.days[date]?.backAt : undefined;
    const e = !e0.untilBack ? e0 : { ...e0, end: ba && dateOf(ba) === date ? Math.max(e0.start, minsOf(ba) - (e0.travelBack ?? e0.travel)) : prep };
    if (e.travel) out.push({ key: `f:to:${e.id}`, start: e.start - e.travel, end: e.start, title: `Travel to ${e.title}`, sub: `${e.travel} min`, kind: 'travel', evtId: e.id, blocking: true });
    out.push({ key: `f:ev:${e.id}`, start: e.start, end: e.end, title: e.title, sub: e.note, kind: 'event', evtId: e.id, blocking: true });
    const back = e.travelBack ?? e.travel;
    if (back) out.push({ key: `f:from:${e.id}`, start: e.end, end: e.end + back, title: 'Travel home', sub: `${back} min`, kind: 'travel', evtId: e.id, blocking: true });
    busy.push([e.start - e.travel, e.end + back]);
  }
  const free = (a: number, len: number) => !busy.some(([b0, b1]) => overlaps(a, a + len, b0, b1));
  const day = s.days[date] || {};
  const tailFits = new Set<string>();
  const dishLen = learnedDishes(s);
  const dishToday = st.dishDays.includes(weekday(date)) || !!day.dishDuty;
  const dish = dishToday ? dishLen : 0;
  // tail: time that must follow the meal right away (dishes), so the meal is placed where both fit
  const place = (meal: 'lunch' | 'dinner', want: number, len: number, lo: number, hi: number, tail = 0) => {
    const title = meal === 'lunch' ? 'Lunch' : 'Dinner';
    // a confirmed meal sits exactly where it happened
    // eaten at an event that day: no meal at home, just a note on the timeline
    if (day.skipMeals?.includes(meal) && !day.ate?.[meal]) {
      out.push({ key: `f:${meal}`, start: meal === 'lunch' ? st.lunchAt : st.dinnerAt, end: meal === 'lunch' ? st.lunchAt : st.dinnerAt, title: `No ${meal} today`, kind: 'note', meal, blocking: false });
      return -1;
    }
    const evMeal = eventsOn(s, date).find((e) => e.meals?.includes(meal));
    if (evMeal && !day.ate?.[meal]) {
      out.push({ key: `f:${meal}`, start: evMeal.start, end: evMeal.start, title: `${title} at ${evMeal.title}`, sub: 'Eaten there', kind: 'note', meal, blocking: false });
      return -1;
    }
    const got = day.ate?.[meal];
    if (got) {
      const end = got.end !== undefined && got.end > got.at ? got.end : got.at + len;
      out.push({ key: `f:${meal}`, start: got.at, end, title, sub: `Ate at ${fmtT(got.at)}${got.end !== undefined ? ` to ${fmtT(got.end)}` : ''}${got.big ? ' · large meal' : ''}`, kind: 'meal', meal, blocking: true, ate: true, big: got.big });
      busy.push([got.at, end]);
      return end;
    }
    let at = -1;
    const need = len + tail;
    if (free(want, need)) at = want;
    else {
      const c = busy.filter(([b0, b1]) => overlaps(want, want + need, b0, b1));
      const after = Math.max(...c.map((b) => b[1])), before = Math.min(...c.map((b) => b[0])) - need;
      if (after <= hi && free(after, need)) at = after;
      else if (before >= lo && free(before, need)) at = before;
      else if (tail && free(want, len)) at = want; // no room for both: the meal still happens
      // still nothing: the nearest free time in the window (with the dishes after if they fit, else the meal alone)
      for (const n of tail ? [need, len] : [len]) {
        if (at >= 0) break;
        for (let d = 5; d <= 240 && at < 0; d += 5) {
          if (want + d + n <= hi + len && free(want + d, n)) at = want + d;
          else if (want - d >= lo && free(want - d, n)) at = want - d;
        }
      }
    }
    if (at < 0) {
      out.push({ key: `f:${meal}`, start: want, end: want, title: `${title} out`, sub: "About 1 h · can't be home in the window", kind: 'note', meal, blocking: false });
      return -1;
    }
    out.push({ key: `f:${meal}`, start: at, end: at + len, title, sub: meal === 'dinner' && s.settings.dinnerNote ? `${len} min · ${s.settings.dinnerNote}` : `${len} min`, kind: 'meal', meal, blocking: true });
    const tailOk = tail > 0 && free(at + len, tail);
    if (tailOk) tailFits.add(meal);
    busy.push([at, at + len + (tailOk ? tail : 0)]);
    return at + len;
  };
  // lunch at least 3 hours after breakfast: a late morning pushes it later (and stretches its window)
  const lunchWant = Math.max(day.lunchAt ?? st.lunchAt, morningEnd + 180);
  const lunchEnd = place('lunch', lunchWant, day.lunchMin ?? st.lunchMin, Math.max(660, morningEnd + 180 > (day.lunchAt ?? st.lunchAt) ? lunchWant : 660), Math.max(870, lunchWant + 150), dish);
  // Cooking: a block right before dinner that turns into dinner when it's done.
  let dinnerWant = day.dinnerAt ?? learnedDinner(s, date) ?? st.dinnerAt;
  const fam = day.cook === 'family';
  const cookLen = day.cookMin ?? cookMinutes(s, fam); // this day's own guess wins
  if (day.cook) {
    const cs = day.cookStart !== undefined ? minsOf(day.cookStart) : day.cookAt ?? dinnerWant - cookLen;
    const ce = day.cookEnd !== undefined ? minsOf(day.cookEnd) : cs + cookLen;
    dinnerWant = ce;
    out.push({ key: 'f:cook', start: cs, end: ce, title: fam ? 'Cooking for the family' : 'Cooking dinner', sub: day.cookEnd ? `${Math.round(ce - cs)} min` : `about ${cookLen} min · dinner right after`, kind: 'routine', blocking: true });
    busy.push([cs, ce]);
  }
  const dinnerEnd = place('dinner', dinnerWant, day.dinnerMin ?? st.dinnerMin, 1020, 1230, dish);
  const dishBlock = (key: string, meal: 'lunch' | 'dinner', after: number, label: string): Block => {
    const r = day.dishes?.[meal];
    const a = r ? minsOf(r.start) : after, e = r?.end !== undefined ? Math.max(a + 1, minsOf(r.end)) : a + dishLen;
    return { key, start: a, end: e, title: 'Dishes', sub: r?.end !== undefined ? `${Math.round(e - a)} min` : `${label} · about ${dishLen} min`, kind: 'routine', blocking: true };
  };
  const wd = weekday(date);
  // home from an open-ended outing where he ate: dishes first thing
  for (const e of eventsOn(s, date)) { const ba = e.untilBack ? day.backAt : undefined; if (dishToday && ba && dateOf(ba) === date && e.meals?.length) out.push({ key: 'f:dishes0', start: minsOf(ba), end: minsOf(ba) + dishLen, title: 'Dishes', sub: `About ${dishLen} min`, kind: 'routine', blocking: true }); }
  if (dishToday) {
    if (lunchEnd > 0 && (tailFits.has('lunch') || day.ate?.lunch)) out.push(dishBlock('f:dishes1', 'lunch', lunchEnd, 'After lunch'));
    if (dinnerEnd > 0 && (tailFits.has('dinner') || day.ate?.dinner)) out.push(dishBlock('f:dishes2', 'dinner', dinnerEnd, 'After dinner'));
  }
  out.push({ key: 'f:off', start: off, end: prep, title: 'Off Duty', sub: 'Protected · 2 h before bed', kind: 'offduty', blocking: true });
  const inBed = prep + (st.bedPrepMin ?? 50), sleepLen = st.sleepMin ?? 480;
  out.push({ key: 'f:sleep', start: inBed, end: inBed + sleepLen, title: 'Asleep', sub: `${Math.round(sleepLen / 6) / 10} h`, kind: 'sleep', blocking: true });
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** Free intervals between the morning routine and Off Duty. */
export function freeSlots(blocks: Block[], from: number): [number, number][] {
  const off = blocks.find((b) => b.kind === 'offduty')!;
  const morning = blocks.find((b) => b.key === 'f:morning')!;
  let cur = Math.max(from, morning.end);
  const out: [number, number][] = [];
  for (const b of blocks.filter((x) => x.blocking && x.start < off.start && x.key !== 'f:morning')) {
    if (b.start > cur) out.push([cur, b.start]);
    cur = Math.max(cur, b.end);
  }
  if (off.start > cur) out.push([cur, off.start]);
  return out;
}

/** A meal he started today and hasn't tapped done on, still within twice its usual length (after that, assume he forgot). */
export function eatingNow(s: State, date: string, nowMin: number): 'lunch' | 'dinner' | null {
  const d = s.days[date];
  for (const meal of ['lunch', 'dinner'] as const) {
    const got = d?.ate?.[meal]; if (!got || got.end !== undefined || nowMin < got.at) continue;
    const len = meal === 'lunch' ? d!.lunchMin ?? s.settings.lunchMin : d!.dinnerMin ?? s.settings.dinnerMin;
    if (nowMin < got.at + 2 * len) return meal;
  }
  return null;
}

/** How long dishes really take: the median of the last ones he timed (3 or more), else the setting. */
export function learnedDishes(s: State): number {
  const xs: number[] = [];
  for (const d of Object.values(s.days || {})) for (const r of Object.values(d.dishes || {})) if (r && r.end !== undefined && r.end - r.start >= 60000) xs.push((r.end - r.start) / 60000);
  const last = xs.slice(-10).sort((a, b) => a - b);
  return last.length >= 3 ? Math.max(5, Math.round(last[Math.floor(last.length / 2)] / 5) * 5) : s.settings.dishesMin;
}

/** US holidays he'll likely have plans on (until he says what they are). */
export function holidayName(date: string): string | null {
  const [y, mo, d] = date.split('-').map(Number), wd = weekday(date);
  const nth = (n: number) => Math.ceil(d / 7) === n, last = d + 7 > new Date(y, mo, 0).getDate();
  const easter = (() => { const a = y % 19, b = Math.floor(y / 100), c = y % 100, dd = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - dd - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451); return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1]; })();
  if (mo === 1 && d === 1) return "New Year's Day";
  if (mo === 12 && d === 31) return "New Year's Eve";
  if (mo === 12 && (d === 24 || d === 25)) return d === 24 ? 'Christmas Eve' : 'Christmas';
  if (mo === 7 && d === 4) return 'Independence Day';
  if (mo === 11 && wd === 4 && nth(4)) return 'Thanksgiving';
  if (mo === 11 && wd === 5 && d >= 23 && d <= 29) return 'Day after Thanksgiving';
  if (mo === 5 && wd === 1 && last) return 'Memorial Day';
  if (mo === 9 && wd === 1 && nth(1)) return 'Labor Day';
  if (mo === easter[0] && d === easter[1]) return 'Easter';
  return null;
}
