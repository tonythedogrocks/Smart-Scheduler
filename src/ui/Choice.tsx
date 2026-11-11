import { S, actions } from '../model/store';
import { fmtT } from '../model/time';

/** Pick this week's start time for an event that has a few options. */
export function Choice({ evtId, date, label }: { evtId: string; date: string; label?: string }) {
  const s = S(), e = s.events.find((x) => x.id === evtId);
  if (!e?.choices) return null;
  const day = s.days[date] || {};
  const cur = day.starts?.[e.id] ?? e.start, len = e.end - e.start;
  return (
    <div class="row">
      {label && <span style="font-size:14px">{label}</span>}
      {e.choices.map((st) => (
        <button type="button" class={`small ${cur === st ? 'on' : ''}`} onClick={() => actions.setDay(date, { starts: { ...(day.starts || {}), [e.id]: st } })}>{fmtT(st)} to {fmtT(st + len)}</button>
      ))}
    </div>
  );
}
