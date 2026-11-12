import { useEffect, useState } from 'preact/hooks';
import { S, L, actions, go, setLocal, type Nav } from '../model/store';
import { buildLibrary, type PanelVM } from '../model/vm';
import { GRACE, planSig } from '../model/planner';
import { onSyncStatus, syncStatus } from '../model/sync';
import type { PlanSnap } from '../model/types';
import { addDays, dateOf, fmtDate, fmtDay, fmtDur, nowTs, diffDays } from '../model/time';
import { levelName } from '../model/seed';
import { heroLevel, xpOf } from '../model/game';
import { Arrow, useStore, useTick } from './bits';
import { StatusReport } from './StatusReport';
import { Panel } from './Panel';
import { Sheets } from './Sheets';
import { Achievements, Debrief, Settings } from './Extra';

const IN: Record<string, string> = { shelf: 'lbZoomOut', col: 'lbZoomIn', toc: 'lbOpen', page: 'lbFlip', panel: 'lbPop', debrief: 'lbZoomIn', settings: 'lbZoomIn', achievements: 'lbZoomIn' };
const BACK: Record<string, Nav['view']> = { col: 'shelf', toc: 'col', page: 'toc', panel: 'page', debrief: 'shelf', settings: 'shelf', achievements: 'shelf' };

function Cell({ p, onOpen }: { p: PanelVM; onOpen: () => void }) {
  const running = S().running?.missionId === p.missionId && p.running;
  const tag = p.done ? 'DONE' : running ? 'GOING' : p.now ? 'NOW!' : '';
  return (
    <button type="button" class={`cell ${p.wide ? 'span2' : ''} ${p.done ? 'done' : p.now ? 'now' : ''} ${p.alert ? 'alert-cell' : ''}`} onClick={onOpen}>
      <span class="h">{p.h}</span>
      <span class="t">{p.t}</span>
      {p.m && <span class="m">{p.m}</span>}
      {tag && <span class="tag" style={`color:${p.done ? '#1B7A44' : '#B3231A'};border-color:${p.done ? '#1B7A44' : '#B3231A'}`}>{tag}</span>}
    </button>
  );
}

export function App() {
  useStore();
  const [, bumpSync] = useState(0);
  useEffect(() => onSyncStatus(() => bumpSync((n) => n + 1)), []);
  useTick(30000);
  const s = S(), l = L(), now = nowTs(), today = dateOf(now);
  const needStatus = !s.days[today]?.level;
  const lib = buildLibrary(s, now);
  const nav = l.nav;
  const col = lib.cols.find((c) => c.key === nav.c) || lib.cols[0];
  const issue = col.issues.find((i) => i.key === nav.i) || (col.key === 'week' ? col.issues.find((i) => i.key === today) : undefined) || col.issues[0];
  const chapter = issue?.chapters[nav.ch] || issue?.chapters[0];
  // a panel can move to another part of the day as plans shift: find it wherever it went
  const allPanels = issue?.chapters.flatMap((c) => c.panels) || [];
  // the open block can get a new id when it starts (a mission with several blocks today): follow it, never fall back to another item
  const navMission = /^m:(.+):\d+$/.exec(nav.p || '')?.[1];
  const panel = chapter?.panels.find((p) => p.key === nav.p) || allPanels.find((p) => p.key === nav.p)
    || (navMission ? allPanels.find((p) => p.missionId === navMission && p.running) || allPanels.find((p) => p.missionId === navMission && !p.done) : undefined)
    || chapter?.panels[0];
  let view = nav.view;
  if (!issue && (view === 'toc' || view === 'page' || view === 'panel')) view = 'col';
  const anim = nav.dir === 'out' ? 'lbZoomOut' : IN[view];
  const style = (ms = 420) => `animation:${anim} ${ms}ms cubic-bezier(.2,.9,.25,1) both`;
  const lv = s.days[today]?.level;
  const hero = heroLevel(xpOf(s));
  const backLabel: Record<string, string> = { col: 'SHELF', toc: col.title.length > 12 ? 'COLLECTION' : col.title, page: 'CONTENTS', panel: nav.c === 'week' ? 'DAY' : 'PAGE', debrief: 'SHELF', settings: 'SHELF', achievements: 'SHELF' };
  const backTo = (v: Nav['view']) => (v === 'panel' && nav.c === 'week' ? 'toc' : BACK[v] || 'shelf');
  const back = () => go({ view: backTo(view), dir: 'out' });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { if (L().sheet) setLocal({ sheet: null }); else if (L().nav.view !== 'shelf') go({ view: L().nav.view === 'panel' && L().nav.c === 'week' ? 'toc' : BACK[L().nav.view] || 'shelf', dir: 'out' }); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => { if (!needStatus) actions.checkFloor(); });
  // Today's plan is fixed once the day has started; save it whenever it was (re)built.
  useEffect(() => {
    if (needStatus) return;
    const d = S().days[today];
    if (!d?.level || !d.morningEnd || dateOf(d.morningEnd) !== today) return;
    const sig = planSig(S(), today);
    if (d.plan?.sig === sig) return;
    const items: PlanSnap[] = lib.todayItems.filter((i) => i.kind === 'mission' && !i.done && !i.running && i.missionId)
      .map((i) => ({ key: i.key, missionId: i.missionId!, start: i.start, end: i.end, title: i.title, sub: i.sub, detail: i.detail, units: i.units, baseMin: i.baseMin, min: i.min, step: i.step }));
    actions.savePlan(sig, items);
  });
  // Missed: a planned block still unstarted 5 minutes after its time. Log it (feeds the energy model) and the day re-plans.
  useEffect(() => {
    if (needStatus || S().running || document.visibilityState !== 'visible') return;
    const t = new Date(nowTs()), nm = t.getHours() * 60 + t.getMinutes();
    const late = lib.todayItems.find((i) => i.kind === 'mission' && !i.done && !i.running && i.missionId && i.start + GRACE <= nm);
    if (late) actions.recordMiss(late.missionId!, late.start);
    else {
      const meal = lib.todayItems.find((i) => i.kind === 'fixed' && i.block?.kind === 'meal' && !i.block.ate && i.block.meal && i.start + GRACE <= nm);
      if (meal) actions.mealLate(meal.block!.meal!);
    }
  });
  useEffect(() => { if (l.toast) { const t = setTimeout(() => setLocal({ toast: undefined }), 2600); return () => clearTimeout(t); } }, [l.toast?.id]);

  if (needStatus || l.status) return <StatusReport />;
  const north = s.settings.north;
  const months = north.date ? Math.max(0, Math.round(diffDays(today, north.date) / 30.4)) : null;
  // One calm, specific heads-up at most: the nearest deadline, and within it the Objective with the most left to do.
  const left = (id: string) => s.missions.filter((m) => m.objectiveId === id && m.kind === 'work').reduce((a, m) => a + (m.unitsLeft || 0) * m.minutes, 0);
  const risks = [...lib.fc.risks].sort((a, b) => a.due.localeCompare(b.due) || left(b.objectiveId) - left(a.objectiveId));

  return (
    <div class="app">
      <div class="topbar">
        {view !== 'shelf' && (
          <button type="button" class="back" onClick={back}>
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
            <span>{backLabel[view]}</span>
          </button>
        )}
        {view === 'shelf' && <span class="caption">THE SHELF</span>}
        <button type="button" class="lvchip" aria-label={`Change today's level, currently ${lv} ${levelName(lv || 3)}`} onClick={() => setLocal({ status: true })}>
          <b>{lv}</b><span>{levelName(lv || 3)}</span>
        </button>
      </div>

      <div class="scroll" key={`${view}|${nav.c}|${nav.i}|${nav.ch}|${view === 'panel' ? nav.p : ''}`}>
        {view === 'shelf' && (
          <div class="view" style={style()}>
            <div class="shelf-top view">
              <div style="display:flex;flex-direction:column;gap:2px">
                <span class="title-kicker">{north.kicker}</span>
                <h1 class="title-big">{north.title}</h1>
                {(months !== null || north.sub) && <span class="soft" style="margin-top:8px;font-size:14px">{[months !== null ? `About ${months} months to ${north.toWhat}` : '', north.sub].filter(Boolean).join(' · ')}</span>}
                <div class="xp" style="margin-top:6px">
                  <span class="d" style="font-size:16px">LEVEL {hero.level}</span>
                  <span class="xpbar" role="img" aria-label={`${hero.into} of ${hero.span} XP to the next level`}><i style={`width:${Math.round((100 * hero.into) / hero.span)}%`} /></span>
                  <span>{xpOf(s)} XP</span>
                </div>
              </div>
              <div class="view" style="gap:12px">
                {lib.resume && (
                  <button type="button" class="resume" onClick={() => go({ view: 'panel', c: 'week', i: today, ch: lib.resume!.ch, p: lib.resume!.p })}>
                    <span style="flex-grow:1;display:flex;flex-direction:column;gap:2px">
                      <span class="k">PICK UP WHERE YOU LEFT OFF</span>
                      <span class="t">{lib.resume.title}</span>
                      <span style="font-size:13px">{lib.resume.sub}</span>
                    </span>
                    <Arrow size={26} />
                  </button>
                )}
                {lib.fc.lockIn && (() => {
                  const li = lib.fc.lockIn!, o = s.objectives.find((x) => x.id === li.objectiveId);
                  return (
                    <button type="button" class="alert lock" onClick={() => o && go({ view: 'toc', c: o.skillId, i: o.id, ch: 0, p: '' })}>
                      <span class="k">LOCK IN: {li.title}</span>
                      <span>Your deadlines need more than a comfortable day{li.today > li.comfort ? ` (today about ${fmtDur(li.today)}, comfortable is about ${fmtDur(li.comfort)})` : ''}. About {fmtDur(li.perDay)} a day on this one until {fmtDate(li.until)}.{li.late.length ? ` Even then, ${li.late.length === 1 ? 'one deadline' : `${li.late.length} deadlines`} may land late.` : ''}</span>
                    </button>
                  );
                })()}
                {!lib.fc.lockIn && risks.slice(0, 1).map((r) => {
                  const o = s.objectives.find((x) => x.id === r.objectiveId)!;
                  return (
                    <button type="button" class="alert" onClick={() => go({ view: 'page', c: o.skillId, i: o.id, ch: 0, p: 'deadline' })}>
                      <span class="k">HEADS UP: {r.title}</span>
                      <span>{r.lands ? `At a modest pace this lands about ${fmtDate(r.lands)}, past ${fmtDate(r.due)}.` : `At a modest pace this misses ${fmtDate(r.due)}.`} Good days pull it in.{risks.length > 1 ? ` ${risks.length - 1} more at risk.` : ''}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {lib.ahead.map((a) => (
              <div class="alert" style="box-shadow:4px 4px 0 var(--ink)">
                <span class="k" style="color:var(--ink)">COMING UP: {a.title.toUpperCase()}</span>
                <span>Needed about {fmtDay(a.date) === fmtDay(addDays(today, 1)) ? 'tomorrow' : fmtDate(a.date)}. It will be planned around when you're home.</span>
              </div>
            ))}
            {syncStatus().state === 'error' && /token|allowed|not found/i.test(syncStatus().error || '') && (
              <button type="button" class="alert" onClick={() => go({ view: 'settings' })}>
                <span class="k">SYNC ISN'T WORKING</span>
                <span>{syncStatus().error} Your changes are saved on this device but aren't reaching your other one. Tap to fix it in Settings.</span>
              </button>
            )}
            {!s.skills.length && (
              <button type="button" class="alert" style="box-shadow:4px 4px 0 var(--ink)" onClick={() => go({ view: 'settings' })}>
                <span class="k" style="color:var(--ink)">NOTHING ON THE SHELF YET</span>
                <span>Your goals load from your private data. Open Settings and connect Sync.</span>
              </button>
            )}
            <div class="stacks">
              {lib.cols.map((c) => (
                <button type="button" class={`stack ${c.key === 'week' ? 'span2' : ''}`} style={`background:${c.bg};color:${c.fg}`} onClick={() => go({ view: 'col', c: c.key, i: '', ch: 0, p: '' })}>
                  <span class="t">{c.title}</span><span class="s">{c.sub}</span>
                </button>
              ))}
            </div>
            <div class="minis">
              <button type="button" onClick={() => go({ view: 'achievements' })}>ACHIEVEMENTS</button>
              <button type="button" onClick={() => go({ view: 'debrief' })}>DEBRIEF</button>
              <button type="button" onClick={() => go({ view: 'settings' })}>SETTINGS</button>
            </div>
          </div>
        )}

        {view === 'col' && (
          <div class="view" style={style()}>
            <div class="colhead" style={`background:${col.bg};color:${col.fg}`}><h1>{col.title}</h1><span style="font-size:14px">{col.sub}</span></div>
            <div class="covers">
              {col.issues.map((it, ii) => (
                <button type="button" class="cover" style={`background:${col.bg};color:${col.fg};animation-delay:${ii * 70}ms`} onClick={() => go({ view: 'toc', i: it.key, ch: 0, p: '' })}>
                  <span class="top"><span>No. {ii + 1}</span>{it.badge && <span class={`badge ${it.badge === 'AT RISK' ? 'risk' : ''}`}>{it.badge}</span>}</span>
                  <span class="t" style={it.title.split(/[ :]/).some((w) => w.length > 10) ? 'font-size:18px' : ''}>{it.title}</span>
                  <span class="s">{it.sub}</span>
                </button>
              ))}
              {col.key !== 'week' && (
                <button type="button" class="cover" style="background:#fff;border-style:dashed;box-shadow:none;align-items:center;justify-content:center" onClick={() => setLocal({ sheet: 'add', sheetArg: `objective:${col.key}` })}>
                  <span class="d" style="font-size:22px">+ NEW OBJECTIVE</span>
                </button>
              )}
            </div>
          </div>
        )}

        {view === 'toc' && issue && col.key === 'week' && (
          <div class="book" style={style(460)}>
            <div class="head">
              <span class="k">{col.title} · No. {col.issues.indexOf(issue) + 1}</span>
              <h1>{issue.title}</h1>
              <span class="soft" style="font-size:14px">{issue.sub}</span>
            </div>
            <ol class="tl">
              {issue.chapters.flatMap((ch, ci) => ch.panels.map((p) => ({ p, ci }))).map(({ p, ci }) => (
                <li class={`${p.now ? 'is-now' : ''} ${p.done ? 'is-done' : ''} ${p.past && !p.done && !p.now ? 'is-past' : ''}`}>
                  <span class="tl-time">{p.time || p.h}</span>
                  <button type="button" class={`tl-card ${p.fixed ? 'fixed' : ''}`} style={p.color && !p.done && !p.now ? `border-left:10px solid ${p.color}` : ''} onClick={() => go({ view: 'panel', ch: ci, p: p.key })}>
                    {p.kick && <span class="tl-kick">{p.kick}</span>}
                    <span class="tl-t">{p.t}</span>
                    {p.m && <span class="tl-m">{p.m}</span>}
                    {(p.done || p.now || p.running) && <span class="tag" style={`color:${p.done ? '#1B7A44' : '#B3231A'};border-color:${p.done ? '#1B7A44' : '#B3231A'}`}>{p.done ? 'DONE' : p.running ? 'GOING' : 'NOW!'}</span>}
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}

        {view === 'toc' && issue && col.key !== 'week' && (
          <div class="book" style={style(460)}>
            <div class="head">
              <span class="k">{col.title} · No. {col.issues.indexOf(issue) + 1}</span>
              <h1>{issue.title}</h1>
              <span class="soft" style="font-size:14px">{issue.sub}</span>
            </div>
            <span class="contents">CONTENTS</span>
            <div style="display:flex;flex-direction:column">
              {issue.chapters.map((ch, ci) => (
                <button type="button" class="chapter" onClick={() => go({ view: 'page', ch: ci, p: '' })}>
                  <span class="t">{ch.title}</span><span class="dots" aria-hidden="true" />
                  <span class="soft" style="font-size:13px">{ch.panels.length} {ch.panels.length === 1 ? 'panel' : 'panels'}</span>
                  <span class="n">{ci + 1}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {view === 'page' && issue && chapter && (
          <div class="book page" style={style(460)}>
            <div class="pagehead">
              <h1>{chapter.title}</h1>
              <span class="soft" style="font-size:13px;text-align:right">{issue.title} · page {issue.chapters.indexOf(chapter) + 1}</span>
            </div>
            <div class="panels">
              {(() => {
                const narrow = chapter.panels.filter((p) => !p.wide);
                const lastNarrow = narrow.length % 2 === 1 ? narrow[narrow.length - 1] : null;
                return chapter.panels.map((p) => <Cell p={p === lastNarrow ? { ...p, wide: true } : p} onOpen={() => go({ view: 'panel', p: p.key })} />);
              })()}
              {col.key !== 'week' && chapter.title !== 'WHERE IT STANDS' && chapter.title !== 'WHAT THE APP LEARNED' && (
                <button type="button" class="cell span2 dashed" style="min-height:60px" onClick={() => setLocal({ sheet: 'mission', sheetArg: `new:${issue.key}` })}><span class="d" style="font-size:20px">+ ADD MISSION</span></button>
              )}
            </div>
            <div class="row" style="justify-content:space-between">
              <button type="button" class="plain" disabled={nav.ch <= 0} style={nav.ch <= 0 ? 'visibility:hidden' : ''} onClick={() => go({ ch: nav.ch - 1, dir: 'out' })}>‹ Previous page</button>
              <button type="button" class="plain" style={nav.ch >= issue.chapters.length - 1 ? 'visibility:hidden' : ''} onClick={() => go({ ch: nav.ch + 1 })}>Next page ›</button>
            </div>
          </div>
        )}

        {view === 'panel' && panel && <Panel key={panel.key} p={panel} lib={lib} anim={anim} />}
        {view === 'debrief' && <div class="view" style={style()}><Debrief lib={lib} /></div>}
        {view === 'settings' && <div class="view" style={style()}><Settings /></div>}
        {view === 'achievements' && <div class="view" style={style()}><Achievements /></div>}
      </div>

      <div class="bottombar">
        <button type="button" onClick={() => actions.flare()}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="#D92B21" stroke="#14110F" stroke-width="2" stroke-linejoin="round"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z" /></svg>
          <span>{s.settings.flareLabel}</span>
        </button>
        <button type="button" onClick={() => setLocal({ sheet: 'doing' })}>
          <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#14110F" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></svg>
          <span>Doing now</span>
        </button>
        <button type="button" class="add" aria-label="Add a shift, workout, event or Objective" onClick={() => setLocal({ sheet: 'add', sheetArg: undefined })}>
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
        </button>
      </div>
      <Sheets />
      {l.toast && <div class="toast" role="status" key={l.toast.id}>{l.toast.text}</div>}
    </div>
  );
}
