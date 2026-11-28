import type { State } from './types';
import { addDays, dateOf, fmtT } from './time';
import { forecast, layoutDay, type Forecast, type PlanItem } from './planner';
import { nice } from './seed';

/** One row on the timeline, and what tapping it can do. */
export interface PanelVM {
  key: string; start: number; time: string; h: string; t: string; m?: string; d?: string; kick?: string; color?: string;
  fixed?: boolean; past?: boolean; now?: boolean; done?: boolean; running?: boolean; must?: 'final' | 'danger';
  missionId?: string; units?: number; baseMin?: number; min?: number; step?: number; logId?: string;
  act: 'mission' | 'meal' | 'cook' | 'dishes' | 'morning' | 'choice' | 'event' | 'info';
  evtId?: string; date: string; meal?: 'lunch' | 'dinner';
}
export interface DayVM { date: string; today: string; isToday: boolean; panels: PanelVM[]; items: PlanItem[]; fc: Forecast }
/** How far ahead the day picker goes. */
export const AHEAD = 14;

function panelOf(s: State, it: PlanItem, date: string, isToday: boolean): PanelVM {
  const b = it.block;
  const time = it.end > it.start ? `${fmtT(it.start)}–${fmtT(it.end)}` : fmtT(it.start);
  const base = { key: it.key, start: it.start, time, t: it.title, m: it.sub, now: it.now, date };
  if (it.kind === 'mission') {
    const mi = s.missions.find((m) => m.id === it.missionId), ob = s.objectives.find((o) => o.id === mi?.objectiveId), sk = s.skills.find((k) => k.id === ob?.skillId);
    return { ...base, kick: sk ? nice(sk.title) : mi?.kind === 'chore' ? 'Chore' : mi?.errand ? 'Errand' : undefined, color: sk?.bg, h: it.now && !it.running ? 'NOW' : fmtT(it.start), d: it.detail, done: it.done, running: it.running, must: it.must, missionId: it.missionId, logId: it.logId, units: it.units, baseMin: it.baseMin, min: it.min, step: it.step, act: 'mission' };
  }
  const day = s.days[date] || {};
  return {
    ...base, fixed: true, past: it.past && isToday, evtId: b!.evtId, meal: b!.meal,
    h: b!.kind === 'note' ? (b!.meal === 'lunch' ? 'LUNCH' : 'DINNER') : it.now && isToday ? 'NOW' : fmtT(it.start),
    done: b!.key === 'f:morning' ? !!day.morningEnd : b!.key.startsWith('f:dishes') ? day.dishes?.[b!.key === 'f:dishes1' ? 'lunch' : 'dinner']?.end !== undefined : b!.key === 'f:cook' ? !!day.cookEnd : !!b!.ate,
    act: b!.key === 'f:cook' ? 'cook' : b!.key.startsWith('f:dishes') ? 'dishes' : b!.key === 'f:morning' ? 'morning' : b!.kind === 'meal' || b!.kind === 'note' ? 'meal' : b!.evtId ? (s.events.find((e) => e.id === b!.evtId)?.choices && b!.kind === 'event' ? 'choice' : 'event') : 'info',
    d: b!.kind === 'offduty' ? 'Rest counts. It feeds tomorrow.' : undefined,
  };
}

export function dayView(s: State, now: number, date?: string): DayVM {
  const fc = forecast(s, now), today = fc.today;
  const d = date && date >= today && date <= addDays(today, AHEAD) ? date : today;
  const items = layoutDay(s, fc, d, now);
  return { date: d, today, isToday: d === today, items, fc, panels: items.map((it) => panelOf(s, it, d, d === today)) };
}

/** What comes after the current item today. */
export function nextAfter(items: PlanItem[], key: string): PlanItem | null {
  const i = items.findIndex((x) => x.key === key);
  return items.find((x, j) => j > i && !x.done && !x.past && x.kind === 'mission') || null;
}
void dateOf;
