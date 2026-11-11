import { describe, it, expect } from 'vitest';
import { sample } from './fixture';
import { forecast, layoutDay, orders, habitsDue } from '../src/model/planner';
import { fixedBlocks, wakeFor, bedPrepFor } from '../src/model/schedule';
import { buildLibrary } from '../src/model/vm';
import { fmtT } from '../src/model/time';
import type { State } from '../src/model/types';

const at = (iso: string) => new Date(iso).getTime();
const fresh = (level?: number, date = '2026-11-11'): State => { const s = sample(); if (level) s.days[date] = { level: level as any }; return s; };

describe('schedule', () => {
  it('default day: wake 8:00, Off Duty 9:10pm, asleep midnight', () => {
    const b = fixedBlocks(fresh(), '2026-11-12');
    expect(fmtT(b.find((x) => x.key === 'f:morning')!.start)).toBe('8:00');
    expect(b.find((x) => x.kind === 'offduty')!.start).toBe(21 * 60 + 10);
    expect(b.find((x) => x.kind === 'sleep')!.start).toBe(1440);
  });
  it('early commitment moves the wake-up and the night before', () => {
    const s = fresh();
    s.events.push({ id: 'x', title: 'Shift', kind: 'shift', date: '2026-11-13', start: 420, end: 780, travel: 20 });
    expect(wakeFor(s, '2026-11-13')).toBe(340);
    expect(bedPrepFor(s, '2026-11-12')).toBe(1390 - 140);
  });
  it('weekly event with travel; dishes on dish days; picked start time', () => {
    expect(fixedBlocks(fresh(), '2026-11-11').some((x) => x.title === 'Appointment' && x.start === 840)).toBe(true);
    expect(fixedBlocks(fresh(), '2026-11-13').filter((x) => x.title === 'Dishes').length).toBe(2);
    const s = fresh(); s.days['2026-11-15'] = { starts: { gathering: 660 } };
    expect(fixedBlocks(s, '2026-11-15').find((x) => x.title === 'Gathering')!.start).toBe(660);
  });
});

describe('planner', () => {
  it('Recovery day is floor only', () => {
    const s = fresh(1);
    const fc = forecast(s, at('2026-11-11T09:00'));
    expect(fc.days[0].blocks.every((b) => b.habit)).toBe(true);
    expect(fc.days[0].blocks.map((b) => b.missionId).sort()).toEqual(['breathe', 'cards']);
  });
  it('On Duty day mixes goals, respects capacity, never plans into Off Duty', () => {
    const s = fresh(3);
    const now = at('2026-11-11T09:00');
    const fc = forecast(s, now);
    const work = fc.days[0].blocks.filter((b) => !b.habit);
    expect(work.reduce((a, b) => a + b.min, 0)).toBeLessThanOrEqual(215);
    expect(new Set(work.map((b) => b.missionId)).size).toBeGreaterThanOrEqual(2);
    const s5 = fresh(5);
    const w5 = forecast(s5, now).days[0].blocks.map((b) => b.missionId);
    // a big day still makes room for goals with no deadline
    expect(w5.some((id) => ['sketch', 'lang-study', 'court'].includes(id))).toBe(true);
    const items = layoutDay(s, fc, '2026-11-11', now);
    for (const i of items.filter((x) => x.kind === 'mission')) expect(i.end).toBeLessThanOrEqual(21 * 60 + 10);
    const mi = items.filter((x) => x.kind === 'mission'), fx = items.filter((x) => x.kind === 'fixed' && x.block!.blocking);
    for (const m of mi) for (const f of fx) expect(m.start < f.end && f.start < m.end).toBe(false);
    expect(orders(items).now).toBeTruthy();
  });
  it('late in the day nothing piles up', () => {
    const s = fresh(3);
    const now = at('2026-11-11T20:30');
    const items = layoutDay(s, forecast(s, now), '2026-11-11', now);
    expect(items.filter((x) => x.kind === 'mission').reduce((a, b) => a + (b.end - b.start), 0)).toBeLessThanOrEqual(40);
  });
  it('rest day plans no goal missions by default', () => {
    const s = fresh(4, '2026-11-15');
    const fc = forecast(s, at('2026-11-15T09:00'));
    expect(fc.days[0].blocks.length).toBe(0);
  });
  it('flags the sprint when a modest pace misses it, with landing dates', () => {
    const s = fresh(3);
    const fc = forecast(s, at('2026-11-11T09:00'));
    expect(fc.risks.some((r) => r.objectiveId === 'cert')).toBe(true);
  });
  it('PT strength is every other day', () => {
    const s = fresh(3);
    s.logs.push({ id: 'a', missionId: 'strength', date: '2026-11-10', start: 0, end: 1, plannedMin: 15, units: 1, done: true });
    expect(habitsDue(s, '2026-11-11', 3).some((m) => m.id === 'strength')).toBe(false);
    expect(habitsDue(s, '2026-11-12', 3).some((m) => m.id === 'strength')).toBe(true);
  });
  it('builds the library', () => {
    const s = fresh(3);
    const lib = buildLibrary(s, at('2026-11-11T10:00'));
    expect(lib.cols.length).toBe(4);
    expect(lib.cols[0].issues.length).toBe(7);
    expect(lib.resume).toBeTruthy();
  });
});

describe('horizon', () => {
  it('reports landing dates', () => {
    const s = sample(); s.days['2026-11-11'] = { level: 3 };
    const fc = forecast(s, new Date('2026-11-11T09:00').getTime());
    expect(fc.landing.exam).toBeTruthy();
    expect(fc.landing.course).toBeTruthy();
  });
});
