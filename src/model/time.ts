const p2 = (n: number) => String(n).padStart(2, '0');
let offset = 0;
export function setNowOverride(iso: string | null) { offset = iso ? new Date(iso).getTime() - Date.now() : 0; }
export const nowTs = () => Date.now() + offset;
export const dstr = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
export const parseD = (s: string) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d, 12); };
export const dateOf = (ts: number) => dstr(new Date(ts));
export const addDays = (s: string, n: number) => { const d = parseD(s); d.setDate(d.getDate() + n); return dstr(d); };
export const diffDays = (a: string, b: string) => Math.round((parseD(b).getTime() - parseD(a).getTime()) / 86400000);
export const weekday = (s: string) => parseD(s).getDay();
export const minsOf = (ts: number) => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
export const weekStart = (s: string) => addDays(s, -((weekday(s) + 6) % 7)); // Monday
export const fmtT = (min: number) => { const m = ((Math.round(min) % 1440) + 1440) % 1440; const h = Math.floor(m / 60); return `${((h + 11) % 12) + 1}:${p2(m % 60)}`; };
export const fmtTp = (min: number) => `${fmtT(min)}${(((Math.round(min) % 1440) + 1440) % 1440) < 720 ? 'am' : 'pm'}`;
const WD = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const WDL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDay = (s: string) => { const d = parseD(s); return `${WD[d.getDay()]} ${MO[d.getMonth()].toUpperCase()} ${d.getDate()}`; };
export const fmtDate = (s: string) => { const d = parseD(s); return `${MO[d.getMonth()]} ${d.getDate()}`; };
export const fmtLong = (s: string) => { const d = parseD(s); return `${WDL[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}`; };
export const fmtDur = (min: number) => { const m = Math.round(min); if (m < 60) return `${m} min`; const h = Math.floor(m / 60), r = m % 60; return r ? `${h} h ${r} min` : `${h} h`; };
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
