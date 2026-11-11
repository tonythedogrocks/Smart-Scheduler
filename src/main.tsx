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
