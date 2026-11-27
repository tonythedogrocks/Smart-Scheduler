import { describe, it, expect } from 'vitest';
import { sample } from './fixture';
import { forecast, layoutDay, planSig, type PlanItem } from '../src/model/planner';
import { fixedBlocks, wakeFor, bedPrepFor } from '../src/model/schedule';
import { addDays, fmtT } from '../src/model/time';
import type { State } from '../src/model/types';

const at = (iso: string) => new Date(iso).getTime();
const MON = '2026-11-09', NOW = at('2026-11-09T07:00:00');
let n = 0;
const fresh = (): State => { const s = sample(); s.updatedAt = ++n; return s; };
const plan = (s: State, date = MON, now = NOW) => layoutDay(s, forecast(s, now), date, now);
const tasks = (xs: PlanItem[]) => xs.filter((i) => i.kind === 'mission' && !i.done);
const overlaps = (xs: PlanItem[]) => {
  const busy = xs.filter((i) => i.end > i.start && (i.kind === 'mission' || i.block?.blocking) && i.block?.kind !== 'sleep').sort((a, b) => a.start - b.start);
  return busy.some((a, i) => busy.slice(i + 1).some((b) => b.start < a.end && !(a.block?.evtId && a.block.evtId === b.block?.evtId)));
};

describe('schedule', () => {
  it('default day: wake 8:00, Off Duty before bed, asleep after', () => {
    const b = fixedBlocks(fresh(), MON);
    expect(fmtT(b.find((x) => x.key === 'f:morning')!.start)).toBe('8:00');
    expect(b.find((x) => x.kind === 'offduty')!.end).toBeLessThan(b.find((x) => x.kind === 'sleep')!.start);
  });
  it('an early commitment moves the wake-up and the night before', () => {
    const s = fresh();
    s.events.push({ id: 'x', title: 'Shift', kind: 'shift', date: '2026-11-13', start: 420, end: 780, travel: 20 });
    expect(wakeFor(s, '2026-11-13')).toBe(340);
    expect(bedPrepFor(s, '2026-11-12')).toBe(1390 - 140);
  });
});

describe('a day', () => {
  it('has the floor, deadline work and goals, with nothing overlapping and Off Duty left alone', () => {
    const xs = plan(fresh());
    const ids = new Set(tasks(xs).map((i) => i.missionId));
    for (const id of ['cards', 'stretch', 'strength', 'breathe']) expect(ids.has(id)).toBe(true);
    expect(ids.has('exam-steps')).toBe(true);
    expect(overlaps(xs)).toBe(false);
    const off = xs.find((i) => i.block?.kind === 'offduty')!;
    expect(tasks(xs).some((i) => i.start < off.end && off.start < i.end)).toBe(false);
  });
  it('fills the day: little free time is left', () => {
    const xs = plan(fresh());
    const fixedMin = xs.filter((i) => i.kind === 'fixed' && i.block?.blocking && i.block.kind !== 'sleep').reduce((a, i) => a + i.end - i.start, 0);
    const taskMin = tasks(xs).reduce((a, i) => a + i.end - i.start, 0);
    expect(taskMin).toBeGreaterThan(0.6 * (21 * 60 - 8 * 60 - fixedMin));
  });
  it('workouts wait after a meal', () => {
    const xs = plan(fresh());
    const lunch = xs.find((i) => i.block?.meal === 'lunch' && i.block.kind === 'meal')!;
    for (const w of tasks(xs).filter((i) => i.missionId === 'court')) expect(w.start >= lunch.end + 90 || w.end <= lunch.start).toBe(true);
  });
  it('a skipped task leaves today; a date it can\'t happen on leaves that day', () => {
    const s = fresh();
    s.days[MON] = { misses: [{ m: 'sketch', at: 600, skip: true }] };
    expect(tasks(plan(s)).some((i) => i.missionId === 'sketch')).toBe(false);
    const s2 = fresh();
    s2.missions.find((m) => m.id === 'court')!.skipOn = [MON];
    expect(tasks(plan(s2)).some((i) => i.missionId === 'court')).toBe(false);
  });
  it('the weekly rest day has the floor and nothing more', () => {
    const sun = '2026-11-15', xs = tasks(plan(fresh(), sun));
    expect(xs.length).toBeGreaterThan(0);
    expect(xs.every((i) => ['cards', 'stretch', 'strength', 'breathe', 'vocal'].includes(i.missionId!))).toBe(true);
  });
  it('steps of a chain stay in order', () => {
    const s = fresh();
    s.missions.find((m) => m.id === 'exam-steps')!.unitsLeft = 1;
    const xs = tasks(plan(s, MON, at('2026-11-09T07:00:00')));
    const a = xs.find((i) => i.missionId === 'exam-steps'), b = xs.find((i) => i.missionId === 'exam-tests');
    if (a && b) expect(b.start).toBeGreaterThanOrEqual(a.end);
  });
  it('the same data always gives the same day', () => {
    const s = fresh();
    expect(JSON.stringify(plan(s))).toBe(JSON.stringify(plan(s)));
  });
  it('a saved plan stands until something it depends on changes', () => {
    const s = fresh(), now = at('2026-11-09T10:00:00');
    s.days[MON] = { morningEnd: at('2026-11-09T08:50:00') };
    const sig = planSig(s, MON);
    s.days[MON].plan = { sig, items: [{ key: 'm:sketch:0', missionId: 'sketch', start: 700, end: 730, title: 'sketch' }] };
    s.updatedAt = ++n;
    expect(tasks(plan(s, MON, now)).map((i) => i.key)).toEqual(['m:sketch:0']);
    s.events.push({ id: 'y', title: 'Thing', kind: 'event', date: MON, start: 900, end: 960, travel: 0 });
    s.updatedAt = ++n;
    expect(tasks(plan(s, MON, now)).length).toBeGreaterThan(1);
  });
  it('tomorrow and later days are planned too', () => {
    const s = fresh();
    expect(tasks(plan(s, addDays(MON, 1))).length).toBeGreaterThan(3);
    expect(tasks(plan(s, addDays(MON, 10))).length).toBeGreaterThan(3);
  });
});

describe('deadlines', () => {
  it('lands on time with room to spare: no warning', () => {
    const fc = forecast(fresh(), NOW);
    expect(fc.warns.filter((w) => w.objectiveId === 'course')).toEqual([]);
    expect(fc.landing.course! <= '2026-12-05').toBe(true);
  });
  it('MISSION FAILURE when even every free hour is not enough', () => {
    const s = fresh();
    s.missions.find((m) => m.id === 'course-lessons')!.unitsLeft = 2000;
    expect(forecast(s, NOW).warns.some((w) => w.objectiveId === 'course' && w.kind === 'failure')).toBe(true);
  });
  it('FINAL STAND when his usual pace is not enough, and its tasks today are marked', () => {
    const s = fresh();
    s.missions.find((m) => m.id === 'course-lessons')!.unitsLeft = 90;
    const fc = forecast(s, NOW);
    expect(fc.warns.some((w) => w.kind === 'pace')).toBe(true);
    expect(tasks(layoutDay(s, fc, MON, NOW)).some((i) => i.missionId === 'course-lessons' && i.must)).toBe(true);
  });
  it('waits for a grading period before the next step', () => {
    const s = fresh();
    Object.assign(s.missions.find((m) => m.id === 'cert-course')!, { unitsLeft: 0, doneAt: MON });
    const fc = forecast(s, NOW);
    for (let t = 0; t < 14; t++) expect(fc.days[t].needs.some((x) => x.missionId === 'cert-exam')).toBe(false);
  });
});

describe('a missed task', () => {
  it('stays in today\'s plan later on; something less important gives way', () => {
    const s = fresh(), now = at('2026-11-09T13:00:00');
    s.days[MON] = { morningEnd: at('2026-11-09T08:50:00'), misses: [{ m: 'exam-steps', at: 600 }] };
    expect(tasks(plan(s, MON, now)).some((i) => i.missionId === 'exam-steps' && i.start >= 780)).toBe(true);
  });
});
