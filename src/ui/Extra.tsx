import { S, actions, setLocal, toast } from '../model/store';
import { achievements, heroLevel, xpOf } from '../model/game';
import { Choice } from './Choice';
import type { Library } from '../model/vm';
import { addDays, dateOf, fmtDate, fmtDay, fmtDur, fmtT, nowTs, weekStart } from '../model/time';
import { afterStats, choreDue, choreInterval, choreLast, contextStats, crashAfter5, exerciseCeiling, factor, flareStats, followThrough, learnedCapacity } from '../model/learn';
import { eventsOn } from '../model/schedule';
import { levelName, nice } from '../model/seed';
import { fromHM, toHM } from './bits';
import type { Level } from '../model/types';
import { useEffect, useState } from 'preact/hooks';
import { getCfg, onSyncStatus, setCfg, syncNow, syncStatus } from '../model/sync';
import { sendFiles, type Sent } from '../model/inbox';

export function Achievements() {
  const s = S();
  return (
    <>
      <div class="colhead" style="background:#FFD426"><h1>ACHIEVEMENTS</h1><span style="font-size:14px">Real milestones. Nothing earned is ever lost.</span></div>
      <div class="ach">
        {achievements(s).map((a) => {
          const got = s.achievements[a.id];
          return (
            <button type="button" class={got ? 'got' : ''} disabled={!!got || !a.manual} onClick={() => { if (a.manual && confirm(`Mark "${a.sub}" as achieved?`)) actions.claim(a.id); }}>
              <span class="t">{a.title}</span><span>{a.sub}</span>
              <span style="margin-top:auto">{got ? fmtDate(got) : a.manual ? 'Tap when it happens' : 'Not yet'}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

export function Debrief({ lib }: { lib: Library }) {
  const s = S(), today = dateOf(nowTs()), ws = weekStart(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i));
  const logs = s.logs.filter((l) => l.date >= ws && l.date <= days[6]);
  const bySkill = s.skills.map((k) => {
    const ids = new Set(s.missions.filter((m) => s.objectives.find((o) => o.id === m.objectiveId)?.skillId === k.id).map((m) => m.id));
    return { k, min: logs.filter((l) => ids.has(l.missionId)).reduce((a, l) => a + (l.end - l.start) / 60000, 0) };
  });
  const floors = days.filter((d) => s.days[d]?.floorAwarded).length;
  const lc = learnedCapacity(s, today), crash = crashAfter5(s, today), ft = followThrough(s), ctx = contextStats(s), fl = flareStats(s);
  const learned: string[] = [];
  for (const m of s.missions) { const f = factor(s, m.id); if (Math.abs(f - 1) >= 0.1) learned.push(`${m.title} really takes about ${Math.round(m.minutes * f)} min (estimate was ${m.minutes}). Plans now use that.`); }
  for (const n of [1, 2, 3, 4, 5] as Level[]) if (lc[n] && lc[n]!.n >= 3) learned.push(`A ${nice(levelName(n))} day really gets about ${fmtDur(lc[n]!.mean)} of focused work done.`);
  if (crash.confident) learned.push(`The day after Plus Ultra averages level ${crash.after.toFixed(1)}. Those days are now planned light.`);
  if (ft.n >= 10) learned.push(`${Math.round(ft.rate * 100)}% of started work gets finished in one go.`);
  for (const c of ctx) if (c.rate <= 0.6 || c.rate >= 0.9) learned.push(`${c.energy[0].toUpperCase() + c.energy.slice(1)} work in the ${c.part.toLowerCase()} gets finished ${Math.round(c.rate * 100)}% of the time.${c.n >= 8 ? ' Plans now lean toward your better times.' : ''}`);
  const plannable = new Set(['shift', 'workout', 'event', 'physical', 'mental', 'social']);
  for (const a of afterStats(s)) learned.push(`${a.energy[0].toUpperCase() + a.energy.slice(1)} work right after ${a.after === 'event' ? 'an event' : a.after === 'workout' ? 'a workout' : a.after === 'shift' ? 'a shift' : a.after === 'physical' || a.after === 'mental' || a.after === 'social' ? a.after + ' work' : a.after} gets finished ${Math.round(a.rate * 100)}% of the time, against ${Math.round(a.usual * 100)}% usually.${a.worse && plannable.has(a.after) ? ' Plans now leave a gap after it.' : ''}`);
  const ex = exerciseCeiling(s, today);
  if (ex.growing && Object.keys(s.days).length > 7) learned.push(`Exercise ceiling is up to ${ex.cap} min a week.`);
  for (const b of fl.before) learned.push(`${b.t} came before ${b.c} of ${fl.n} ${s.settings.flareLabel.toLowerCase()}s.`);
  if (lib.fc.eased) learned.push(`${s.settings.flareLabel}s are up, so workouts are eased for now. Daily basics stay.`);
  const nws = addDays(ws, 7);
  const next = Array.from({ length: 7 }, (_, i) => addDays(nws, i)).flatMap((d) => eventsOn(s, d).map((e) => ({ d, e })));
  const hero = heroLevel(xpOf(s));
  return (
    <>
      <div class="colhead" style="background:#1E5BD8;color:#fff"><h1>DEBRIEF</h1><span style="font-size:14px">Week of {fmtDate(ws)} · progress, what the app learned, next week</span></div>
      <div class="card narrow">
        <h2>THIS WEEK</h2>
        <div class="days7">{days.map((d) => <span><span>{fmtDay(d).slice(0, 3)}</span><b>{s.days[d]?.level ?? '·'}</b></span>)}</div>
        <p>{floors} {floors === 1 ? 'day' : 'days'} at the floor · Level {hero.level} · {xpOf(s)} XP · {Math.round(ex.done)} of {ex.cap} min of exercise</p>
        <ul>{bySkill.filter((x) => x.min >= 1).map((x) => <li>{nice(x.k.title)}: {fmtDur(x.min)}</li>)}</ul>
        {!logs.length && <p class="soft">Nothing logged yet this week.</p>}
      </div>
      <div class="card narrow">
        <h2>PROGRESS</h2>
        <ul>
          {s.objectives.filter((o) => !o.done && lib.fc.landing[o.id] !== undefined).map((o) => {
            const risk = lib.fc.risks.find((r) => r.objectiveId === o.id), land = lib.fc.landing[o.id];
            return <li style={risk ? 'color:#B3231A' : ''}>{nice(o.title)}: {land ? `lands about ${fmtDate(land)}` : 'not landing yet'}{o.due ? ` · due ${fmtDate(o.due)}` : ''}{risk ? ' · at risk' : ''}</li>;
          })}
        </ul>
      </div>
      <div class="card narrow">
        <h2>WHAT THE APP LEARNED</h2>
        {learned.length ? <ul>{learned.map((t) => <li>{t}</li>)}</ul> : <p class="soft">Nothing yet. It only speaks up once it is confident in a pattern.</p>}
      </div>
      <div class="card narrow">
        <h2>NEXT WEEK</h2>
        {next.length ? <ul>{next.map(({ d, e }) => <li>{fmtDay(d)} · {e.title} {fmtT(e.start)} to {fmtT(e.end)}</li>)}</ul> : <p class="soft">Nothing on the schedule yet.</p>}
        <div class="row">
          <button type="button" class="small on" onClick={() => setLocal({ sheet: 'add', sheetArg: undefined })}>Enter shifts</button>
        </div>
        {next.filter(({ e }) => e.choices).map(({ d, e }) => <Choice evtId={e.id} date={d} label={`${e.title}, ${fmtDay(d)}:`} />)}
      </div>
    </>
  );
}

export function Settings() {
  const st = S().settings;
  const T = ({ label, k }: { label: string; k: 'wake' | 'lunchAt' | 'dinnerAt' | 'bedPrep' }) => (
    <label class="field">{label}<input type="time" value={toHM(st[k])} onChange={(e) => actions.setSettings({ [k]: fromHM((e.target as HTMLInputElement).value) })} /></label>
  );
  const N = ({ label, k }: { label: string; k: 'offDutyMin' | 'mealGap' | 'lunchMin' | 'dinnerMin' | 'dishesMin' | 'breakMin' }) => (
    <label class="field">{label}<input inputMode="numeric" value={String(st[k])} onChange={(e) => actions.setSettings({ [k]: Math.max(0, +(e.target as HTMLInputElement).value || 0) })} /></label>
  );
  const exportIt = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(S())], { type: 'application/json' }));
    a.download = `limit-break-backup-${dateOf(nowTs())}.json`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importIt = (e: Event) => {
    const f = (e.target as HTMLInputElement).files?.[0]; if (!f) return;
    f.text().then((t) => { try { actions.importState(t); toast('Backup loaded'); } catch { toast('That file is not a Limit Break backup'); } });
  };
  return (
    <>
      <div class="colhead" style="background:#fff"><h1>SETTINGS</h1><span style="font-size:14px">Fixed schedule and rules</span></div>
      <div class="card narrow">
        <h2>THE DAY</h2>
        <div class="row"><T label="Awake" k="wake" /><T label="Start getting ready for bed" k="bedPrep" /></div>
        <div class="row"><T label="Lunch" k="lunchAt" /><T label="Dinner (usual)" k="dinnerAt" /></div>
        <div class="row"><N label="Off Duty before bed (min)" k="offDutyMin" /><N label="Wait after a meal before a workout (min)" k="mealGap" /></div>
        <div class="row"><N label="Lunch (min)" k="lunchMin" /><N label="Dinner (min)" k="dinnerMin" /><N label="Dishes (min)" k="dishesMin" /></div>
        {S().events.filter((e) => e.choices).map((e) => (
          <div class="row">
            <span style="font-size:14px">{e.title}, usually:</span>
            {e.choices!.map((c) => <button type="button" class={`small ${e.start === c ? 'on' : ''}`} onClick={() => actions.updateEvent(e.id, { start: c })}>{fmtT(c)} to {fmtT(c + e.end - e.start)}</button>)}
          </div>
        ))}
      </div>
      <Chores />
      <div class="card narrow">
        <h2>PLANNING</h2>
        <p>Deadlines are planned against a modest day, so good days build a buffer and bad days spend it.</p>
        <div class="row">
          <span style="font-size:14px">Plan against level:</span>
          {[2, 2.5, 3].map((b) => <button type="button" class={`small ${st.baseline === b ? 'on' : ''}`} onClick={() => actions.setSettings({ baseline: b })}>{b}</button>)}
        </div>
        <p class="soft" style="font-size:14px">Starting guess for focused work per level, until the app has learned the real numbers:</p>
        <div class="row">
          {([2, 3, 4, 5] as Level[]).map((n) => (
            <label class="field" style="min-width:70px">Level {n} (min)<input inputMode="numeric" value={String(st.capacity[n])} onChange={(e) => actions.setSettings({ capacity: { ...st.capacity, [n]: Math.max(0, +(e.target as HTMLInputElement).value || 0) } })} /></label>
          ))}
        </div>
        {st.restDay !== null && <p class="soft" style="font-size:14px">{st.restDayName} essentials are chosen per mission: open a mission and tap "Edit this mission".</p>}
      </div>
      <SyncCard />
      <SendFiles />
      <div class="card narrow">
        <h2>BACKUP</h2>
        <p>A backup file is a full copy of everything, for safekeeping.</p>
        <div class="row">
          <button type="button" class="small on" onClick={exportIt}>Save a backup</button>
          <label class="small" style="display:inline-flex;align-items:center;cursor:pointer">Load a backup<input type="file" accept="application/json,.json" style="display:none" onChange={importIt} /></label>
          <button type="button" class="small" onClick={() => { if (confirm('Erase everything on this device and start over?')) actions.reset(); }}>Start over</button>
        </div>
      </div>
    </>
  );
}

function SyncCard() {
  const [, bump] = useState(0);
  useEffect(() => onSyncStatus(() => bump((n) => n + 1)), []);
  const cfg = getCfg(), st = syncStatus();
  const [repo, setRepo] = useState(cfg?.repo || '');
  const [token, setToken] = useState('');
  const t = st.at ? new Date(st.at) : null;
  return (
    <div class="card narrow">
      <h2>SYNC</h2>
      {cfg ? (
        <>
          <p>Syncing with <b>{cfg.repo}</b>. {st.state === 'syncing' ? 'Syncing now...' : st.state === 'error' ? '' : t ? `Last synced ${fmtT(t.getHours() * 60 + t.getMinutes())}.` : ''}</p>
          {st.state === 'error' && <div class="warn" role="alert">{st.error}</div>}
          <div class="row">
            <button type="button" class="small on" onClick={() => syncNow()}>Sync now</button>
            <button type="button" class="small" onClick={() => { if (confirm('Stop syncing on this device? Your data stays here and in the repo.')) { setCfg(null); setToken(''); } }}>Disconnect</button>
          </div>
        </>
      ) : (
        <>
          <p>Keeps the MacBook and iPhone in step through a private GitHub repo of yours. Set it up once on each device.</p>
          <label class="field">Repo (owner/name)<input value={repo} onInput={(e) => setRepo((e.target as HTMLInputElement).value)} placeholder="yourname/limit-break-data" autocapitalize="off" autocorrect="off" spellcheck={false} /></label>
          <label class="field">Access token for that repo<input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="github_pat_..." autocomplete="off" /></label>
          <p class="soft" style="font-size:14px">The token is kept on this device only and is sent nowhere but GitHub.</p>
          <button type="button" class="small on" style="align-self:flex-start" disabled={!repo.includes('/') || token.length < 20} onClick={() => { setCfg({ repo, token }); setToken(''); syncNow(); }}>Connect</button>
        </>
      )}
    </div>
  );
}

function Chores() {
  const s = S(), list = s.missions.filter((m) => m.kind === 'chore' && !m.archived);
  if (!list.length) return null;
  return (
    <div class="card narrow">
      <h2>CHORES</h2>
      {list.map((m) => {
        const iv = choreInterval(s, m), last = choreLast(s, m), due = choreDue(s, m);
        return (
          <div style="display:flex;flex-direction:column;gap:6px">
            <p><b>{m.title}</b> · about every {iv.days} days{iv.learned ? ' (learned)' : ''} · {last ? `last done ${fmtDate(last)}, next about ${fmtDate(due!)}` : 'not done in the app yet'}</p>
            <div class="row">
              <button type="button" class="small on" disabled={!!s.running} onClick={() => { actions.start(m.id, 1, m.steps?.[0]?.min || m.minutes, 0); toast(`${m.steps?.[0]?.title || m.title}: started`); }}>Starting it now</button>
              <button type="button" class="small" onClick={() => setLocal({ sheet: 'mission', sheetArg: m.id })}>Edit</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function SendFiles() {
  const [, bump] = useState(0);
  useEffect(() => onSyncStatus(() => bump((n) => n + 1)), []);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<Sent[]>([]);
  if (!getCfg()) return null;
  const go = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.some((f) => /\.pdf$/i.test(f.name))) { setMsg('No PDFs in what you picked.'); return; }
    setBusy(true); setSent([]);
    try { const got = await sendFiles(files, setMsg); setSent(got); setMsg(`Sent ${got.length} ${got.length === 1 ? 'file' : 'files'}. Tell Claude they're in.`); }
    catch (err: any) { setMsg(err?.message === 'Failed to fetch' ? 'Offline. Try again when you are connected.' : err?.message || 'Something went wrong.'); }
    finally { setBusy(false); }
  };
  return (
    <div class="card narrow">
      <h2>SEND FILES TO CLAUDE</h2>
      <p>Pick PDFs or a whole folder. This device pulls out just the text and sends it to your private data repo, where Claude can read it. The PDFs themselves stay here.</p>
      <div class="row">
        <label class="small on" style={`display:inline-flex;align-items:center;cursor:pointer;${busy ? 'opacity:.45;pointer-events:none' : ''}`}>Pick a folder<input type="file" {...{ webkitdirectory: true }} multiple style="display:none" onChange={go} /></label>
        <label class="small" style={`display:inline-flex;align-items:center;cursor:pointer;${busy ? 'opacity:.45;pointer-events:none' : ''}`}>Pick PDFs<input type="file" accept="application/pdf,.pdf" multiple style="display:none" onChange={go} /></label>
      </div>
      {msg && <p class="soft" role="status" style="font-size:14px">{msg}</p>}
      {sent.length > 0 && <ul>{sent.map((x) => <li>{x.name}: {x.pages} pages{x.blank ? `, ${x.blank} without text (scans)` : ''}</li>)}</ul>}
    </div>
  );
}
