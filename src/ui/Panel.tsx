import { useState } from 'preact/hooks';
import { S, actions, go } from '../model/store';
import { nextAfter, type DayVM, type PanelVM } from '../model/vm';
import { fmtDur, fmtT, nowTs } from '../model/time';
import { bodyFat } from '../model/learn';
import { describeUnits, nextLabels } from '../model/planner';
import { fromHM, toHM, useTick } from './bits';
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

export function Panel({ p, day }: { p: PanelVM; day: DayVM }) {
  useTick(15000);
  const s = S();
  const [flash, setFlash] = useState(false);
  const run = s.running;
  const mine = !!run && run.missionId === p.missionId && run.step === p.step && !p.done;
  const mission = p.missionId ? s.missions.find((m) => m.id === p.missionId) : undefined;
  const success = p.act === 'mission' && (p.done || flash) && !mine;
  const nextUp = day.isToday ? nextAfter(day.items, p.key) : null;
  const lib = { today: day.today };
  const dayRec = s.days[p.date] || {};
  const mealAt = p.meal ? (p.meal === 'lunch' ? dayRec.lunchAt ?? s.settings.lunchAt : dayRec.dinnerAt ?? s.settings.dinnerAt) : 0;
  const nudge = (d: number) => p.date && p.meal && actions.setDay(p.date, p.meal === 'lunch' ? { lunchAt: mealAt + d } : { dinnerAt: mealAt + d });
  return (
    <div class="full" style="animation:lbPop 420ms cubic-bezier(.2,.9,.25,1) both">
      <span class="cap">{p.h}</span>
      {p.must && !p.done && <span class={`must ${p.must}`} style="align-self:flex-start">{p.must === 'final' ? 'FINAL SHOT' : 'DANGER ZONE'}</span>}
      <h1>{p.t.toUpperCase()}</h1>
      {p.m && <span style="font-size:17px">{p.m}</span>}
      {p.d && <p class="bubble">{p.d}</p>}
      <div class="actions">
        {p.act === 'mission' && mission?.form === 'measure' && !p.done && !flash && <Measure />}
        {p.act === 'mission' && mission?.form !== 'measure' && !success && !mine && (
          <>
            {mission?.kind === 'chore' ? (
              // a chore step is a quick tap: no timer running through the wait between steps
              <button type="button" class="big fin" disabled={!!run} onClick={() => { const t = new Date(nowTs()), nm = t.getHours() * 60 + t.getMinutes(), len = p.min || 5; actions.doneEarlier(p.missionId!, 1, len, nm - len, nm, p.step, p.key); setFlash(true); }}>
                <span>DONE!</span>
              </button>
            ) : (
            <button type="button" class="big go" disabled={!!run} onClick={() => actions.start(p.missionId!, p.units || 1, p.baseMin || mission?.minutes || 10, p.step, p.key)}>
              <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12-7.5z" /></svg>
              <span>START!</span>
            </button>
            )}
            {run && <span class="soft" style="font-size:14px;text-align:center">Another mission is in progress. Finish or stop it first.</span>}
            {p.date === lib.today && !p.done && <Earlier p={p} />}
          </>
        )}
        {mine && run && (
          <>
            <span class="caption" style="align-self:flex-start;font-size:17px;transform:rotate(-1.5deg)">MISSION IN PROGRESS... {fmtDur(Math.max(0, (nowTs() - run.startedAt) / 60000))}</span>
            {mission?.kind === 'work' && mission.labels?.length ? <Steps labels={nextLabels(mission, run.units)} ticked={run.ticked || 0} /> : null}
            <button type="button" class="big fin" onClick={() => { actions.finish(true); setFlash(true); }}>
              <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              <span>DONE!</span>
            </button>
            {!mission?.errand && <button type="button" class="plain" onClick={() => actions.finish(false)}>Continue later (pause for a break)</button>}
          </>
        )}
        {success && (
          <>
            <div class="burst"><div>MISSION<br />SUCCESS!</div></div>
            {(() => {
              // the real times can be fixed after the fact
              const l = p.logId ? s.logs.find((x) => x.id === p.logId) : [...s.logs].reverse().find((x) => x.missionId === p.missionId && x.done && (p.step === undefined || x.step === p.step));
              if (!l || l.end <= 0) return null;
              const hm = (ts: number) => { const d0 = new Date(ts); return d0.getHours() * 60 + d0.getMinutes(); };
              const box = 'height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700';
              return (
                <div class="row">
                  <span style="font-size:15px">From</span>
                  <input type="time" aria-label="Started at" value={toHM(hm(l.start))} style={box} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) actions.editLog(l.id, fromHM(v), hm(l.end)); }} />
                  <span style="font-size:15px">to</span>
                  <input type="time" aria-label="Finished at" value={toHM(hm(l.end))} style={box} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) actions.editLog(l.id, hm(l.start), fromHM(v)); }} />
                </div>
              );
            })()}
            {nextUp && p.date === lib.today && (
              <button type="button" class="small" style="align-self:center" onClick={() => { setFlash(false); go({ open: nextUp.key }); }}>
                Next: {nextUp.title} · {fmtT(nextUp.start)}
              </button>
            )}
          </>
        )}
        {p.act === 'meal' && p.meal && p.date === lib.today && (() => {
          const got = dayRec.ate?.[p.meal!];
          return got ? (
            <>
              <div class="row">
                <span style="font-size:15px">Ate at</span>
                <input type="time" aria-label="Time you ate" value={toHM(got.at)} style="height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700" onChange={(e) => actions.ate(p.meal!, fromHM((e.target as HTMLInputElement).value))} />
                <button type="button" class={`small ${got.big ? 'on' : ''}`} onClick={() => actions.ate(p.meal!, got.at, !got.big)}>Large meal</button>
              </div>
              {got.end === undefined ? (
                <button type="button" class="big fin sm" onClick={() => actions.doneEating(p.meal!)}>DONE EATING</button>
              ) : (
                <div class="row">
                  <span style="font-size:15px">Done at</span>
                  <input type="time" aria-label="Time you finished eating" value={toHM(got.end)} style="height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700" onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) actions.doneEating(p.meal!, fromHM(v)); }} />
                </div>
              )}
              <span class="soft" style="font-size:14px">Workouts wait {fmtDur(got.big ? Math.max(s.settings.mealGap, s.settings.bigMealGap) : s.settings.mealGap)} after it.</span>
              <button type="button" class="plain" onClick={() => actions.ate(p.meal!, null)}>Haven't eaten yet after all</button>
            </>
          ) : (
            <>
              <button type="button" class="big go sm" onClick={() => (p.meal === 'dinner' ? actions.dinnerNow() : actions.ate('lunch'))}>EATING NOW</button>
              <div class="row">
                <span style="font-size:15px">Or I already ate at</span>
                <input type="time" aria-label="Time you ate" style="height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700" onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) actions.ate(p.meal!, fromHM(v)); }} />
              </div>
            </>
          );
        })()}
        {p.act === 'meal' && p.meal === 'dinner' && p.date && p.date >= lib.today && !dayRec.cook && (
          <div class="row">
            <button type="button" class="small on" onClick={() => actions.setDay(p.date!, { cook: true })}>I'm cooking for myself</button>
            <button type="button" class="small on" onClick={() => actions.setDay(p.date!, { cook: 'family' })}>I'm cooking for the family</button>
          </div>
        )}
        {p.act === 'morning' && p.date === lib.today && (
          dayRec.morningEnd ? (
            <>
              <span class="caption" style="align-self:flex-start;font-size:17px">READY FOR THE DAY!</span>
              <div class="row">
                <span style="font-size:15px">Finished at</span>
                <input type="time" aria-label="Time you finished your morning routine" value={toHM(new Date(dayRec.morningEnd).getHours() * 60 + new Date(dayRec.morningEnd).getMinutes())} style="height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700"
                  onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (!v) return; const d0 = new Date(dayRec.morningEnd!); d0.setHours(0, 0, 0, 0); actions.setDay(p.date!, { morningEnd: d0.getTime() + fromHM(v) * 60000 }); }} />
              </div>
            </>
          )
          : <button type="button" class="big fin" onClick={() => actions.setDay(p.date!, { morningEnd: nowTs() })}>
              <svg aria-hidden="true" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              <span>DONE!</span>
            </button>
        )}
        {p.act === 'dishes' && p.date === lib.today && (() => {
          const meal = p.key === 'f:dishes1' ? 'lunch' : 'dinner', r = dayRec.dishes?.[meal];
          const put = (v: { start: number; end?: number }) => actions.setDay(p.date!, { dishes: { ...(dayRec.dishes || {}), [meal]: v } });
          return r?.end !== undefined ? <span class="caption" style="align-self:flex-start;font-size:17px">DISHES DONE. {fmtDur((r.end - r.start) / 60000)}</span>
            : r ? (
              <>
                <span class="caption" style="align-self:flex-start;font-size:17px;transform:rotate(-1.5deg)">DISHES... {fmtDur(Math.max(0, (nowTs() - r.start) / 60000))}</span>
                <button type="button" class="big fin" onClick={() => put({ ...r, end: nowTs() })}>DONE!</button>
              </>
            ) : <button type="button" class="big go" onClick={() => put({ start: nowTs() })}>START!</button>;
        })()}
        {p.act === 'cook' && p.date && (
          dayRec.cookEnd ? <span class="caption" style="align-self:flex-start;font-size:17px">COOKED. DINNER'S ON.</span>
          : dayRec.cookStart ? (
            <>
              <span class="caption" style="align-self:flex-start;font-size:17px;transform:rotate(-1.5deg)">COOKING... {fmtDur(Math.max(0, (nowTs() - dayRec.cookStart) / 60000))}</span>
              <button type="button" class="big fin" onClick={() => { const t = nowTs(); actions.setDay(p.date!, { cookEnd: t, dinnerAt: Math.round(new Date(t).getHours() * 60 + new Date(t).getMinutes()) }); }}>DONE!</button>
            </>
          ) : (
            <>
              {p.date === lib.today && <button type="button" class="big go" onClick={() => actions.setDay(p.date!, { cookStart: nowTs() })}>START!</button>}
              <button type="button" class="plain" onClick={() => actions.setDay(p.date!, { cook: false })}>Not cooking after all</button>
            </>
          )
        )}
        {p.act === 'meal' && p.date && p.date >= lib.today && !(p.meal && dayRec.ate?.[p.meal]) && (
          <div class="row">
            <span style="font-size:15px">Move it:</span>
            {[-30, -15, 15, 30].map((d) => <button type="button" class="small" onClick={() => nudge(d)}>{d > 0 ? '+' : '−'}{Math.abs(d)} min</button>)}
          </div>
        )}
        {p.act === 'choice' && p.date && p.evtId && <Choice evtId={p.evtId} date={p.date} />}
        {p.act === 'event' && p.evtId && p.date === lib.today && s.events.find((e) => e.id === p.evtId)?.untilBack && !dayRec.backAt && (
          <button type="button" class="big fin" onClick={() => actions.setDay(p.date!, { backAt: nowTs() })}>I'M BACK</button>
        )}
        {p.act === 'event' && p.evtId && p.date && p.date >= lib.today && (
          <button type="button" class="small" onClick={() => { actions.removeEvent(p.evtId!, p.date); go({ open: '' }); }}>
            {s.events.find((e) => e.id === p.evtId)?.date ? 'Remove this event' : 'Skip it this week'}
          </button>
        )}
      </div>
    </div>
  );
}

/** The running block's steps, ticked off in order. Stopping early still counts what's ticked. */
function Steps({ labels, ticked }: { labels: string[]; ticked: number }) {
  const items: { t: string; n: number; upTo: number }[] = [];
  let upTo = 0;
  for (const l of labels) {
    const last = items[items.length - 1];
    if (last && labels[upTo - 1] === l) { last.n++; last.upTo = ++upTo; continue; }
    upTo++;
    items.push({ t: describeUnits([l]), n: 1, upTo });
  }
  return (
    <ul class="steps" style="list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:2px;width:100%">
      {items.map((it, i) => {
        const on = ticked >= it.upTo, before = i === 0 ? 0 : items[i - 1].upTo;
        const can = on ? ticked === it.upTo : ticked === before;
        return (
          <li><label class="check" style={on ? 'text-decoration:line-through;color:var(--soft)' : ''}>
            <input type="checkbox" checked={on} disabled={!can} onChange={() => actions.tick(on ? before : it.upTo)} />{it.t}
          </label></li>
        );
      })}
    </ul>
  );
}

/** Logging something after the fact, with the real times, so the app learns real lengths. */
function Earlier({ p }: { p: PanelVM }) {
  const [open, setOpen] = useState(false);
  const now = new Date(nowTs()), nm = now.getHours() * 60 + now.getMinutes();
  const len = p.min || p.baseMin || 10;
  const [from, setFrom] = useState(Math.max(0, nm - len)), [to, setTo] = useState(nm);
  if (!open) return <button type="button" class="plain" onClick={() => setOpen(true)}>I did this earlier</button>;
  const box = 'height:44px;padding:0 8px;border:3px solid var(--ink);border-radius:6px;font-weight:700';
  return (
    <>
      <div class="row">
        <span style="font-size:15px">From</span>
        <input type="time" aria-label="Started at" value={toHM(from)} style={box} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) setFrom(fromHM(v)); }} />
        <span style="font-size:15px">to</span>
        <input type="time" aria-label="Finished at" value={toHM(to)} style={box} onChange={(e) => { const v = (e.target as HTMLInputElement).value; if (v) setTo(fromHM(v)); }} />
      </div>
      <button type="button" class="big fin sm" disabled={to <= from} onClick={() => actions.doneEarlier(p.missionId!, p.units || 1, p.baseMin || len, from, to, p.step, p.key)}>SAVE</button>
    </>
  );
}
