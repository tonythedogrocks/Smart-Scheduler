import { seed } from '../src/model/seed';
import type { Mission, Objective, State } from '../src/model/types';

/** Made-up sample data with the same shapes the real data uses. */
export function sample(): State {
  const s = seed();
  s.settings = { ...s.settings, restDay: 0, restDayName: 'Rest day', dishDays: [5, 6] };
  s.skills = [
    { id: 'study', title: 'STUDY', sub: '', bg: '#1E5BD8', fg: '#FFFFFF' },
    { id: 'body', title: 'BODY', sub: '', bg: '#2DBE6C', fg: '#14110F' },
    { id: 'craft', title: 'CRAFT', sub: '', bg: '#19B3B3', fg: '#14110F' },
  ];
  const o = (id: string, skillId: string, x: Partial<Objective> = {}): Objective => ({ id, skillId, title: id.toUpperCase(), sub: '', status: '', target: '', ...x });
  s.objectives = [
    o('exam', 'study', { due: '2026-11-17' }),
    o('course', 'study', { due: '2026-12-05' }),
    o('cert', 'study', { due: '2026-12-05' }),
    o('bundle', 'study', { due: '2026-12-05', dependsOn: ['course', 'cert'] }),
    o('lang', 'study'), o('fit', 'body'), o('calm', 'body'), o('sketch', 'craft'),
  ];
  const m = (id: string, objectiveId: string, kind: Mission['kind'], energy: Mission['energy'], minutes: number, x: Partial<Mission> = {}): Mission =>
    ({ id, objectiveId, title: id, kind, energy, minutes, minLevel: kind === 'habit' ? 2 : 3, ...x });
  const work = (id: string, obj: string, units: number, minutes: number, x: Partial<Mission> = {}) =>
    m(id, obj, 'work', 'mental', minutes, { unitsLeft: units, unitsTotal: units, maxBlockUnits: 3, dailyCapMin: 180, ...x });
  s.missions = [
    work('exam-steps', 'exam', 12, 30, { unitsTotal: 23, unitName: 'Step' }),
    work('exam-tests', 'exam', 2, 90, { maxBlockUnits: 1, after: ['exam-steps'] }),
    work('course-lessons', 'course', 56, 30),
    work('course-paper', 'course', 4, 30, { clock: true, waitDays: 9 }),
    work('cert-course', 'cert', 40, 30),
    work('cert-voucher', 'cert', 1, 15, { after: ['cert-course'], clock: true, waitDays: 14 }),
    work('cert-exam', 'cert', 1, 120, { maxBlockUnits: 1, after: ['cert-voucher'] }),
    m('cards', 'lang', 'habit', 'mental', 20, { minLevel: 1, lowTitle: 'reviews only' }),
    m('lang-study', 'lang', 'practice', 'mental', 30, { dailyCapMin: 60, weeklyMin: 180 }),
    m('stretch', 'fit', 'habit', 'physical', 10, { minutesAt5: 15 }),
    m('strength', 'fit', 'habit', 'physical', 15, { everyDays: 2 }),
    m('breathe', 'calm', 'habit', 'none', 10, { minLevel: 1, minutesAt5: 15 }),
    m('vocal', 'calm', 'habit', 'none', 5, { minLevel: 4 }),
    m('court', 'fit', 'practice', 'physical', 45, { workout: true, dailyCapMin: 45, weeklyMin: 90 }),
    m('sketch', 'sketch', 'practice', 'mental', 30, { dailyCapMin: 60, weeklyMin: 300 }),
  ];
  s.events = [
    { id: 'appt', title: 'Appointment', kind: 'event', weekday: 3, start: 840, end: 900, travel: 30, shiftGap: 45 },
    { id: 'gathering', title: 'Gathering', kind: 'event', weekday: 0, start: 540, end: 660, travel: 30, choices: [540, 660] },
  ];
  s.updatedAt = Math.random();
  return s;
}
