import type { State } from './types';

export const FLOOR_XP = 100;
/** XP is derived from what actually happened, so two devices can never disagree or lose any. */
export function xpOf(s: State): number {
  return Math.round(
    s.logs.reduce((a, l) => a + (l.xp || 0), 0)
    + FLOOR_XP * Object.values(s.days).filter((d) => d.floorAwarded).length
    + 250 * s.objectives.filter((o) => o.done).length
    + 250 * Object.keys(s.claimed || {}).length,
  );
}
/** Level n needs 150 * n * (n - 1) XP in total. */
export function heroLevel(xp: number) {
  let n = 1;
  while (150 * (n + 1) * n <= xp) n++;
  const lo = 150 * n * (n - 1), hi = 150 * (n + 1) * n;
  return { level: n, into: xp - lo, span: hi - lo };
}

export interface Ach { id: string; title: string; sub: string; manual?: boolean; test: (s: State) => boolean }
const doneLogs = (s: State, id?: string) => s.logs.filter((l) => l.done && (!id || l.missionId === id));
const objDone = (s: State, id: string) => !!s.objectives.find((o) => o.id === id)?.done;
const BUILTIN: Ach[] = [
  { id: 'first', title: 'ORIGIN STORY', sub: 'First mission done', test: (s) => doneLogs(s).length >= 1 },
  { id: 'floor', title: 'HELD THE LINE', sub: 'First day at the floor', test: (s) => Object.values(s.days).some((d) => d.floorAwarded) },
  { id: 'recovery', title: 'STILL STANDING', sub: 'Hit the floor on a Recovery day', test: (s) => Object.values(s.days).some((d) => d.floorAwarded && d.level === 1) },
  { id: 'tenlb', title: 'TEN DOWN', sub: 'First 10 lb down', test: (s) => s.measures.length > 1 && s.measures[0].weight - Math.min(...s.measures.map((m) => m.weight)) >= 10 },
];
/** Built-in achievements plus the personal ones kept in the private data. */
export function achievements(s: State): Ach[] {
  return [...BUILTIN, ...s.achDefs.map((d) => ({
    id: d.id, title: d.title, sub: d.sub, manual: d.manual,
    test: (x: State) => (d.objectiveId ? objDone(x, d.objectiveId) : d.missionId ? doneLogs(x, d.missionId).length >= (d.count || 1) : false),
  }))];
}

/** Returns ids newly unlocked. Nothing earned is ever taken away. */
export function unlock(s: State, date: string): string[] {
  const got: string[] = [];
  for (const a of achievements(s)) if (!s.achievements[a.id] && a.test(s)) { s.achievements[a.id] = date; got.push(a.id); }
  return got;
}
