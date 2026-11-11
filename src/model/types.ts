export type Level = 1 | 2 | 3 | 4 | 5;
export type Energy = 'physical' | 'mental' | 'social' | 'none';

export interface Skill { id: string; title: string; sub: string; bg: string; fg: string }

export interface Objective {
  t?: number; // last change, for sync
  id: string; skillId: string; title: string; sub: string; status: string; target: string;
  due?: string;            // real deadline (YYYY-MM-DD)
  dueLabel?: string;
  riskNote?: string;       // shown only when the deadline is genuinely at risk
  dependsOn?: string[];    // lands when these objectives land
  done?: boolean; doneAt?: string;
}

export interface Mission {
  t?: number; // last change, for sync
  id: string; objectiveId: string; title: string;
  kind: 'habit' | 'work' | 'practice' | 'chore';
  energy: Energy;
  minutes: number;         // habit: session; work: minutes per unit; practice: block
  minutesAt5?: number;     // habit on Plus Ultra
  lowTitle?: string;       // habit wording at Recovery / Standby
  minLevel: Level;
  everyDays?: number;      // habit cadence
  unitsLeft?: number; unitsTotal?: number; unitName?: string;
  labels?: string[];       // work: what each unit is, in order, as "Group|item" (e.g. "Chapter 2|lesson 3")
  afterNoWait?: string[];  // unlocks when these are done, without waiting out their clocks
  notBefore?: string;      // not planned before this date
  maxBlockUnits?: number;
  dailyCapMin?: number;
  weeklyMin?: number;
  after?: string[];        // unlocks when these missions are complete
  clock?: boolean; waitDays?: number; // finishing starts a waiting period
  workout?: boolean;       // respects meal gaps, eases when flares spike
  restOk?: boolean;        // still runs on the weekly rest day
  travel?: number;         // minutes each way (walk or bike) added around the block
  bike?: boolean;          // that travel is by bike: counts toward weekly exercise
  daylight?: boolean;      // only between sunrise and sunset
  mealGap?: number;        // minutes to wait after a meal (workouts), overriding the setting
  window?: [number, number]; // earliest start and latest finish, travel included (minutes from midnight)
  errand?: boolean;        // one-off errand: planned on good days, then gone
  days?: number[];         // habit: only on these weekdays
  rotation?: { title: string; detail: string }[]; // practice: sessions done in turn (A, B, C...)
  notFloor?: boolean;      // habit that isn't part of the day's floor
  form?: 'measure';
  steps?: { at: number; min: number; title: string }[]; // chore: hands-on moments, minutes from the start; must be home for each
  lastAt?: string;         // chore: last done before the app knew
  note?: string;
  doneAt?: string;
  archived?: boolean;
}

export interface Evt {
  t?: number; // last change, for sync
  id: string; title: string;
  kind: 'shift' | 'workout' | 'event' | 'chore' | 'exam';
  date?: string;           // one-off
  weekday?: number;        // weekly (0 = Sunday)
  nth?: number[];          // with weekday: only these weeks of the month (1-5; 5 = last)
  start: number; end: number; // minutes from midnight
  travel: number;          // each way
  note?: string;
  exerciseMin?: number;
  choices?: number[];      // start times to pick between, week by week
  shiftGap?: number;       // minutes needed between a shift ending and this starting
  bike?: boolean;          // travel is by bike: counts toward weekly exercise
  skip?: string[];
}

export interface Log {
  t?: number; // last change, for sync
  id: string; missionId: string; date: string;
  start: number; end: number;          // timestamps (ms)
  plannedMin: number; units: number; done: boolean; level?: Level; xp?: number; step?: number;
}

export interface DayRec { t?: number; level?: Level; setAt?: number; floorAwarded?: boolean; lunchAt?: number; dinnerAt?: number; starts?: Record<string, number>; cook?: boolean | 'family'; cookStart?: number; cookEnd?: number; morningEnd?: number; dinnerTap?: number;
  ate?: Partial<Record<'lunch' | 'dinner', { at: number; big?: boolean }>>; // confirmed meals: start (minutes from midnight), and whether it was a large one
}

export interface Settings {
  wake: number; morningMin: number; bedPrep: number; offDutyMin: number;
  lunchAt: number; lunchMin: number; dinnerAt: number; dinnerMin: number;
  dishesMin: number; mealGap: number; breakMin: number;
  bigMealGap: number;       // minutes to wait before a workout after a large meal
  baseline: number; capacity: Record<Level, number>;
  restDay: number | null;  // weekday kept for essentials only (0 = Sunday), or none
  restDayName: string;
  dishDays: number[];       // weekdays with dishes after lunch and dinner
  dinnerNote: string;
  heightIn: number;         // for the tape-measure body fat estimate
  cookMin: number;          // first guess for cooking dinner for himself; learned from real runs
  cookFamilyMin: number;    // first guess for cooking for the family; learned separately
  flareLabel: string;
  shift: { title: string; travel: number; lengths: number[]; bike?: boolean };
  backupWeeks: string[];    // weeks (Monday dates) where the rest day is a backup work day
  sun?: { lat: number; lon: number }; // for sunrise/sunset (daylight-only missions)
  workoutTitle: string;
  acronyms: string[];       // words kept in capitals in titles
  exStart: number; exTop: number; exGrowth: number; // weekly exercise ceiling: start, top, growth per good week
  north: { kicker: string; title: string; sub: string; date: string; toWhat: string };
}

export interface AchDef { id: string; t?: number; title: string; sub: string; objectiveId?: string; missionId?: string; count?: number; manual?: boolean }

export interface Running { missionId: string; units: number; plannedMin: number; startedAt: number; step?: number; ticked?: number }

export interface State {
  v: 1;
  settings: Settings;
  skills: Skill[]; achDefs: AchDef[]; objectives: Objective[]; missions: Mission[]; events: Evt[];
  logs: Log[]; days: Record<string, DayRec>;
  flares: { id: string; ts: number; rating?: number; t?: number }[];
  doing: { id: string; ts: number; what: string; t?: number }[];
  measures: { id: string; date: string; weight: number; neck: number; navel: number; t?: number }[];
  achievements: Record<string, string>;
  claimed?: Record<string, string>; // achievements marked by hand
  running?: Running;
  deleted?: Record<string, number>; settingsT?: number; runningT?: number;
  updatedAt: number;
}
