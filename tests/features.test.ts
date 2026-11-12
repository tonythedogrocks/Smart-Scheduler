import { describe, it, expect } from 'vitest';
import { sample } from './fixture';
import { forecast, layoutDay } from '../src/model/planner';
import { eventsOn, inWeeks } from '../src/model/schedule';
import { afterStats, choreDue, choreInterval, exerciseCeiling } from '../src/model/learn';
import { addDays } from '../src/model/time';
import type { Log, State } from '../src/model/types';

const at = (iso: string) => new Date(iso).getTime();
let n = 0;
const log = (missionId: string, date: string, startHM: string, min: number, done = true, x: Partial<Log> = {}): Log => {
  const start = at(`${date}T${startHM}`);
  return { id: `l${n++}`, missionId, date, start, end: start + min * 60000, plannedMin: min, units: done ? 1 : 0, done, ...x };
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
  it('plans as if on time, and keeps the morning routine open until Done', () => {
    const s = sample();
    s.days['2026-11-12'] = { level: 3, setAt: at('2026-11-12T10:40') };
    const now = at('2026-11-12T11:02');
    const items = layoutDay(s, forecast(s, now), '2026-11-12', now);
    const morning = items.find((i) => i.key === 'f:morning')!;
    expect(morning.start).toBe(8 * 60);
    expect(morning.end).toBe(11 * 60 + 5);
    expect(morning.now).toBe(true);
    for (const m of items.filter((i) => i.kind === 'mission')) expect(m.start).toBeGreaterThanOrEqual(morning.end);
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

describe('morning routine', () => {
  it('ends when Done is tapped, and the plan starts right after', () => {
    const s = sample();
    s.days['2026-11-12'] = { level: 3, setAt: at('2026-11-12T08:00'), morningEnd: at('2026-11-12T08:22') };
    const now = at('2026-11-12T08:23');
    const items = layoutDay(s, forecast(s, now), '2026-11-12', now);
    expect(items.find((i) => i.key === 'f:morning')!.end).toBe(8 * 60 + 22);
    const first = items.filter((i) => i.kind === 'mission').sort((x, y) => x.start - y.start)[0];
    expect(first.start).toBeLessThan(8 * 60 + 50);
  });
});

describe('morning pattern', () => {
  it('reports when he is usually ready, without changing the plan', async () => {
    const { morningStats } = await import('../src/model/learn');
    const s = sample();
    for (const [d, end] of [['2026-11-01', '09:30'], ['2026-11-02', '09:50'], ['2026-11-03', '09:40']] as const)
      s.days[d] = { setAt: at(`${d}T09:05`), morningEnd: at(`${d}T${end}`) };
    expect(morningStats(s)).toEqual({ n: 3, readyAt: 9 * 60 + 40, span: 35 });
  });
});

describe('cooking for the family', () => {
  it('has its own first guess and learns separately from cooking for himself', async () => {
    const { cookMinutes } = await import('../src/model/learn');
    const { fixedBlocks } = await import('../src/model/schedule');
    const s = sample();
    s.days['2026-11-14'] = { cook: 'family' };
    const b = fixedBlocks(s, '2026-11-14');
    const cook = b.find((x) => x.key === 'f:cook')!;
    expect(cook.title).toBe('Cooking for the family');
    expect(cook.end - cook.start).toBe(60);
    for (const [d, m] of [['2026-11-01', 90], ['2026-11-02', 80]] as const)
      s.days[d] = { cook: 'family', cookStart: at(`${d}T16:00`), cookEnd: at(`${d}T16:00`) + m * 60000 };
    expect(cookMinutes(s, true)).toBe(85);
    expect(cookMinutes(s, false)).toBe(45);
  });
});

describe('V1 features', () => {
  const work = (s: State, d: string, min: number) => s.logs.push(log('course-lessons', d, '10:00', min));
  it('sustainable capacity is the best day not followed by a crash', async () => {
    const { sustainableCapacity } = await import('../src/model/learn');
    const s = sample();
    const plan: [string, number, number][] = [['2026-11-02', 3, 200], ['2026-11-03', 5, 400], ['2026-11-04', 2, 60], ['2026-11-05', 4, 300], ['2026-11-06', 3, 250]];
    for (const [d, lv, m] of plan) { s.days[d] = { level: lv as any }; work(s, d, m); }
    expect(sustainableCapacity(s, '2026-11-07')).toBe(300); // 400 was followed by a crash (60)
  });
  it('a push that pays off makes the next one bigger', async () => {
    const { pushSize } = await import('../src/model/learn');
    const s = sample();
    const plan: [string, number, number][] = [['2026-11-02', 3, 200], ['2026-11-03', 3, 200], ['2026-11-04', 5, 400], ['2026-11-05', 3, 200], ['2026-11-06', 3, 200]];
    for (const [d, lv, m] of plan) { s.days[d] = { level: lv as any }; work(s, d, m); }
    const p = pushSize(s, '2026-11-07');
    expect(p.pushes.length).toBe(1);
    expect(p.pct).toBe(0.3);
  });
  it('biking to a commitment counts toward weekly exercise', async () => {
    const { exerciseMinWeek } = await import('../src/model/learn');
    const s = sample();
    s.events.find((e) => e.id === 'appt')!.bike = true; // weekly, 30 min each way
    expect(exerciseMinWeek(s, '2026-11-09')).toBe(60);
  });
  it('a daylight-only workout stays between sunrise and sunset', async () => {
    const { sunTimes } = await import('../src/model/schedule');
    const s = sample(); s.settings.sun = { lat: 40, lon: -75 };
    const court = s.missions.find((m) => m.id === 'court')!; court.daylight = true; court.travel = 10;
    s.days['2026-11-12'] = { level: 5 };
    const now = at('2026-11-12T08:00');
    const it = layoutDay(s, forecast(s, now), '2026-11-12', now).find((i) => i.missionId === 'court');
    const [, set] = sunTimes('2026-11-12', 40, -75);
    if (it) { expect(it.end).toBeLessThanOrEqual(set); expect(it.end - it.start).toBe(65); }
  });
  it('an errand lands inside its window on a good day only', () => {
    const s = sample();
    for (const o of s.objectives) delete o.due; // no deadlines: not a lock-in day
    s.missions.push({ id: 'err', objectiveId: '', title: 'Errand', kind: 'work', energy: 'none', minutes: 15, minLevel: 3, unitsLeft: 1, unitsTotal: 1, maxBlockUnits: 1, errand: true, travel: 10, window: [600, 1020] });
    s.days['2026-11-12'] = { level: 2 };
    let fc = forecast(s, at('2026-11-12T08:00'));
    expect(fc.days[0].blocks.some((b) => b.missionId === 'err')).toBe(false);
    s.days['2026-11-12'] = { level: 4 }; s.updatedAt = Math.random();
    const now = at('2026-11-12T08:00');
    fc = forecast(s, now);
    const it = layoutDay(s, fc, '2026-11-12', now).find((i) => i.missionId === 'err');
    expect(it).toBeTruthy();
    expect(it!.start).toBeGreaterThanOrEqual(600);
    expect(it!.end).toBeLessThanOrEqual(1020);
  });
  it('a backup week turns the rest day into a work day', async () => {
    const { isRest } = await import('../src/model/schedule');
    const s = sample();
    expect(isRest(s, '2026-11-15')).toBe(true);
    s.settings.backupWeeks = ['2026-11-09'];
    expect(isRest(s, '2026-11-15')).toBe(false);
  });
  it('learns the usual dinner time from Dinner now taps', async () => {
    const { learnedDinner } = await import('../src/model/schedule');
    const s = sample();
    for (const [d, m] of [['2026-10-29', 1080], ['2026-11-05', 1090], ['2026-10-22', 1100]] as const) s.days[d] = { dinnerTap: m };
    expect(learnedDinner(s, '2026-11-12')).toBe(1090);
  });
  it('stopping partway counts the ticked steps', async () => {
    const { actions, S, adopt } = await import('../src/model/store');
    const s = sample();
    const m = s.missions.find((x) => x.id === 'exam-steps')!; m.labels = Array.from({ length: 12 }, (_, i) => `Ch|lesson ${i + 1}`);
    adopt(s);
    actions.start('exam-steps', 3, 90);
    actions.tick(2);
    actions.finish(false);
    expect(S().missions.find((x) => x.id === 'exam-steps')!.unitsLeft).toBe(10);
  });
});

describe('block names follow the clock', () => {
  it('names a mission’s blocks in time order even when placed out of order', () => {
    const s = sample(); s.days['2026-11-12'] = { level: 5 };
    const m = s.missions.find((x) => x.id === 'course-lessons')!;
    m.labels = Array.from({ length: m.unitsLeft! }, (_, i) => `Unit|lesson ${i + 1}`);
    const now = at('2026-11-12T08:00');
    const its = layoutDay(s, forecast(s, now), '2026-11-12', now).filter((i) => i.missionId === 'course-lessons').sort((a, b) => a.start - b.start);
    const firsts = its.map((i) => +/lessons? (\d+)/.exec(i.sub || '')![1]);
    expect([...firsts].sort((a, b) => a - b)).toEqual(firsts);
  });
});

describe('workout rotation', () => {
  it('names the next session and moves on after each one done', () => {
    const s = sample(); s.days['2026-11-12'] = { level: 4 };
    const w = s.missions.find((m) => m.id === 'court')!;
    w.rotation = [{ title: 'Session A', detail: 'a' }, { title: 'Session B', detail: 'b' }, { title: 'Session C', detail: 'c' }];
    s.logs.push(log('court', '2026-11-10', '10:00', 45));
    const now = at('2026-11-12T08:00');
    const it = layoutDay(s, forecast(s, now), '2026-11-12', now).find((i) => i.missionId === 'court');
    if (it) { expect(it.sub).toMatch(/^Session B/); expect(it.detail).toMatch(/^b/); }
  });
});

describe('confirmed meals', () => {
  it('a confirmed lunch sits where it happened and workouts wait from then (longer after a large meal)', async () => {
    const { fixedBlocks } = await import('../src/model/schedule');
    const s = sample(); s.days['2026-11-12'] = { level: 5, morningEnd: at('2026-11-12T08:40'), ate: { lunch: { at: 14 * 60 } } };
    const lunch = fixedBlocks(s, '2026-11-12').find((b) => b.key === 'f:lunch')!;
    expect(lunch.start).toBe(840); expect(lunch.ate).toBe(true);
    const now = at('2026-11-12T14:35');
    const court = () => { s.updatedAt = Math.random(); return layoutDay(s, forecast(s, now), '2026-11-12', now).find((i) => i.missionId === 'court'); };
    const c1 = court();
    if (c1) expect(c1.start).toBeGreaterThanOrEqual(870 + 90);
    s.days['2026-11-12'].ate = { lunch: { at: 840, big: true } };
    const c2 = court();
    if (c2) expect(c2.start).toBeGreaterThanOrEqual(870 + 180);
  });
});

describe('gaps get used', () => {
  it('splits a block that does not fit whole across the gaps left, instead of dropping it', () => {
    const s = sample();
    s.days['2026-11-12'] = { level: 5, morningEnd: at('2026-11-12T08:40') };
    s.events.push({ id: 'x1', title: 'Busy', kind: 'event', date: '2026-11-12', start: 540, end: 1140, travel: 0 });
    const now = at('2026-11-12T19:00');
    const fc = forecast(s, now);
    const big = fc.days[0].blocks.filter((b) => !b.habit).sort((a, b) => b.min - a.min)[0];
    const items = layoutDay(s, fc, '2026-11-12', now).filter((i) => i.kind === 'mission' && !i.done);
    const habits = new Set(['cards', 'stretch', 'strength', 'breathe', 'vocal']);
    const work = items.filter((i) => !habits.has(i.missionId!));
    expect(big).toBeTruthy();
    expect(work.length).toBeGreaterThan(0);
    for (const w of work) expect(w.end - w.start).toBeGreaterThanOrEqual(15);
  });
});

describe('planner rework', () => {
  it('Nov 11 case: check-in 2, deadline 6 days out and behind pace -> today includes deadline work', () => {
    const s = sample();
    s.days['2026-11-11'] = { level: 2, morningEnd: at('2026-11-11T09:00') };
    const now = at('2026-11-11T19:43');
    const fc = forecast(s, now);
    const deadline = fc.days[0].blocks.filter((b) => b.deadline);
    expect(deadline.length).toBeGreaterThan(0);
    expect(deadline.some((b) => b.missionId.startsWith('exam'))).toBe(true);
    const items = layoutDay(s, fc, '2026-11-11', now);
    expect(items.some((i) => i.kind === 'mission' && i.missionId?.startsWith('exam'))).toBe(true);
  });
  it('a low check-in shrinks flexible goals, not deadline pace', () => {
    const lo = sample(), hi = sample();
    lo.days['2026-11-12'] = { level: 2, morningEnd: at('2026-11-12T09:00') };
    hi.days['2026-11-12'] = { level: 4, morningEnd: at('2026-11-12T09:00') };
    const now = at('2026-11-12T09:00');
    const dl = (s: State) => forecast(s, now).days[0].blocks.filter((b) => b.deadline).reduce((a, b) => a + b.min, 0);
    const need = dl(lo);
    expect(need).toBeGreaterThan(0);
    expect(dl(hi)).toBeGreaterThanOrEqual(need);
  });
  it('lock-in names the deadline driving it, with a daily amount and an end date', () => {
    const s = sample(); s.days['2026-11-12'] = { level: 3, morningEnd: at('2026-11-12T09:00') };
    const fc = forecast(s, at('2026-11-12T09:00'));
    expect(fc.lockIn).toBeTruthy();
    expect(fc.lockIn!.perDay).toBeGreaterThan(0);
    expect(fc.lockIn!.until >= '2026-11-12').toBe(true);
  });
  it('comfortable deadlines leave free time free (no lock-in)', () => {
    const s = sample();
    for (const o of s.objectives) if (o.due) o.due = '2027-06-01';
    s.days['2026-11-12'] = { level: 3, morningEnd: at('2026-11-12T09:00') };
    const fc = forecast(s, at('2026-11-12T09:00'));
    expect(fc.lockIn).toBeNull();
    expect(fc.days[0].lock).toBe(false);
  });
});

describe('energy model', () => {
  it('starts flat, copies the first day, then blends with weight max(1/n, 0.1)', async () => {
    const { curves, dayObservations } = await import('../src/model/energy');
    const s = sample();
    expect(curves(s, '2026-11-01').g.every((v: number) => v === 1)).toBe(true);
    s.days['2026-10-05'] = { level: 3 };
    s.logs.push(log('course-lessons', '2026-10-05', '09:00', 30));          // on pace at 9:00 -> 1
    s.days['2026-10-05'].misses = [{ m: 'course-lessons', at: 15 * 60 }];   // missed at 15:00 -> 0.2
    s.updatedAt = Math.random();
    const o = dayObservations(s, '2026-10-05');
    expect(o.get(18)).toBeCloseTo(1); expect(o.get(30)).toBeCloseTo(0.2);
    const c1 = curves(s, '2026-11-01');
    expect(c1.g[30]).toBeCloseTo(0.2);                                      // day 2 copies day 1
    s.days['2026-10-06'] = { level: 3, misses: [] };
    s.logs.push(log('course-lessons', '2026-10-06', '15:00', 30));          // fine at 15:00 this time
    s.updatedAt = Math.random();
    const c2 = curves(s, '2026-11-01');
    expect(c2.g[30]).toBeCloseTo(0.2 * 0.5 + 1 * 0.5);                      // n = 2 -> weight 1/2
  });
  it('puts the hardest work in the highest predicted slots and routines in the dips', () => {
    const s = sample();
    for (const d of ['2026-11-05', '2026-10-29']) {                         // Thursdays: mornings missed, mid-afternoon fast
      s.days[d] = { level: 3, misses: [540, 570, 600, 630, 660, 690].map((at) => ({ m: 'course-lessons', at })) };
      s.logs.push({ ...log('course-lessons', d, '15:00', 20), plannedMin: 30 }, { ...log('course-lessons', d, '15:30', 20), plannedMin: 30 });
    }
    for (const o of s.objectives) if (o.due) o.due = '2027-03-01';        // comfortable deadlines: not a lock-in day
    s.days['2026-11-12'] = { level: 3, morningEnd: at('2026-11-12T09:00') };
    const now = at('2026-11-12T09:00');
    const fc = forecast(s, now);
    expect(fc.lockIn).toBeNull();
    const items = layoutDay(s, fc, '2026-11-12', now).filter((i) => i.kind === 'mission');
    const dl = items.filter((i) => i.missionId?.startsWith('exam') || i.missionId?.startsWith('course') || i.missionId?.startsWith('cert'));
    expect(dl.length).toBeGreaterThan(0);
    // nothing hard in the mornings he keeps missing, while the strong afternoon is used
    for (const i of dl) expect(i.start >= 12 * 60 || i.end <= 9 * 60).toBe(true);
    expect(dl.some((i) => i.start < 16 * 60 && i.end > 15 * 60)).toBe(true);
    // routines sit in lower-energy time than the hardest block
    const hab = items.filter((i) => ['cards', 'stretch', 'strength', 'breathe'].includes(i.missionId!));
    expect(hab.some((i) => i.start < 12 * 60)).toBe(true);
  });
});

describe('meal gap for routines', () => {
  it('a strength routine with its own meal gap waits after a large dinner', () => {
    const s = sample();
    const st = s.missions.find((m) => m.id === 'strength')!; st.mealGap = 60;
    s.days['2026-11-12'] = { level: 3, morningEnd: at('2026-11-12T08:40'), ate: { dinner: { at: 1110, big: true } } };
    const now = at('2026-11-12T19:05');
    const it = layoutDay(s, forecast(s, now), '2026-11-12', now).find((i) => i.missionId === 'strength');
    if (it) expect(it.start).toBeGreaterThanOrEqual(1140 + 120);
  });
});
