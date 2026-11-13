import { render } from 'preact';
import '@fontsource/bangers/400.css';
import '@fontsource/comic-neue/400.css';
import '@fontsource/comic-neue/700.css';
import './styles.css';
import { App } from './ui/App';
import { load } from './model/store';
import { setNowOverride } from './model/time';
import { startSync } from './model/sync';

const q = new URLSearchParams(location.search);
if (q.get('now')) setNowOverride(q.get('now'));
load().then(() => { render(<App />, document.getElementById('app')!); startSync(); });
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('./sw.js').catch(() => {});

// A device that wakes with an old version still loaded (e.g. a laptop opened after sleep) reloads to the new one
// before acting on anything.
if (import.meta.env.PROD) {
  const mine = () => [...document.querySelectorAll('script[type=module][src]')].map((e) => (e as HTMLScriptElement).src.split('/').pop()).join();
  const check = () => fetch('./', { cache: 'no-store' }).then((r) => r.text()).then((html) => {
    const live = [...html.matchAll(/<script[^>]*type="module"[^>]*src="([^"]+)"/g)].map((m) => m[1].split('/').pop()).join();
    if (live && live !== mine()) location.reload();
  }).catch(() => {});
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  setInterval(() => { if (document.visibilityState === 'visible') check(); }, 600000);
}
