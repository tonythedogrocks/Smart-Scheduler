import type { State, Evt } from './types';
import { addDays, parseD, weekday } from './time';

export interface Block {
  key: string; start: number; end: number; title: string; sub?: string;
  kind: 'routine' | 'meal' | 'event' | 'travel' | 'offduty' | 'sleep' | 'note';
  evtId?: string; meal?: 'lunch' | 'dinner'; blocking: boolean;
}

/** The weekly rest day: essentials only. */
export const isRest = (s: State, date: string) => s.settings.restDay !== null && weekday(date) === s.settings.restDay;

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
  const wake = wakeFor(s, date);
  const prep = bedPrepFor(s, date);
  const off = prep - st.offDutyMin;
  out.push({ key: 'f:morning', start: wake, end: wake + st.morningMin, title: 'Awake, ready, breakfast', kind: 'routine', blocking: true });
  const busy: [number, number][] = [];
  for (const e of eventsOn(s, date)) {
    if (e.travel) out.push({ key: `f:to:${e.id}`, start: e.start - e.travel, end: e.start, title: `Travel to ${e.title}`, sub: `${e.travel} min`, kind: 'travel', evtId: e.id, blocking: true });
    out.push({ key: `f:ev:${e.id}`, start: e.start, end: e.end, title: e.title, sub: e.note, kind: 'event', evtId: e.id, blocking: true });
    if (e.travel) out.push({ key: `f:from:${e.id}`, start: e.end, end: e.end + e.travel, title: 'Travel home', sub: `${e.travel} min`, kind: 'travel', evtId: e.id, blocking: true });
    busy.push([e.start - e.travel, e.end + e.travel]);
  }
  const free = (a: number, len: number) => !busy.some(([b0, b1]) => overlaps(a, a + len, b0, b1));
  const place = (meal: 'lunch' | 'dinner', want: number, len: number, lo: number, hi: number) => {
    const title = meal === 'lunch' ? 'Lunch' : 'Dinner';
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
  const day = s.days[date] || {};
  const lunchEnd = place('lunch', day.lunchAt ?? st.lunchAt, st.lunchMin, 660, 870);
  const dinnerEnd = place('dinner', day.dinnerAt ?? st.dinnerAt, st.dinnerMin, 1020, 1230);
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
