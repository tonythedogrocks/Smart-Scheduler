// Checks the plan made from the owner's real data (never stored here) against rules that must always hold.
// Runs only when LB_DATA points at the private state.json:  LB_DATA=/path/state.json npx vitest run tests/real.test.ts
import { it, expect } from 'vitest';
import { forecast, layoutDay, type PlanItem } from '../src/model/planner';
import { withDefaults } from '../src/model/seed';
import { eventsOn } from '../src/model/schedule';
import { addDays } from '../src/model/time';
import type { State } from '../src/model/types';

declare const process: { env: Record<string, string | undefined> };
const path = process.env.LB_DATA;
const DAYS = Number(process.env.LB_DAYS || 14);

const hm = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Every rule broken in the next DAYS days, one line each. */
export function problems(s: State, now: number): string[] {
  const out: string[] = [];
  const fc = forecast(s, now);
  for (const o of s.objectives) {
    if (!o.due || o.done) continue;
    const l = fc.landing[o.id];
    if (l && l > o.due && !fc.warns.some((r) => r.objectiveId === o.id)) out.push(`${o.title}: lands ${l}, after its due date ${o.due}, with no warning shown`);
    else if (l && l > o.due) out.push(`${o.title}: lands ${l}, after its due date ${o.due}`);
  }
  const byId = new Map(s.missions.map((m) => [m.id, m]));
  for (let t = 0; t < DAYS; t++) {
    const date = addDays(fc.today, t);
    let items: PlanItem[];
    try { items = layoutDay(s, fc, date, now); } catch (e) { out.push(`${date}: the day could not be planned (${(e as Error).message})`); continue; }
    const live = items.filter((i) => !i.past && !i.done);
    const evts = eventsOn(s, date);
    // nothing that takes your time overlaps anything else that does
    const busy = live.filter((i) => i.end > i.start && (i.kind === 'mission' || i.block?.blocking) && i.block?.kind !== 'sleep');
    busy.sort((a, b) => a.start - b.start);
    for (let k = 1; k < busy.length; k++) for (let j = 0; j < k; j++) {
      const a = busy[j], b = busy[k];
      const choreInOff = (x: PlanItem, y: PlanItem) => x.block?.kind === 'offduty' && (y.key.startsWith('c:') || y.must === 'final'); // chore steps and FINAL SHOT work may use Off Duty
      if (b.start < a.end && !(a.block?.evtId && a.block.evtId === b.block?.evtId) && !choreInOff(a, b) && !choreInOff(b, a)) out.push(`${date}: "${a.title}" ${hm(a.start)}–${hm(a.end)} overlaps "${b.title}" ${hm(b.start)}–${hm(b.end)}`);
    }
    // sleep is the length set in Settings
    const sleep = items.find((i) => i.title === 'Asleep');
    const want = s.settings.sleepMin ?? 480;
    if (sleep && sleep.end - sleep.start !== want) out.push(`${date}: sleep is ${(sleep.end - sleep.start) / 60} h, Settings say ${want / 60} h`);
    // a meal is only "out" while you're actually away
    for (const i of live) {
      if (i.block?.kind !== 'note' || !i.block.meal) continue;
      const away = evts.some((e) => i.start >= e.start - (e.travel || 0) && i.start <= e.end + (e.travelBack ?? e.travel ?? 0));
      if (!away) out.push(`${date}: ${i.title} at ${hm(i.start)}, but nothing takes you away then`);
    }
    // tasks respect their own limits
    for (const i of live) {
      const m = i.missionId ? byId.get(i.missionId) : undefined;
      if (!m) continue;
      if (m.skipOn?.includes(date)) out.push(`${date}: "${m.title}" is planned on a date it was skipped`);
      if (m.window && (i.start < m.window[0] - (m.travel || 0) || i.end > m.window[1] + (m.travel || 0))) out.push(`${date}: "${m.title}" ${hm(i.start)}–${hm(i.end)} is outside its ${hm(m.window[0])}–${hm(m.window[1])} window`);
      if (m.onDate && m.onDate !== date) out.push(`${date}: "${m.title}" belongs on ${m.onDate}`);
    }
  }
  return out;
}

it.skipIf(!path)('the real plan breaks no rules', async () => {
  // @ts-ignore node module, available when the test runs
  const { readFileSync } = await import('node:fs');
  const s = withDefaults(JSON.parse(readFileSync(path!, 'utf8')));
  const list = problems(s, Date.now());
  for (const p of list) console.log('PROBLEM', p);
  expect(list).toEqual([]);
});
