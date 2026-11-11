import { describe, it, expect } from 'vitest';
import { seed } from '../src/model/seed';
import { sample } from './fixture';
import { merge, stamp } from '../src/model/merge';
import { xpOf } from '../src/model/game';
import type { State } from '../src/model/types';

const edit = (s: State, t: number, fn: (x: State) => void): State => { const n = structuredClone(s); fn(n); n.updatedAt = t; stamp(s, n, t); return n; };
const log = (id: string, xp: number) => ({ id, missionId: 'cards', date: '2026-11-12', start: 1000, end: 61000, plannedMin: 20, units: 1, done: true, xp });

describe('sync merge', () => {
  it('keeps work logged on both devices, and XP adds up', () => {
    const base = seed();
    const mac = edit(base, 10, (s) => { s.logs.push(log('a', 20)); });
    const phone = edit(base, 11, (s) => { s.logs.push(log('b', 15)); s.flares.push({ id: 'f', ts: 5 }); });
    const m1 = merge(mac, phone), m2 = merge(phone, mac);
    expect(m1.logs.map((l) => l.id).sort()).toEqual(['a', 'b']);
    expect(xpOf(m1)).toBe(35);
    expect(xpOf(m2)).toBe(35);
    expect(m1.flares.length).toBe(1);
  });
  it('newest edit to the same record wins, either way round', () => {
    const base = sample();
    const mac = edit(base, 10, (s) => { s.missions.find((m) => m.id === 'exam-steps')!.unitsLeft = 9; });
    const phone = edit(base, 20, (s) => { s.missions.find((m) => m.id === 'exam-steps')!.unitsLeft = 7; s.days['2026-11-12'] = { level: 4 }; });
    for (const m of [merge(mac, phone), merge(phone, mac)]) {
      expect(m.missions.find((x) => x.id === 'exam-steps')!.unitsLeft).toBe(7);
      expect(m.days['2026-11-12'].level).toBe(4);
    }
  });
  it('a deleted event stays deleted', () => {
    const base = edit(seed(), 5, (s) => { s.events.push({ id: 'shift1', title: 'Shift', kind: 'shift', date: '2026-11-13', start: 600, end: 870, travel: 20 }); });
    const mac = edit(base, 10, (s) => { s.events = s.events.filter((e) => e.id !== 'shift1'); });
    expect(merge(mac, base).events.some((e) => e.id === 'shift1')).toBe(false);
    expect(merge(base, mac).events.some((e) => e.id === 'shift1')).toBe(false);
  });
  it('a new device picks up goals and skills from the data repo', () => {
    const got = merge(seed(), sample());
    expect(got.skills.length).toBe(3);
    expect(got.missions.length).toBe(15);
  });
  it('copes with a copy from an older app version that lacks a collection', () => {
    const old: any = structuredClone(sample()); delete old.achDefs; delete old.skills;
    const cur = sample(); cur.achDefs = [{ id: 'x', title: 'X', sub: '', manual: true, t: 5 }];
    expect(merge(cur, old).achDefs.length).toBe(1);
    expect(merge(old, cur).achDefs.length).toBe(1);
    expect(merge(old, cur).skills.length).toBe(3);
  });
  it('merging is stable', () => {
    const a = edit(seed(), 10, (s) => { s.logs.push(log('a', 5)); });
    const m = merge(a, seed());
    expect(JSON.stringify(merge(m, a))).toBe(JSON.stringify(merge(merge(m, a), a)));
  });
});
