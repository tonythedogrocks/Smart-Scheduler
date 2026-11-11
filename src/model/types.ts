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
  kind: 'habit' | 'work' | 'practice';
  energy: Energy;
  minutes: number;         // habit: session; work: minutes per unit; practice: block
  minutesAt5?: number;     // habit on Plus Ultra
  lowTitle?: string;       // habit wording at Recovery / Standby
  minLevel: Level;
  everyDays?: number;      // habit cadence
  unitsLeft?: number; unitsTotal?: number; unitName?: string;
  maxBlockUnits?: number;
  dailyCapMin?: number;
  weeklyMin?: number;
  after?: string[];        // unlocks when these missions are complete
  clock?: boolean; waitDays?: number; // finishing starts a waiting period
  workout?: boolean;       // respects meal gaps, eases when flares spike
  restOk?: boolean;        // still runs on the weekly rest day
  form?: 'measure';
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
  start: number; end: number; // minutes from midnight
  travel: number;          // each way
  note?: string;
  exerciseMin?: number;
  choices?: number[];      // start times to pick between, week by week
  shiftGap?: number;       // minutes needed between a shift ending and this starting
  skip?: string[];
}

export interface Log {
  t?: number; // last change, for sync
  id: string; missionId: string; date: string;
  start: number; end: number;          // timestamps (ms)
  plannedMin: number; units: number; done: boolean; level?: Level; xp?: number;
}

export interface DayRec { t?: number; level?: Level; setAt?: number; floorAwarded?: boolean; lunchAt?: number; dinnerAt?: number; starts?: Record<string, number> }

export interface Settings {
  wake: number; morningMin: number; bedPrep: number; offDutyMin: number;
  lunchAt: number; lunchMin: number; dinnerAt: number; dinnerMin: number;
  dishesMin: number; mealGap: number; breakMin: number;
  baseline: number; capacity: Record<Level, number>;
  restDay: number | null;  // weekday kept for essentials only (0 = Sunday), or none
  restDayName: string;
  dishDays: number[];       // weekdays with dishes after lunch and dinner
  dinnerNote: string;
  heightIn: number;         // for the tape-measure body fat estimate
  flareLabel: string;
  shift: { title: string; travel: number; lengths: number[] };
  workoutTitle: string;
  acronyms: string[];       // words kept in capitals in titles
  north: { kicker: string; title: string; sub: string; date: string; toWhat: string };
}

export interface AchDef { id: string; t?: number; title: string; sub: string; objectiveId?: string; missionId?: string; count?: number; manual?: boolean }

export interface Running { missionId: string; units: number; plannedMin: number; startedAt: number }

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
