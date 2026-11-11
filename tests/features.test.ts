import { describe, it, expect } from 'vitest';
import { sample } from './fixture';
import { forecast, layoutDay } from '../src/model/planner';
import { eventsOn, inWeeks } from '../src/model/schedule';
import { afterStats, bestParts, choreDue, choreInterval, exerciseCeiling } from '../src/model/learn';
import { addDays } from '../src/model/time';
import type { Log, State } from '../src/model/types';

const at = (iso: string) => new Date(iso).getTime();
let n = 0;
const log = (missionId: string, date: string, startHM: string, min: number, done = true, x: Partial<Log> = {}): Log => {
  const start = at(`${date}T${startHM}`);
  return { id: `l${n++}`, missionId, date, start, end: start + min * 60000, plannedMin: min, units: 1, done, ...x };
};
const withChore = (s: State) => {
  s.missions.push({ id: 'chore', objectiveId: '', title: 'Chore', kind: 'chore', energy: 'none', minutes: 5, minLevel: 1, everyDays: 7,
    steps: [{ at: 0, min: 5, title: 'Step one' }, { at: 60, min: 5, title: 'Step two' }, { at: 140, min: 5, title: 'Step three' }, { at: 220, min: 5, title: 'Step four' }] });
  return s;
};

describe('exercise ceiling', () => {
  it('starts at the low end and only grows after a good, quiet week', () => {
    const s = sample();
    for (let i = 0; i < 7; i++) s.days[addDays('2026-11-02', i)] = { level: 3 };
    expect(exerciseCeiling(s, '2026-11-04').cap).toBe(150);
    // week of Nov 2: 120 min done (80% of 150), no flares -> grows 10%
    for (const d of ['2026-11-03', '2026-11-05', '2026-11-07']) s.logs.push(log('court', d, '10:00', 40));
    expect(exerciseCeiling(s, '2026-11-11').cap).toBe(165);
    // a flare spike that week steps it back instead
    s.flares.push({ id: 'f1', ts: at('2026-11-04T09:00'), rating: 8 });
    expect(exerciseCeiling(s, '2026-11-11').cap).toBe(150);
  });
  it('base routines never count, and the plan stops adding workouts at the ceiling', () => {
    const s = sample(); s.days['2026-11-11'] = { level: 5 };
    s.logs.push(log('stretch', '2026-11-10', '09:00', 15));
    expect(exerciseCeiling(s, '2026-11-11').done).toBe(0);
    s.logs.push(log('court', '2026-11-09', '10:00', 130));
    const blocks = forecast(s, at('2026-11-11T09:00')).days[0].blocks.map((b) => b.missionId);
    expect(blocks).not.toContain('court');
    expect(blocks).toContain('stretch');
  });
});

describe('monthly repeats', () => {
  it('2nd and 4th Saturday only', () => {
    expect(inWeeks('2026-11-14', [2, 4])).toBe(true);   // 2nd Sat
    expect(inWeeks('2026-11-21', [2, 4])).toBe(false);  // 3rd Sat
    expect(inWeeks('2026-11-28', [2, 4])).toBe(true);   // 4th Sat
    expect(inWeeks('2026-11-28', [5])).toBe(true);      // also the last
    const s = sample();
    s.events.push({ id: 'club', title: 'Club', kind: 'event', weekday: 6, nth: [2, 4], start: 810, end: 885, travel: 25 });
    expect(eventsOn(s, '2026-11-14').some((e) => e.id === 'club')).toBe(true);
    expect(eventsOn(s, '2026-11-21').some((e) => e.id === 'club')).toBe(false);
  });
});

describe('chores with steps', () => {
  it('is not planned until it has a last date, then lands every step at home', () => {
    const s = withChore(sample()); s.days['2026-11-12'] = { level: 3 };
    const now = at('2026-11-12T09:00');
    expect(layoutDay(s, forecast(s, now), '2026-11-12', now).some((i) => i.missionId === 'chore')).toBe(false);
    s.missions.find((m) => m.id === 'chore')!.lastAt = '2026-11-05'; s.updatedAt = Math.random();
    const items = layoutDay(s, forecast(s, now), '2026-11-12', now);
    const steps = items.filter((i) => i.missionId === 'chore');
    expect(steps.map((i) => i.step)).toEqual([0, 1, 2, 3]);
    expect(steps[1].start - steps[0].start).toBe(60);
    expect(steps[3].start - steps[0].start).toBe(220);
    const blocking = items.filter((i) => i.kind === 'fixed' && i.block!.blocking);
    for (const st of steps) for (const f of blocking) expect(st.start < f.end && f.start < st.end).toBe(false);
    for (const m of items.filter((i) => i.kind === 'mission' && i.missionId !== 'chore')) for (const st of steps) expect(m.start < st.end && st.start < m.end).toBe(false);
  });
  it('stays anchored to when it was actually started', () => {
    const s = withChore(sample()); s.days['2026-11-12'] = { level: 3 };
    s.missions.find((m) => m.id === 'chore')!.lastAt = '2026-11-05';
    s.logs.push(log('chore', '2026-11-12', '10:07', 5, true, { step: 0 }));
    const now = at('2026-11-12T10:30');
    const steps = layoutDay(s, forecast(s, now), '2026-11-12', now).filter((i) => i.missionId === 'chore');
    expect(steps.find((i) => i.step === 1)!.start).toBe(10 * 60 + 7 + 60);
  });
  it('learns the real gap after a few runs', () => {
    const s = withChore(sample()); const m = s.missions.find((x) => x.id === 'chore')!;
    for (const d of ['2026-10-01', '2026-10-11', '2026-10-21', '2026-10-31']) s.logs.push(log('chore', d, '14:00', 5, true, { step: 3 }));
    expect(choreInterval(s, m)).toEqual({ days: 10, learned: true });
    expect(choreDue(s, m)).toBe('2026-11-10');
  });
});

describe('learned timing', () => {
  it('prefers the better part of the day only once a pattern is clear', () => {
    const s = sample();
    expect(bestParts(s, 'mental')).toBeNull();
    for (let i = 0; i < 10; i++) {
      const d = addDays('2026-10-01', i);
      s.logs.push(log('course-lessons', d, '09:00', 30, i < 9));
      s.logs.push(log('course-lessons', d, '15:00', 30, i < 4));
    }
    expect(bestParts(s, 'mental')![0]).toBe(0);
    s.days['2026-11-12'] = { level: 3 }; s.updatedAt = Math.random();
    const now = at('2026-11-12T08:00');
    const first = layoutDay(s, forecast(s, now), '2026-11-12', now).find((i) => i.kind === 'mission' && s.missions.find((m) => m.id === i.missionId)?.energy === 'mental' && s.missions.find((m) => m.id === i.missionId)?.kind !== 'habit');
    expect(first!.start).toBeLessThan(660);
  });
  it('spots what tends to come before unfinished work', () => {
    const s = sample();
    for (let i = 0; i < 12; i++) {
      const d = addDays('2026-10-01', i);
      s.events.push({ id: `sh${i}`, title: 'Shift', kind: 'shift', date: d, start: 600, end: 840, travel: 20 });
      s.logs.push(log('course-lessons', d, '15:10', 30, i < 3));      // straight after a shift
      s.logs.push(log('course-lessons', d, '19:30', 30, i < 11));     // later on
    }
    const got = afterStats(s).find((a) => a.after === 'shift' && a.energy === 'mental');
    expect(got?.worse).toBe(true);
  });
});
