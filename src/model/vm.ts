import type { State, Mission } from './types';
import { addDays, dateOf, diffDays, fmtDate, fmtDay, fmtDur, fmtT, minsOf, weekStart, weekday } from './time';
import { describeUnits, forecast, layoutDay, nextLabels, orders, habitMin, habitTitle, habitsDue, type Forecast, type PlanItem } from './planner';
import { levelName, nice } from './seed';
import { bodyFat, choreDue, choreInterval, choreLast, exerciseCeiling, factor, partOf } from './learn';
import { eventsOn, isRest } from './schedule';

export interface PanelVM {
  key: string; h: string; t: string; m?: string; d?: string; wide?: boolean;
  now?: boolean; done?: boolean; running?: boolean; alert?: boolean;
  missionId?: string; units?: number; baseMin?: number; min?: number; step?: number;
  act?: 'mission' | 'meal' | 'choice' | 'event' | 'objective' | 'info';
  evtId?: string; date?: string; objectiveId?: string; meal?: 'lunch' | 'dinner'; editable?: boolean;
}
export interface ChapterVM { title: string; panels: PanelVM[] }
export interface IssueVM { key: string; title: string; sub: string; badge?: string; chapters: ChapterVM[] }
export interface CollectionVM { key: string; title: string; sub: string; bg: string; fg: string; issues: IssueVM[] }
export interface Library { cols: CollectionVM[]; fc: Forecast; today: string; todayItems: PlanItem[]; resume: { title: string; sub: string; ch: number; p: string } | null; rest: boolean; ahead: { title: string; date: string }[] }

const CH = ['MORNING', 'MIDDAY', 'AFTERNOON', 'EVENING'];

function itemPanel(s: State, it: PlanItem, date: string, isToday: boolean): PanelVM {
  const b = it.block;
  if (it.kind === 'mission') {
    return { key: it.key, h: it.now && !it.running ? 'NOW' : fmtT(it.start), t: it.title, m: it.sub, d: it.detail, now: it.now, done: it.done, running: it.running, missionId: it.missionId, units: it.units, baseMin: it.baseMin, min: it.min, step: it.step, editable: s.missions.find((m) => m.id === it.missionId)?.kind === 'chore', act: 'mission', wide: it.now || (it.min || 0) >= 60, date };
  }
  const h = b!.kind === 'note' ? (b!.meal === 'lunch' ? 'LUNCH' : 'DINNER') : it.now && isToday ? 'NOW' : fmtT(it.start);
  return {
    key: it.key, h, t: it.title, m: it.sub, done: it.past && isToday, now: it.now, date,
    act: b!.kind === 'meal' || b!.kind === 'note' ? 'meal' : b!.evtId ? (s.events.find((e) => e.id === b!.evtId)?.choices && b!.kind === 'event' ? 'choice' : 'event') : 'info',
    evtId: b!.evtId, meal: b!.meal, wide: b!.kind === 'event',
    d: b!.kind === 'offduty' ? 'Rest counts. It feeds tomorrow.' : undefined,
  };
}

function dayIssue(s: State, fc: Forecast, date: string, now: number): { issue: IssueVM; items: PlanItem[] } {
  const today = fc.today, isToday = date === today, sab = isRest(s, date), restName = s.settings.restDayName;
  const items = layoutDay(s, fc, date, now);
  const lv = s.days[date]?.level;
  let chapters: ChapterVM[];
  let sub: string;
  if (isToday) {
    chapters = CH.map((title) => ({ title, panels: [] as PanelVM[] }));
    for (const it of items) if (it.block?.kind !== 'travel' || true) chapters[partOf(it.start % 1440 < 300 ? 1439 : it.start)].panels.push(itemPanel(s, it, date, true));
    chapters.forEach((c) => { if (!c.panels.length) c.panels.push({ key: 'open', h: 'OPEN', t: 'Nothing queued', m: 'Rest counts too.', wide: true, act: 'info' }); });
    sub = sab ? restName : lv ? `Level ${lv} · ${nice(levelName(lv))}` : 'Level not set yet';
  } else if (date < today) {
    const done = items.filter((i) => i.done && i.start > 0);
    const panels = done.map((i) => itemPanel(s, i, date, false));
    panels.push({ key: 'closed', h: 'CLOSED', t: 'Nothing carried over.', m: 'Unfinished work went back to the pool.', wide: true, act: 'info' });
    chapters = [{ title: 'HOW IT WENT', panels }];
    sub = 'Closed';
  } else {
    const fx = items.filter((i) => i.kind === 'fixed' && ['event', 'offduty', 'note'].includes(i.block!.kind) || i.block?.key.startsWith('f:dishes'));
    const panels = fx.map((i) => itemPanel(s, i, date, false));
    const day = fc.days.find((d) => d.date === date);
    const work = (day?.blocks || []).filter((b) => !b.habit);
    for (const m of s.missions) {
      if (m.kind !== 'chore' || m.archived || (sab && !m.restOk)) continue;
      const due = choreDue(s, m);
      if (due === date) panels.unshift({ key: `due:${m.id}`, h: 'DUE', t: m.title, m: 'Planned on the day around being home', act: 'info', wide: true });
    }
    if (sab) panels.splice(panels.findIndex((p) => p.t === 'Off Duty'), 0,
      { key: 'ess', h: 'DAY', t: 'Essentials only', wide: true, act: 'info' },
      { key: 'debrief', h: 'EVE', t: 'Debrief', m: 'Progress, what the app learned, next week', act: 'info' },
      { key: 'shifts', h: 'EVE', t: 'Enter shifts', m: 'Posted on Sundays', act: 'info' });
    else if (work.length) {
      const names = [...new Set(work.map((b) => s.objectives.find((o) => o.id === s.missions.find((m) => m.id === b.missionId)?.objectiveId)?.title))].slice(0, 3);
      panels.unshift({ key: 'pencil', h: 'PENCILLED', t: `About ${fmtDur(work.reduce((a, b) => a + b.min, 0))} of missions`, m: names.map((n) => nice(n || '')).join(' · '), d: 'Planned against a modest day. The real plan is dealt when you set that day\'s level.', wide: true, act: 'info' });
    }
    chapters = [{ title: 'ON THE SCHEDULE', panels }];
    const ev = items.find((i) => i.block?.kind === 'event');
    sub = sab ? restName : ev ? `${ev.title.length > 14 ? ev.title.slice(0, 13) + '…' : ev.title} ${fmtT(ev.start)}` : items.some((i) => i.block?.key.startsWith('f:dishes')) ? 'Dishes' : 'Open';
  }
  return { issue: { key: date, title: fmtDay(date), sub, badge: isToday ? 'TODAY' : undefined, chapters }, items };
}

const cap1 = (x: string) => x[0].toUpperCase() + x.slice(1);

function missionPanel(s: State, m: Mission, level: number): PanelVM {
  const f = factor(s, m.id);
  if (m.kind === 'chore') {
    const steps = m.steps?.length ? m.steps : [{ at: 0, min: m.minutes, title: m.title }];
    const iv = choreInterval(s, m), last = choreLast(s, m), due = choreDue(s, m);
    const span = steps[steps.length - 1].at + steps[steps.length - 1].min;
    return { key: `mi:${m.id}`, h: 'CHORE', t: m.title, m: `${steps.reduce((a, x) => a + x.min, 0)} min hands-on over ${fmtDur(span)} · about every ${iv.days} days${iv.learned ? ' (learned)' : ''}`,
      d: last ? `Last done ${fmtDate(last)}. Next one is planned for about ${fmtDate(due!)}.` : 'Not planned until it has been done once. Start it here when you run it, or set the last time in Edit.',
      missionId: m.id, units: 1, baseMin: steps[0].min, min: steps[0].min, step: 0, act: 'mission', editable: true };
  }
  if (m.kind === 'habit') {
    const base = habitMin(m, level);
    const bits = [`${Math.round(base * f)} min`, m.everyDays ? (m.everyDays === 2 ? 'every other day' : `every ${m.everyDays} days`) : 'daily'];
    if (m.minutesAt5) bits.push(`${m.minutesAt5} on Plus Ultra`);
    return { key: `mi:${m.id}`, h: 'MISSION', t: m.title, m: bits.join(' · '), d: m.note, missionId: m.id, units: 1, baseMin: base, min: Math.round(base * f), act: 'mission', editable: true };
  }
  if (m.kind === 'work') {
    const left = m.unitsLeft || 0;
    let u = Math.min(m.maxBlockUnits || 3, Math.max(1, left));
    if (m.labels?.length) { const at0 = m.labels.length - left; while (u < left && m.labels[at0 + u] === m.labels[at0 + u - 1]) u++; }
    const done = left <= 0;
    const next = done ? '' : describeUnits(nextLabels(m, u));
    const summary = done ? 'Complete' : m.labels?.length ? `About ${fmtDur(left * m.minutes * f)} left` : `${left} ${left === 1 ? 'block' : 'blocks'} left · about ${fmtDur(left * m.minutes * f)}`;
    return { key: `mi:${m.id}`, h: 'MISSION', t: m.title, m: next ? `Next: ${next} · ${summary.toLowerCase()}` : summary, d: m.note, done, missionId: done ? undefined : m.id, units: u, baseMin: u * m.minutes, min: Math.round(u * m.minutes * f), act: done ? 'info' : 'mission', editable: true };
  }
  return { key: `mi:${m.id}`, h: 'MISSION', t: m.title, m: `${Math.round(m.minutes * f)} min blocks${m.dailyCapMin ? ` · up to ${fmtDur(m.dailyCapMin)} a day` : ''}`, d: m.note, missionId: m.id, units: 1, baseMin: m.minutes, min: Math.round(m.minutes * f), act: 'mission', editable: true };
}

export function buildLibrary(s: State, now: number): Library {
  const fc = forecast(s, now);
  const today = fc.today;
  const level = s.days[today]?.level ?? 3;
  const ws = weekStart(today);
  let todayItems: PlanItem[] = [];
  const week: CollectionVM = { key: 'week', title: 'THIS WEEK', sub: `${fmtDate(ws)} to ${fmtDate(addDays(ws, 6)).split(' ')[1]} · one comic per day`, bg: '#D92B21', fg: '#FFFFFF', issues: [] };
  for (let i = 0; i < 7; i++) {
    const { issue, items } = dayIssue(s, fc, addDays(ws, i), now);
    week.issues.push(issue);
    if (addDays(ws, i) === today) todayItems = items;
  }
  const riskOf = new Map(fc.risks.map((r) => [r.objectiveId, r]));
  const cols: CollectionVM[] = [week];
  for (const sk of s.skills) {
    const issues: IssueVM[] = s.objectives.filter((o) => o.skillId === sk.id).map((o) => {
      const ms = s.missions.filter((m) => m.objectiveId === o.id && !m.archived);
      const risk = riskOf.get(o.id);
      const stand: PanelVM[] = [
        { key: 'status', h: 'STATUS', t: o.done ? `Complete${o.doneAt ? ' · ' + fmtDate(o.doneAt) : ''}` : o.status, wide: true, act: 'objective', objectiveId: o.id, done: o.done },
        { key: 'target', h: 'TARGET', t: o.target, wide: true, act: 'info' },
      ];
      const work = ms.filter((m) => m.kind === 'work');
      if (work.length && !o.done) {
        const left = work.reduce((a, m) => a + (m.unitsLeft || 0) * m.minutes * factor(s, m.id), 0);
        const total = work.reduce((a, m) => a + (m.unitsTotal || 0) * m.minutes * factor(s, m.id), 0);
        stand.push({ key: 'progress', h: 'PROGRESS', t: `${Math.round(100 * (1 - left / Math.max(1, total)))}% · about ${fmtDur(left)} to go`, wide: true, act: 'info' });
      }
      if (o.id === 'volume') {
        const ex = exerciseCeiling(s, today);
        stand.push({ key: 'progress', h: 'THIS WEEK', t: `${Math.round(ex.done)} of ${ex.cap} min of exercise`, m: `This week's ceiling. It grows about ${Math.round(s.settings.exGrowth * 100)}% a week once most of it gets done and flares stay quiet, up to ${s.settings.exTop} min. Daily base routines never count against it.`, wide: true, act: 'info' });
      }
      if (o.id === 'physique' && s.measures.length) {
        const m = s.measures[s.measures.length - 1];
        stand.push({ key: 'progress', h: 'LATEST', t: `${m.weight} lb · about ${bodyFat(m.neck, m.navel, s.settings.heightIn).toFixed(1)}% body fat`, m: `Measured ${fmtDate(m.date)} · neck ${m.neck} in, navel ${m.navel} in`, wide: true, act: 'info' });
      }
      if (o.due && !o.done) {
        const land = fc.landing[o.id];
        stand.push(risk
          ? { key: 'deadline', h: 'AT RISK', t: land ? `At a modest pace this lands about ${fmtDate(land)}` : 'At a modest pace this does not land in time', m: `${o.dueLabel || 'Due ' + fmtDate(o.due)}`, d: [`That is ${land ? diffDays(o.due, land) + ' days' : 'well'} past the deadline unless good days pull it forward.`, o.riskNote].filter(Boolean).join(' '), wide: true, alert: true, act: 'info' }
          : { key: 'deadline', h: 'DEADLINE', t: o.dueLabel || `Due ${fmtDate(o.due)}`, m: land ? `On pace · lands about ${fmtDate(land)}` : 'On pace', wide: true, act: 'info' });
      }
      const chapters: ChapterVM[] = [{ title: 'WHERE IT STANDS', panels: stand }];
      if (ms.length) chapters.push({ title: 'MISSIONS', panels: ms.map((m) => missionPanel(s, m, level)) });
      const learned: PanelVM[] = [];
      for (const m of ms) {
        const f = factor(s, m.id);
        if (Math.abs(f - 1) >= 0.1) learned.push({ key: `l:${m.id}`, h: 'LEARNED', t: `${m.title} really takes about ${Math.round(m.minutes * f)} min`, m: `Estimate was ${m.minutes} min. Plans now use the real number.`, wide: true, act: 'info' });
      }
      if (!learned.length) learned.push({ key: 'l:none', h: 'LEARNED', t: 'Nothing yet.', m: 'This page fills in as days get logged.', wide: true, act: 'info' });
      chapters.push({ title: 'WHAT THE APP LEARNED', panels: learned });
      return { key: o.id, title: o.title, sub: o.done ? 'Complete' : o.sub, badge: o.done ? 'DONE' : risk ? 'AT RISK' : undefined, chapters };
    });
    cols.push({ key: sk.id, title: sk.title, sub: sk.sub, bg: sk.bg, fg: sk.fg, issues });
  }
  const od = orders(todayItems);
  const rest = isRest(s, today);
  let resume: Library['resume'] = null;
  const cur = od.now || od.next;
  if (cur) {
    const ch = partOf(cur.start % 1440 < 300 ? 1439 : cur.start);
    resume = { title: cur.title.toUpperCase(), sub: `Today · ${cap1(CH[ch].toLowerCase())} · ${od.now ? (cur.kind === 'mission' ? (rest ? 'now' : 'current mission') : 'now') : 'up next at ' + fmtT(cur.start)}`, ch, p: cur.key };
  }
  void eventsOn; void dateOf; void minsOf;
  // Heads-up a day or two before a repeating chore is needed.
  const ahead = s.missions.filter((m) => m.kind === 'chore' && !m.archived).flatMap((m) => {
    const due = choreDue(s, m);
    return due && due > today && due <= addDays(today, 2) ? [{ title: m.title, date: due }] : [];
  });
  return { cols, fc, today, todayItems, resume, rest, ahead };
}

/** The floor line shown on the Status Report for a level. */
export function floorText(s: State, date: string, level: number): string {
  const due = habitsDue(s, date, level);
  if (!due.length) return isRest(s, date) ? `${s.settings.restDayName}: essentials only.` : 'Rest. That is the whole job today.';
  return due.map((m) => `${habitTitle(m, level).replace(/^[^:]+:\s*/, '')} ${m.lowTitle && level <= 2 ? '' : habitMin(m, level) + ' min'}`.trim()).join(' · ');
}
