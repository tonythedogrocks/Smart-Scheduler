import { useEffect, useState } from 'preact/hooks';
import { S, actions, toast } from '../model/store';
import { dateOf, fmtT, nowTs } from '../model/time';
import { fromHM, toHM } from './bits';
import { getCfg, onSyncStatus, setCfg, syncNow, syncStatus } from '../model/sync';
import { sendFiles, type Sent } from '../model/inbox';

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
          <label class="field">New token (if you made a new one)<input type="password" value={token} onInput={(e) => setToken((e.target as HTMLInputElement).value)} placeholder="github_pat_..." autocomplete="off" /></label>
          {token.length >= 20 && <button type="button" class="small on" style="align-self:flex-start" onClick={() => { setCfg({ repo: cfg.repo, token }); setToken(''); syncNow(); }}>Save new token</button>}
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

