import type { State, Evt } from './types';
import { addDays, dateOf, fmtT, minsOf, parseD, weekStart, weekday } from './time';
import { cookMinutes } from './learn';

export interface Block {
  key: string; start: number; end: number; title: string; sub?: string;
  kind: 'routine' | 'meal' | 'event' | 'travel' | 'offduty' | 'sleep' | 'note';
  evtId?: string; meal?: 'lunch' | 'dinner'; blocking: boolean; ate?: boolean; big?: boolean;
}

/** The weekly rest day: essentials only. */
export const isRest = (s: State, date: string) => s.settings.restDay !== null && weekday(date) === s.settings.restDay && !(s.settings.backupWeeks || []).includes(weekStart(date));
/** The rest day of a week that has been switched to a backup work day. */
export const isBackupDay = (s: State, date: string) => s.settings.restDay !== null && weekday(date) === s.settings.restDay && (s.settings.backupWeeks || []).includes(weekStart(date));

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
export function wakeFor(s: State, date: string): number {
  const ev = eventsOn(s, date)[0];
  if (!ev) return s.settings.wake;
  return Math.min(s.settings.wake, ev.start - ev.travel - s.settings.morningMin);
}

/** Start of getting ready for bed; moves earlier when tomorrow starts early. */
export function bedPrepFor(s: State, date: string): number {
  return s.settings.bedPrep - (s.settings.wake - wakeFor(s, addDays(date, 1)));
}

const overlaps = (a0: number, a1: number, b0: number, b1: number) => a0 < b1 && b0 < a1;

export function fixedBlocks(s: State, date: string): Block[] {
  const st = s.settings;
  const out: Block[] = [];
  // Planning assumes he starts on time.
  const wake = wakeFor(s, date);
  const prep = bedPrepFor(s, date);
  const off = prep - st.offDutyMin;
  // Planned length; on the day it lasts until he taps Done (see layoutDay).
  const mEnd = s.days[date]?.morningEnd;
  const morningEnd = mEnd && dateOf(mEnd) === date ? Math.max(wake + 1, minsOf(mEnd)) : wake + st.morningMin;
  const busy: [number, number][] = [[wake, morningEnd]];
  out.push({ key: 'f:morning', start: wake, end: morningEnd, title: 'Awake, ready, breakfast', kind: 'routine', blocking: true });
  for (const e of eventsOn(s, date)) {
    if (e.travel) out.push({ key: `f:to:${e.id}`, start: e.start - e.travel, end: e.start, title: `Travel to ${e.title}`, sub: `${e.travel} min`, kind: 'travel', evtId: e.id, blocking: true });
    out.push({ key: `f:ev:${e.id}`, start: e.start, end: e.end, title: e.title, sub: e.note, kind: 'event', evtId: e.id, blocking: true });
    if (e.travel) out.push({ key: `f:from:${e.id}`, start: e.end, end: e.end + e.travel, title: 'Travel home', sub: `${e.travel} min`, kind: 'travel', evtId: e.id, blocking: true });
    busy.push([e.start - e.travel, e.end + e.travel]);
  }
  const free = (a: number, len: number) => !busy.some(([b0, b1]) => overlaps(a, a + len, b0, b1));
  const day = s.days[date] || {};
  const place = (meal: 'lunch' | 'dinner', want: number, len: number, lo: number, hi: number) => {
    const title = meal === 'lunch' ? 'Lunch' : 'Dinner';
    // a confirmed meal sits exactly where it happened
    const got = day.ate?.[meal];
    if (got) {
      const end = got.end !== undefined && got.end > got.at ? got.end : got.at + len;
      out.push({ key: `f:${meal}`, start: got.at, end, title, sub: `Ate at ${fmtT(got.at)}${got.end !== undefined ? ` to ${fmtT(got.end)}` : ''}${got.big ? ' · large meal' : ''}`, kind: 'meal', meal, blocking: true, ate: true, big: got.big });
      busy.push([got.at, end]);
      return end;
    }
    let at = -1;
    if (free(want, len)) at = want;
    else {
      const c = busy.filter(([b0, b1]) => overlaps(want, want + len, b0, b1));
      const after = Math.max(...c.map((b) => b[1])), before = Math.min(...c.map((b) => b[0])) - len;
      if (after <= hi && free(after, len)) at = after;
      else if (before >= lo && free(before, len)) at = before;
    }
    if (at < 0) {
      out.push({ key: `f:${meal}`, start: want, end: want, title: `${title} out`, sub: "About 1 h · can't be home in the window", kind: 'note', meal, blocking: false });
      return -1;
    }
    out.push({ key: `f:${meal}`, start: at, end: at + len, title, sub: meal === 'dinner' && s.settings.dinnerNote ? `${len} min · ${s.settings.dinnerNote}` : `${len} min`, kind: 'meal', meal, blocking: true });
    busy.push([at, at + len]);
    return at + len;
  };
  const lunchEnd = place('lunch', day.lunchAt ?? st.lunchAt, day.lunchMin ?? st.lunchMin, 660, 870);
  // Cooking: a block right before dinner that turns into dinner when it's done.
  let dinnerWant = day.dinnerAt ?? learnedDinner(s, date) ?? st.dinnerAt;
  const fam = day.cook === 'family';
  const cookLen = cookMinutes(s, fam);
  if (day.cook) {
    const cs = day.cookStart !== undefined ? minsOf(day.cookStart) : day.cookAt ?? dinnerWant - cookLen;
    const ce = day.cookEnd !== undefined ? minsOf(day.cookEnd) : cs + cookLen;
    dinnerWant = ce;
    out.push({ key: 'f:cook', start: cs, end: ce, title: fam ? 'Cooking for the family' : 'Cooking dinner', sub: day.cookEnd ? `${Math.round(ce - cs)} min` : `about ${cookLen} min · dinner right after`, kind: 'routine', blocking: true });
    busy.push([cs, ce]);
  }
  const dinnerEnd = place('dinner', dinnerWant, day.dinnerMin ?? st.dinnerMin, 1020, 1230);
  const wd = weekday(date);
  if (st.dishDays.includes(wd)) {
    if (lunchEnd > 0) out.push({ key: 'f:dishes1', start: lunchEnd, end: lunchEnd + st.dishesMin, title: 'Dishes', sub: 'After lunch · 15 to 30 min', kind: 'routine', blocking: true });
    if (dinnerEnd > 0) out.push({ key: 'f:dishes2', start: dinnerEnd, end: dinnerEnd + st.dishesMin, title: 'Dishes', sub: 'After dinner · 15 to 30 min', kind: 'routine', blocking: true });
  }
  out.push({ key: 'f:off', start: off, end: prep, title: 'Off Duty', sub: 'Protected · 2 h before bed', kind: 'offduty', blocking: true });
  out.push({ key: 'f:sleep', start: prep + 50, end: prep + 50 + 480, title: 'Asleep', sub: '8 h', kind: 'sleep', blocking: true });
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
