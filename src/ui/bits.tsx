import { useEffect, useState } from 'preact/hooks';
import { subscribe } from '../model/store';

export function useStore() {
  const [, set] = useState(0);
  useEffect(() => subscribe(() => set((n) => n + 1)), []);
}
/** Re-render on a clock tick and whenever the app comes back to the foreground. */
export function useTick(ms: number) {
  const [, set] = useState(0);
  useEffect(() => {
    const bump = () => set((n) => n + 1);
    const t = setInterval(bump, ms);
    document.addEventListener('visibilitychange', bump);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', bump); };
  }, [ms]);
}
export const Arrow = ({ size = 24 }: { size?: number }) => (
  <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
);
export const toHM = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
export const fromHM = (v: string) => { const [h, m] = v.split(':').map(Number); return (h || 0) * 60 + (m || 0); };
