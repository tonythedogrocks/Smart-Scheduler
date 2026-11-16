import { useState } from 'preact/hooks';
import { S, actions, setLocal } from '../model/store';
import { LEVELS } from '../model/seed';
import { dateOf, fmtLong, nowTs } from '../model/time';
import { floorText, requestText } from '../model/vm';
import { forecast } from '../model/planner';
import { isSabbath } from '../model/schedule';
import { Arrow } from './bits';
import type { Level } from '../model/types';

export function StatusReport() {
  const today = dateOf(nowTs());
  const cur = S().days[today]?.level;
  const [picked, setPicked] = useState<number>(cur || 3);
  const sab = isSabbath(S(), today);
  const sel = LEVELS.find((l) => l.n === picked)!;
  // what today needs, worked out as if he hadn't picked yet
  const [req] = useState(() => { const st = S(); const probe = { ...st, days: { ...st.days, [today]: { ...(st.days[today] || {}), level: undefined } }, updatedAt: -Math.random() }; return forecast(probe as typeof st, nowTs()).requests.find((r) => r.date === today); });
  return (
    <div class="app status">
      <div style="display:flex;flex-direction:column;gap:10px;align-items:flex-start">
        <div class="row" style="gap:10px">
          <span class="caption">{sab ? S().settings.restDayName.toUpperCase() : 'STATUS REPORT'}</span>
          <span class="soft" style="font-size:14px">{fmtLong(today)}</span>
          {cur && <button class="plain" onClick={() => setLocal({ status: false })}>Close</button>}
        </div>
        <h1>SET TODAY'S LEVEL!</h1>
        {req && <span class="caption" style="font-size:16px;transform:rotate(-1deg);background:var(--red);color:#fff">{requestText(req.level)}</span>}
      </div>
      <div class="levels" role="radiogroup" aria-label="Energy level">
        {LEVELS.map((l) => (
          <button type="button" class="level" role="radio" aria-checked={l.n === picked ? 'true' : 'false'} onClick={() => setPicked(l.n)}>
            <span class="n">{l.n}</span>
            <span style="display:flex;flex-direction:column;gap:1px">
              <span class="nm">{l.name}</span>
              <span class="soft" style="font-size:14px">{sab && l.n === 1 ? 'Max Sabbath' : l.means}</span>
            </span>
          </button>
        ))}
      </div>
      <div class="floor">
        <span class="d" style="font-size:18px">TODAY'S FLOOR AT {sel.name}</span>
        <span style="font-size:15px;line-height:1.35">{floorText(S(), today, picked)}</span>
        <span class="soft" style="font-size:14px;line-height:1.35">{sab ? 'Hit the floor and the day is complete.' : "Hit the floor and it's a full mission success."}</span>
      </div>
      <button type="button" class="big report" onClick={() => actions.setLevel(picked as Level)}>
        <span>REPORT IN!</span><Arrow />
      </button>
    </div>
  );
}
