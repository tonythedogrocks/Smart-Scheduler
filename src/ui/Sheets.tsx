import { useState } from 'preact/hooks';
import { S, L, actions, go, setLocal, toast } from '../model/store';
import { dateOf, fmtT, nowTs, uid, weekday } from '../model/time';
import { eventsOn } from '../model/schedule';
import type { Mission, Level } from '../model/types';
import { fromHM, toHM } from './bits';

const WDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const close = () => setLocal({ sheet: null, sheetArg: undefined });
const val = (e: Event) => (e.target as HTMLInputElement).value;

function Sheet({ title, children }: { title: string; children: any }) {
  return (
    <div class="scrim" onClick={(e) => { if (e.target === e.currentTarget) close(); }}>
      <div class="sheet" role="dialog" aria-label={title}>
        <div class="row" style="justify-content:space-between"><h2>{title}</h2><button type="button" class="small" onClick={close}>Close</button></div>
        {children}
      </div>
    </div>
  );
}

function Flare() {
  const id = L().lastFlare!;
  const f = S().flares.find((x) => x.id === id);
  return (
    <Sheet title={`${S().settings.flareLabel.toUpperCase()} LOGGED`}>
      <span style="font-size:15px">Saved at {fmtT(new Date(f?.ts || nowTs()).getHours() * 60 + new Date(f?.ts || nowTs()).getMinutes())}. Rating it is optional.</span>
      <div class="rate" role="group" aria-label="Pain rating 0 to 10">
        {Array.from({ length: 11 }, (_, i) => <button type="button" class={f?.rating === i ? 'on' : ''} onClick={() => { actions.rateFlare(id, i); close(); }}>{i}</button>)}
      </div>
      <button type="button" class="plain" onClick={() => { actions.undoFlare(id); close(); }}>Undo, that was a mis-tap</button>
    </Sheet>
  );
}

const DOING = ['Gaming', 'Break', 'Phone', 'Eating', 'Chores', 'Out and about', 'Resting', 'Something else'];
function Doing() {
  return (
    <Sheet title="DOING NOW">
      <div class="grid2">{DOING.map((d) => <button type="button" onClick={() => { actions.doing(d); setLocal({ sheet: null }); }}>{d}</button>)}</div>
    </Sheet>
  );
}

function Add() {
  const arg = L().sheetArg || '';
  const [kind, setKind] = useState<'shift' | 'workout' | 'event' | 'cooking' | 'objective'>(arg.startsWith('objective') ? 'objective' : 'shift');
  const today = dateOf(nowTs());
  const [date, setDate] = useState(today);
  const [start, setStart] = useState('10:00');
  const cfg = S().settings;
  const [len, setLen] = useState(cfg.shift.lengths[0] || 240);
  const [end, setEnd] = useState('12:00');
  const [travel, setTravel] = useState(20);
  const [title, setTitle] = useState('');
  const [forFamily, setForFamily] = useState(true);
  const [repeat, setRepeat] = useState<'once' | 'weekly' | 'some'>('once');
  const [weeks, setWeeks] = useState<number[]>([]);
  const [skill, setSkill] = useState(arg.split(':')[1] || S().skills[0]?.id || '');
  const [target, setTarget] = useState('');
  const [due, setDue] = useState('');
  const st = fromHM(start);
  const en = kind === 'event' ? fromHM(end) : st + len;
  const tr = kind === 'shift' ? cfg.shift.travel : travel;
  const others = kind === 'objective' ? [] : eventsOn(S(), date);
  const warn: string[] = [];
  for (const o of others) {
    if (st - tr < o.end + o.travel && o.start - o.travel < en + tr) {
      if (kind === 'shift' && o.shiftGap && en <= o.start) { if (o.start - en < o.shiftGap) warn.push(`This shift ends ${o.start - en} min before ${o.title}. Going straight there needs at least ${o.shiftGap} min, travel included.`); }
      else warn.push(`This overlaps ${o.title} (${fmtT(o.start)} to ${fmtT(o.end)}), travel included.`);
    }
  }
  const save = () => {
    if (kind === 'objective') {
      if (!title.trim()) return;
      const id = actions.addObjective({ skillId: skill, title: title.trim().toUpperCase(), sub: due ? `Due ${due}` : 'New', status: 'Just added', target: target.trim() || 'To be decided', due: due || undefined });
      close(); go({ view: 'toc', c: skill, i: id, ch: 0, p: '' });
      return;
    }
    if (kind === 'cooking') {
      actions.setDay(date, { cook: forFamily ? 'family' : true });
      toast(forFamily ? 'Cooking for the family added' : 'Cooking added');
      close();
      return;
    }
    if (en <= st) return;
    const t = kind === 'shift' ? cfg.shift.title : kind === 'workout' ? cfg.workoutTitle : title.trim() || 'Event';
    actions.addEvent({ title: t, kind, start: st, end: en, travel: tr, ...(kind === 'event' && repeat !== 'once' ? { weekday: weekday(date), ...(repeat === 'some' && weeks.length ? { nth: [...weeks].sort() } : {}) } : { date }) });
    toast(`${t} added`);
    close();
  };
  return (
    <Sheet title="ADD">
      <div class="row">{(['shift', 'workout', 'event', 'cooking', 'objective'] as const).filter((k) => k !== 'objective' || S().skills.length).map((k) => <button type="button" class={`small ${kind === k ? 'on' : ''}`} onClick={() => setKind(k)}>{k === 'workout' ? cfg.workoutTitle : k === 'shift' ? cfg.shift.title : k[0].toUpperCase() + k.slice(1)}</button>)}</div>
      {kind === 'cooking' ? (
        <>
          <label class="field">Day<input type="date" value={date} onInput={(e) => setDate(val(e))} /></label>
          <div class="row">
            <button type="button" class={`small ${forFamily ? 'on' : ''}`} onClick={() => setForFamily(true)}>For the family</button>
            <button type="button" class={`small ${!forFamily ? 'on' : ''}`} onClick={() => setForFamily(false)}>Just me</button>
          </div>
          <span class="soft" style="font-size:14px">It's planned to finish right at dinner time. Move dinner on that day's Dinner panel to shift both.</span>
        </>
      ) : kind === 'objective' ? (
        <>
          <label class="field">Skill<select value={skill} onChange={(e) => setSkill(val(e))}>{S().skills.map((k) => <option value={k.id}>{k.title}</option>)}</select></label>
          <label class="field">Objective<input value={title} onInput={(e) => setTitle(val(e))} placeholder="What is the goal?" /></label>
          <label class="field">Target<input value={target} onInput={(e) => setTarget(val(e))} placeholder="What does done look like?" /></label>
          <label class="field">Real deadline (optional)<input type="date" value={due} onInput={(e) => setDue(val(e))} /></label>
          <span class="soft" style="font-size:14px">Add its Missions on the next screen.</span>
        </>
      ) : (
        <>
          {kind === 'event' && <label class="field">What<input value={title} onInput={(e) => setTitle(val(e))} placeholder="Class, meeting, appointment..." /></label>}
          <div class="row">
            <label class="field">Day<input type="date" value={date} onInput={(e) => setDate(val(e))} /></label>
            <label class="field">Starts<input type="time" value={start} onInput={(e) => setStart(val(e))} /></label>
            {kind === 'event' && <label class="field">Ends<input type="time" value={end} onInput={(e) => setEnd(val(e))} /></label>}
          </div>
          {kind !== 'event' && (
            <div class="row">
              <span style="font-size:14px">Length:</span>
              {(kind === 'shift' ? cfg.shift.lengths : [60, 90, 120]).map((m) => <button type="button" class={`small ${len === m ? 'on' : ''}`} onClick={() => setLen(m)}>{m / 60} h</button>)}
              <label class="field" style="max-width:130px">Other (min)<input inputMode="numeric" value={String(len)} onInput={(e) => setLen(Math.max(0, +val(e) || 0))} /></label>
            </div>
          )}
          {kind === 'shift'
            ? <span class="soft" style="font-size:14px">{cfg.shift.travel ? `${cfg.shift.travel} min travel each way is added automatically. ` : ''}Ends {fmtT(en)}.</span>
            : <label class="field" style="max-width:200px">Travel each way (min)<input inputMode="numeric" value={String(travel)} onInput={(e) => setTravel(Math.max(0, +val(e) || 0))} /></label>}
          {kind === 'event' && (
            <>
              <div class="row">
                <span style="font-size:14px">Repeats:</span>
                {([['once', 'Just once'], ['weekly', `Every ${WDAY[weekday(date)]}`], ['some', `Some ${WDAY[weekday(date)]}s`]] as const).map(([k, l]) => <button type="button" class={`small ${repeat === k ? 'on' : ''}`} onClick={() => setRepeat(k)}>{l}</button>)}
              </div>
              {repeat === 'some' && (
                <div class="row">
                  <span style="font-size:14px">Which ones each month:</span>
                  {[1, 2, 3, 4, 5].map((n) => <button type="button" class={`small ${weeks.includes(n) ? 'on' : ''}`} onClick={() => setWeeks(weeks.includes(n) ? weeks.filter((x) => x !== n) : [...weeks, n])}>{['1st', '2nd', '3rd', '4th', 'Last'][n - 1]}</button>)}
                </div>
              )}
            </>
          )}
          {[...new Set(warn)].map((w) => <div class="warn" role="alert">{w}</div>)}
        </>
      )}
      <button type="button" class="big go sm" onClick={save}>ADD IT</button>
    </Sheet>
  );
}

function MissionEdit() {
  const arg = L().sheetArg || '';
  const isNew = arg.startsWith('new:');
  const orig = S().missions.find((m) => m.id === arg);
  const [m, setM] = useState<Mission>(orig ? { ...orig } : { id: uid(), objectiveId: arg.slice(4), title: '', kind: 'work', energy: 'mental', minutes: 30, minLevel: 3, unitsLeft: 1, unitsTotal: 1, maxBlockUnits: 3, dailyCapMin: 180 });
  const up = (p: Partial<Mission>) => setM({ ...m, ...p });
  const num = (e: Event) => Math.max(0, +val(e) || 0);
  const save = () => {
    if (!m.title.trim()) return;
    const out = { ...m, title: m.title.trim() };
    if (out.kind === 'work') { out.unitsTotal = Math.max(out.unitsTotal || 0, out.unitsLeft || 0); if ((out.unitsLeft || 0) > 0) out.doneAt = undefined; }
    if (out.kind === 'practice') { out.dailyCapMin ||= out.minutes * 2; out.weeklyMin ||= out.minutes * 4; }
    actions.saveMission(out); close();
  };
  return (
    <Sheet title={isNew ? 'NEW MISSION' : 'EDIT MISSION'}>
      <label class="field">Mission<input value={m.title} onInput={(e) => up({ title: val(e) })} /></label>
      {isNew && (
        <div class="row">{(['work', 'practice', 'habit'] as const).map((k) => <button type="button" class={`small ${m.kind === k ? 'on' : ''}`} onClick={() => up({ kind: k, minLevel: k === 'habit' ? 2 : 3 })}>{k === 'work' ? 'Has an end' : k === 'practice' ? 'Ongoing practice' : 'Daily habit'}</button>)}</div>
      )}
      {m.kind === 'chore' && (
        <div class="row">
          <label class="field">Usually every (days)<input inputMode="numeric" value={String(m.everyDays ?? 7)} onInput={(e) => up({ everyDays: num(e) || 1 })} /></label>
          <label class="field">Last done<input type="date" value={m.lastAt || ''} onInput={(e) => up({ lastAt: val(e) || undefined })} /></label>
        </div>
      )}
      {m.kind === 'chore' && <span class="soft" style="font-size:14px">After a few runs the app learns the real gap and uses that instead.</span>}
      {m.kind !== 'chore' && <div class="row">
        <label class="field">{m.kind === 'work' ? 'Minutes per block' : 'Minutes'}<input inputMode="numeric" value={String(m.minutes)} onInput={(e) => up({ minutes: num(e) || 5 })} /></label>
        {m.kind === 'work' && <label class="field">Blocks left<input inputMode="numeric" value={String(m.unitsLeft ?? 0)} onInput={(e) => up({ unitsLeft: num(e) })} /></label>}
        {m.kind === 'practice' && <label class="field">Most per day (min)<input inputMode="numeric" value={String(m.dailyCapMin ?? '')} onInput={(e) => up({ dailyCapMin: num(e) })} /></label>}
      </div>}
      {m.kind !== 'chore' && <div class="row">
        <label class="field">Kind of energy<select value={m.energy} onChange={(e) => up({ energy: val(e) as Mission['energy'], workout: val(e) === 'physical' ? m.workout : false })}><option value="mental">Mental</option><option value="physical">Physical</option><option value="social">Social</option><option value="none">Light</option></select></label>
        <label class="field">Runs from level<select value={String(m.minLevel)} onChange={(e) => up({ minLevel: +val(e) as Level })}>{[1, 2, 3, 4, 5].map((n) => <option value={n}>{n} and up</option>)}</select></label>
      </div>}
      {m.energy === 'physical' && <label class="check"><input type="checkbox" checked={!!m.workout} onChange={(e) => up({ workout: (e.target as HTMLInputElement).checked })} />A real workout (waits after meals, eases when flares spike)</label>}
      {S().settings.restDay !== null && <label class="check"><input type="checkbox" checked={!!m.restOk} onChange={(e) => up({ restOk: (e.target as HTMLInputElement).checked })} />Counts as a {S().settings.restDayName} essential</label>}
      <button type="button" class="big go sm" onClick={save}>SAVE</button>
      {!isNew && <button type="button" class="plain" onClick={() => { actions.saveMission({ ...m, archived: true }); close(); go({ view: 'page', dir: 'out' }); }}>Retire this mission</button>}
    </Sheet>
  );
}

export function Sheets() {
  const sh = L().sheet;
  if (sh === 'flare') return <Flare />;
  if (sh === 'doing') return <Doing />;
  if (sh === 'add') return <Add key={L().sheetArg} />;
  if (sh === 'mission') return <MissionEdit key={L().sheetArg} />;
  return null;
}
void toHM;
