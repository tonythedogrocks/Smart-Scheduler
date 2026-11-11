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

describe('concrete missions', () => {
  it('describes named units', async () => {
    const { describeUnits } = await import('../src/model/planner');
    expect(describeUnits(['Ch 1|lesson 1', 'Ch 1|lesson 2', 'Ch 1|lesson 3'])).toBe('Ch 1: lessons 1–3');
    expect(describeUnits(['Ch 1|lesson 7', 'Ch 1|chapter quiz', 'Ch 1|chapter quiz', 'Ch 2|chapter quiz'])).toBe('Ch 1: lesson 7 + chapter quiz · Ch 2: chapter quiz');
    expect(describeUnits(['Final review'])).toBe('Final review');
  });
  it('plans named blocks in order, keeps a two-unit item whole, and respects start dates', () => {
    const s = sample(); s.days['2026-11-12'] = { level: 4 };
    const m = s.missions.find((x) => x.id === 'exam-steps')!;
    m.unitsLeft = 6; m.unitsTotal = 6; m.minutes = 10; m.maxBlockUnits = 3;
    m.labels = ['Ch 1|lesson 1', 'Ch 1|lesson 2', 'Ch 1|chapter quiz', 'Ch 1|chapter quiz', 'Ch 2|lesson 1', 'Ch 2|lesson 2'];
    s.missions.push({ id: 'review', objectiveId: 'exam', title: 'Light review', kind: 'work', energy: 'mental', minutes: 30, minLevel: 2, unitsLeft: 1, unitsTotal: 1, notBefore: '2026-11-16' });
    const now = at('2026-11-12T08:00');
    const fc = forecast(s, now);
    const subs = layoutDay(s, fc, '2026-11-12', now).filter((i) => i.missionId === 'exam-steps').map((i) => i.sub);
    expect(subs[0]).toMatch(/^Ch 1: lessons 1–2 \+ chapter quiz/);
    expect(fc.days[0].blocks.some((b) => b.missionId === 'review')).toBe(false);
    const d16 = fc.days.find((d) => d.date === '2026-11-16')!;
    expect(fc.days.slice(0, 4).some((d) => d.blocks.some((b) => b.missionId === 'review'))).toBe(false);
    void d16;
  });
});

describe('far-off deadlines', () => {
  it('paces toward a deadline beyond the planning window without flagging it', () => {
    const s = sample(); s.days['2026-11-12'] = { level: 3 };
    for (const o of s.objectives) delete o.due; // no near deadlines competing in this case
    s.objectives.find((o) => o.id === 'lang')!.due = '2029-03-15';
    s.missions.push({ id: 'lang-course', objectiveId: 'lang', title: 'Course', kind: 'work', energy: 'mental', minutes: 30, minLevel: 3, unitsLeft: 300, unitsTotal: 300, maxBlockUnits: 2, dailyCapMin: 60 });
    const fc = forecast(s, at('2026-11-12T08:00'));
    expect(fc.risks.some((r) => r.objectiveId === 'lang')).toBe(false);
    const weekly = fc.days.slice(0, 7).reduce((a, d) => a + d.blocks.filter((b) => b.missionId === 'lang-course').reduce((x, b) => x + b.min, 0), 0);
    expect(weekly).toBeGreaterThan(0);
  });
});

describe('starting the day', () => {
  it('starts the morning routine when he reports in, and plans from there', () => {
    const s = sample();
    s.days['2026-11-12'] = { level: 3, setAt: at('2026-11-12T11:02') };
    const now = at('2026-11-12T11:05');
    const items = layoutDay(s, forecast(s, now), '2026-11-12', now);
    const morning = items.find((i) => i.key === 'f:morning')!;
    expect(morning.start).toBe(11 * 60);
    for (const m of items.filter((i) => i.kind === 'mission')) expect(m.start).toBeGreaterThanOrEqual(morning.end);
    const lunch = items.find((i) => i.key === 'f:lunch')!;
    expect(lunch.start).toBeGreaterThanOrEqual(morning.end);
  });
});

describe('cooking dinner', () => {
  it('puts cooking right before dinner, then dinner starts when cooking is done', async () => {
    const { fixedBlocks } = await import('../src/model/schedule');
    const s = sample();
    s.days['2026-11-12'] = { cook: true };
    let b = fixedBlocks(s, '2026-11-12');
    const cook = b.find((x) => x.key === 'f:cook')!, dinner = b.find((x) => x.key === 'f:dinner')!;
    expect(cook.end).toBe(dinner.start);
    expect(cook.end - cook.start).toBe(45);
    s.days['2026-11-12'] = { cook: true, cookStart: at('2026-11-12T17:10'), cookEnd: at('2026-11-12T18:05'), dinnerAt: 18 * 60 + 5 };
    b = fixedBlocks(s, '2026-11-12');
    expect(b.find((x) => x.key === 'f:dinner')!.start).toBe(18 * 60 + 5);
  });
  it('learns how long cooking really takes', async () => {
    const { cookMinutes } = await import('../src/model/learn');
    const s = sample();
    s.days['2026-11-01'] = { cook: true, cookStart: at('2026-11-01T17:00'), cookEnd: at('2026-11-01T18:00') };
    expect(cookMinutes(s)).toBe(45);
    s.days['2026-11-02'] = { cook: true, cookStart: at('2026-11-02T17:00'), cookEnd: at('2026-11-02T18:10') };
    expect(cookMinutes(s)).toBe(65);
  });
});
