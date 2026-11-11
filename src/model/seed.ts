import type { State, Settings } from './types';

export const LEVELS = [
  { n: 5, name: 'PLUS ULTRA', means: 'Going all out' },
  { n: 4, name: 'ACTIVE', means: 'Optimal' },
  { n: 3, name: 'ON DUTY', means: 'Normal' },
  { n: 2, name: 'STANDBY', means: 'Bare minimums' },
  { n: 1, name: 'RECOVERY', means: 'Bed-ridden' },
] as const;

let ACR = new Set<string>();
export const setAcronyms = (words: string[]) => { ACR = new Set(words); };
/** Display case for stored ALL-CAPS titles. */
export const nice = (t: string) => t.split(' ').map((w, i) => (ACR.has(w) ? w : w.length <= 3 && i > 0 && !/\d/.test(w) ? w.toLowerCase() : w[0] + w.slice(1).toLowerCase())).join(' ');
export const levelName = (n: number) => LEVELS.find((l) => l.n === n)?.name ?? '';

/**
 * The public code ships no personal goals or schedule. A new device starts empty and
 * fills in from the private data repo the moment sync is connected.
 */
export const DEFAULT_SETTINGS: Settings = {
  wake: 480, morningMin: 60, bedPrep: 1390, offDutyMin: 120,
  lunchAt: 750, lunchMin: 30, dinnerAt: 1110, dinnerMin: 30, dishesMin: 20,
  mealGap: 90, breakMin: 10, baseline: 2.5,
  capacity: { 1: 0, 2: 45, 3: 210, 4: 330, 5: 450 },
  restDay: null, restDayName: 'Rest day', dishDays: [], dinnerNote: '', heightIn: 70, cookMin: 45,
  flareLabel: 'Flare', shift: { title: 'Shift', travel: 0, lengths: [240, 480] }, workoutTitle: 'Workout',
  exStart: 150, exTop: 450, exGrowth: 0.1,
  acronyms: [], north: { kicker: 'LIMIT BREAK:', title: 'YOUR GOAL!', sub: '', date: '', toWhat: 'go' },
};

/** Fill in settings added after a copy of the data was made. */
export function withDefaults(s: State): State {
  s.settings = { ...DEFAULT_SETTINGS, ...s.settings, shift: { ...DEFAULT_SETTINGS.shift, ...(s.settings?.shift || {}) }, north: { ...DEFAULT_SETTINGS.north, ...(s.settings?.north || {}) } };
  for (const k of ['skills', 'achDefs', 'objectives', 'missions', 'events', 'logs', 'flares', 'doing', 'measures'] as const) (s as any)[k] ||= [];
  s.days ||= {}; s.achievements ||= {};
  setAcronyms(s.settings.acronyms);
  return s;
}

export function seed(): State {
  return withDefaults({
    v: 1, settings: structuredClone(DEFAULT_SETTINGS),
    skills: [], achDefs: [], objectives: [], missions: [], events: [],
    logs: [], days: {}, flares: [], doing: [], measures: [],
    achievements: {}, updatedAt: 0,
  });
}
