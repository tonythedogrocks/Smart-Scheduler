import { useState } from 'preact/hooks';
import { S, actions, go, setLocal } from '../model/store';
import type { PanelVM, Library } from '../model/vm';
import { fmtDur, fmtT, nowTs } from '../model/time';
import { bodyFat } from '../model/learn';
import { orders } from '../model/planner';
import { Arrow, useTick } from './bits';
import { Choice } from './Choice';

function Measure() {
  const last = S().measures[S().measures.length - 1];
  const [w, setW] = useState(String(last?.weight ?? ''));
  const [n, setN] = useState(String(last?.neck ?? ''));
  const [v, setV] = useState(String(last?.navel ?? ''));
  const ok = +w > 0 && +n > 0 && +v > +n;
  return (
    <>
      <div class="row" style="width:100%">
        <label class="field">Weight (lb)<input inputMode="decimal" value={w} onInput={(e) => setW((e.target as HTMLInputElement).value)} /></label>
        <label class="field">Neck (in)<input inputMode="decimal" value={n} onInput={(e) => setN((e.target as HTMLInputElement).value)} /></label>
        <label class="field">Navel (in)<input inputMode="decimal" value={v} onInput={(e) => setV((e.target as HTMLInputElement).value)} /></label>
      </div>
      {ok && <span class="soft" style="font-size:15px">About {bodyFat(+n, +v, S().settings.heightIn).toFixed(1)}% body fat (Navy tape)</span>}
      <button type="button" class="big fin sm" disabled={!ok} onClick={() => actions.addMeasure(+w, +n, +v)}>SAVE</button>
    </>
  );
}

export function Panel({ p, lib, anim }: { p: PanelVM; lib: Library; anim: string }) {
  useTick(15000);
  const s = S();
  const [flash, setFlash] = useState(false);
  const run = s.running;
  const mine = !!run && run.missionId === p.missionId && !p.done;
  const mission = p.missionId ? s.missions.find((m) => m.id === p.missionId) : undefined;
  const sab = lib.rest;
  const success = p.act === 'mission' && (p.done || flash) && !mine;
  const od = orders(lib.todayItems);
  const nextUp = od.now && od.now.key !== p.key ? od.now : od.next && od.next.key !== p.key ? od.next : null;
  const day = p.date ? s.days[p.date] || {} : {};
  const mealAt = p.meal ? (p.meal === 'lunch' ? day.lunchAt ?? s.settings.lunchAt : day.dinnerAt ?? s.settings.dinnerAt) : 0;
  const nudge = (d: number) => p.date && p.meal && actions.setDay(p.date, p.meal === 'lunch' ? { lunchAt: mealAt + d } : { dinnerAt: mealAt + d });
  return (
    <div class="full" style={`animation:${anim} 420ms cubic-bezier(.2,.9,.25,1) both`}>
      <span class="cap">{p.h}</span>
      <h1>{p.t.toUpperCase()}</h1>
      {p.m && <span style="font-size:17px">{p.m}</span>}
      {p.d && <p class="bubble">{p.d}</p>}
      <div class="actions">
        {p.act === 'mission' && mission?.form === 'measure' && !p.done && !flash && <Measure />}
        {p.act === 'mission' && mission?.form !== 'measure' && !success && !mine && (
          <>
            <button type="button" class="big go" disabled={!!run} onClick={() => actions.start(p.missionId!, p.units || 1, p.baseMin || mission?.minutes || 10)}>
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z" /></svg>
              <span>START!</span>
            </button>
            {run && <span class="soft" style="font-size:14px;text-align:center">Another {sab ? 'task' : 'mission'} is in progress. Finish or stop it first.</span>}
          </>
        )}
        {mine && run && (
          <>
            <span class="caption" style="align-self:flex-start;font-size:17px;transform:rotate(-1.5deg)">{sab ? 'IN PROGRESS' : 'MISSION IN PROGRESS'}... {fmtDur(Math.max(0, (nowTs() - run.startedAt) / 60000))}</span>
            <button type="button" class="big fin" onClick={() => { actions.finish(true); setFlash(true); }}>
              <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              <span>DONE!</span>
            </button>
            <button type="button" class="plain" onClick={() => actions.finish(false)}>Stop here. The rest goes back to the pool.</button>
          </>
        )}
        {success && (
          <>
            <div class="burst"><div>{sab ? <>DONE.</> : <>MISSION<br />SUCCESS!</>}</div></div>
            {nextUp && p.date === lib.today && (
              <button type="button" class="small" style="align-self:center" onClick={() => { setFlash(false); go({ view: 'panel', c: 'week', i: lib.today, ch: Math.max(0, lib.cols[0].issues.find((i) => i.key === lib.today)!.chapters.findIndex((c) => c.panels.some((x) => x.key === nextUp.key))), p: nextUp.key }); }}>
                Next: {nextUp.title} · {fmtT(nextUp.start)}
              </button>
            )}
          </>
        )}
        {p.act === 'meal' && p.date && p.date >= lib.today && (
          <div class="row">
            <span style="font-size:15px">Move it:</span>
            {[-30, -15, 15, 30].map((d) => <button type="button" class="small" onClick={() => nudge(d)}>{d > 0 ? '+' : '−'}{Math.abs(d)} min</button>)}
          </div>
        )}
        {p.act === 'choice' && p.date && p.evtId && <Choice evtId={p.evtId} date={p.date} />}
        {p.act === 'event' && p.evtId && p.date && p.date >= lib.today && (
          <button type="button" class="small" onClick={() => { actions.removeEvent(p.evtId!, p.date); go({ view: 'page', dir: 'out' }); }}>
            {s.events.find((e) => e.id === p.evtId)?.date ? 'Remove this event' : 'Skip it this week'}
          </button>
        )}
        {p.act === 'objective' && p.objectiveId && (
          <button type="button" class="small" onClick={() => actions.completeObjective(p.objectiveId!, !p.done)}>{p.done ? 'Reopen this Objective' : 'Mark this Objective complete'}</button>
        )}
        {p.editable && p.missionId && !mine && <button type="button" class="plain" onClick={() => setLocal({ sheet: 'mission', sheetArg: p.missionId })}>Edit this mission</button>}
        {p.key === 'debrief' && <button type="button" class="small" onClick={() => go({ view: 'debrief' })}>Open Debrief</button>}
        {p.key === 'shifts' && <button type="button" class="small" onClick={() => setLocal({ sheet: 'add' })}>Enter shifts</button>}
      </div>
    </div>
  );
}
