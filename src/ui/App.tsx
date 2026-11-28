import { useEffect, useState } from 'preact/hooks';
import { S, L, actions, go, setLocal } from '../model/store';
import { AHEAD, dayView } from '../model/vm';
import { GRACE, planSig } from '../model/planner';
import { eatingNow } from '../model/schedule';
import { isFresh, onSyncStatus, syncStatus } from '../model/sync';
import type { PlanSnap } from '../model/types';
import { addDays, dateOf, fmtDate, fmtDay, fmtLong, minsOf, nowTs } from '../model/time';
import { useStore, useTick } from './bits';
import { Panel } from './Panel';
import { Settings } from './Extra';

const Back = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button type="button" class="back" onClick={onClick}>
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
    <span>{label}</span>
  </button>
);

export function App() {
  useStore();
  const [, bumpSync] = useState(0);
  useEffect(() => onSyncStatus(() => bumpSync((n) => n + 1)), []);
  useTick(30000);
  const s = S(), l = L(), now = nowTs(), today = dateOf(now), nav = l.nav;
  const day = dayView(s, now, nav.date || today);
  const todayView = day.isToday ? day : dayView(s, now, today);
  const open = nav.open ? day.panels.find((p) => p.key === nav.open)
    // a block can get a new key as plans shift: follow it by its mission
    || day.panels.find((p) => p.missionId && p.missionId === /^m:(.+):\d+$/.exec(nav.open)?.[1] && !p.done) : undefined;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') go(L().nav.open ? { open: '' } : { settings: false }); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Today's plan stands once the day has started; it's saved whenever it was (re)built.
  useEffect(() => {
    const d = S().days[today];
    const started = !!d?.morningEnd || todayView.items.some((i) => i.block?.key === 'f:morning' && i.past);
    if (!started || !isFresh()) return;
    const sig = planSig(S(), today);
    if (d?.plan?.sig === sig) return;
    const items: PlanSnap[] = todayView.items.filter((i) => i.kind === 'mission' && !i.done && !i.running && i.missionId)
      .map((i) => ({ key: i.key, missionId: i.missionId!, start: i.start, end: i.end, title: i.title, sub: i.sub, detail: i.detail, units: i.units, baseMin: i.baseMin, min: i.min, step: i.step }));
    actions.savePlan(sig, items);
  });
  // Missed: a planned block still unstarted 5 minutes after its time. It's noted (the app learns from it) and the day re-plans.
  useEffect(() => {
    if (S().running || document.visibilityState !== 'visible' || !isFresh()) return;
    const nm = minsOf(nowTs());
    if (eatingNow(S(), today, nm)) return;
    const late = todayView.items.find((i) => i.kind === 'mission' && !i.done && !i.running && i.missionId && i.start + GRACE <= nm);
    if (late) actions.recordMiss(late.missionId!, late.start);
    else {
      const meal = todayView.items.find((i) => i.kind === 'fixed' && i.block?.kind === 'meal' && !i.block.ate && i.block.meal && i.start + (S().days[today]?.mealMoved?.[i.block.meal] === i.start ? 30 : GRACE) <= nm);
      if (meal) actions.mealLate(meal.block!.meal!);
    }
  });
  useEffect(() => { if (l.toast) { const t = setTimeout(() => setLocal({ toast: undefined }), 2600); return () => clearTimeout(t); } }, [l.toast?.id]);

  const dates = Array.from({ length: AHEAD + 1 }, (_, i) => addDays(today, i));
  const sync = syncStatus();
  const warns = todayView.fc.warns;

  return (
    <div class="app">
      <div class="topbar">
        {open || nav.settings ? <Back label="DAY" onClick={() => go(open ? { open: '' } : { settings: false })} /> : (
          <div class="days" role="tablist" aria-label="Day">
            {dates.map((d, i) => (
              <button type="button" role="tab" aria-selected={d === day.date} class={`daychip ${d === day.date ? 'on' : ''} ${i === 0 ? 'today' : ''}`} onClick={() => go({ date: i === 0 ? '' : d, open: '' })}>
                {i === 0 ? 'TODAY' : i === 1 ? 'TOMORROW' : fmtDay(d)}
              </button>
            ))}
          </div>
        )}
        {!open && !nav.settings && (
          <button type="button" class="gear" aria-label="Settings" onClick={() => go({ settings: true })}>
            <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></svg>
          </button>
        )}
      </div>

      <div class="scroll" key={`${day.date}|${nav.open}|${nav.settings}`}>
        {nav.settings ? <div class="view"><Settings /></div>
          : open ? <Panel key={open.key} p={open} day={day} />
          : (
            <div class="book">
              <div class="head">
                <span class={`k ${day.isToday ? 'is-today' : ''}`}>{day.isToday ? 'TODAY' : (() => { const n = Math.round((new Date(day.date).getTime() - new Date(today).getTime()) / 86400000); return n === 1 ? 'TOMORROW' : `IN ${n} DAYS`; })()}</span>
                <h1>{fmtLong(day.date)}</h1>
                {!day.isToday && <button type="button" class="small" style="align-self:flex-start" onClick={() => go({ date: '' })}>Back to today</button>}
              </div>
              {sync.state === 'error' && /token|allowed|not found|out of date/i.test(sync.error || '') && (
                <button type="button" class="alert" onClick={() => go({ settings: true })}>
                  <span class="k">SYNC ISN'T WORKING</span>
                  <span>{sync.error} Your changes are saved on this device but aren't reaching your other one. Tap to fix it in Settings.</span>
                </button>
              )}
              {!s.missions.length && (
                <button type="button" class="alert" onClick={() => go({ settings: true })}>
                  <span class="k">NOTHING HERE YET</span>
                  <span>Your goals load from your private data. Open Settings and connect Sync.</span>
                </button>
              )}
              {(['failure', 'pace'] as const).map((kind) => {
                const ws = warns.filter((w) => w.kind === kind);
                if (!ws.length) return null;
                return (
                  <div class="alert lock">
                    <span class="k">{kind === 'failure' ? 'MISSION FAILURE' : 'DANGER ZONE'}</span>
                    <span>{kind === 'failure' ? 'Even with every free hour, these miss their deadline:' : 'At your usual pace, these miss their deadline:'}</span>
                    {ws.map((w) => <span><b>{w.title}</b>: lands {w.lands ? `about ${fmtDate(w.lands)}` : 'too late'}, due {fmtDate(w.due)}</span>)}
                  </div>
                );
              })}
              <ol class="tl">
                {day.panels.map((p) => (
                  <li class={`${p.now ? 'is-now' : ''} ${p.done ? 'is-done' : ''} ${p.past && !p.done && !p.now ? 'is-past' : ''}`}>
                    <span class="tl-time">{p.time || p.h}</span>
                    <button type="button" class={`tl-card ${p.fixed ? 'fixed' : ''} ${p.must && !p.done ? `is-must ${p.must}` : ''}`} style={p.color && !p.done && !p.now ? `border-left:10px solid ${p.color}` : ''} onClick={() => go({ open: p.key })}>
                      {(p.kick || (p.must && !p.done)) && <span class="tl-kick">{p.must && !p.done && <span class={`must ${p.must}`}>{p.must === 'final' ? 'FINAL SHOT' : 'DANGER ZONE'}</span>}{p.kick}</span>}
                      <span class="tl-t">{p.t}</span>
                      {p.m && <span class="tl-m">{p.m}</span>}
                      {(p.done || p.now || p.running) && <span class="tag" style={`color:${p.done ? '#1B7A44' : '#B3231A'};border-color:${p.done ? '#1B7A44' : '#B3231A'}`}>{p.done ? 'DONE' : p.running ? 'GOING' : 'NOW!'}</span>}
                    </button>
                  </li>
                ))}
              </ol>
            </div>
          )}
      </div>
      {l.toast && <div class="toast" role="status" key={l.toast.id}>{l.toast.text}</div>}
    </div>
  );
}
