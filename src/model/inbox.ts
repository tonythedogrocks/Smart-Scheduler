import { getCfg } from './sync';
import type { SyncCfg } from './sync';

/**
 * "Send files to Claude": reads PDFs on this device, keeps only their text, and
 * uploads it to the private data repo under inbox/. The PDFs themselves never leave
 * the device. Pages with no text layer (scans) are marked so they can be asked for later.
 */
export interface Sent { name: string; pages: number; blank: number; chars: number; path: string }

const b64 = (s: string) => { const b = new TextEncoder().encode(s); let o = ''; for (let i = 0; i < b.length; i += 0x8000) o += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(o); };
const safe = (p: string) => p.replace(/\.pdf$/i, '').replace(/[^\p{L}\p{N}._\- /]/gu, '_').replace(/\s+/g, ' ').trim();

async function pdfText(file: File, onPage: (n: number, of: number) => void) {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const out: string[] = [];
  let blank = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    let line = '';
    const lines: string[] = [];
    for (const it of tc.items as { str?: string; hasEOL?: boolean }[]) {
      if (typeof it.str !== 'string') continue;
      line += it.str;
      if (it.hasEOL) { lines.push(line); line = ''; }
    }
    if (line) lines.push(line);
    const text = lines.join('\n').trim();
    if (text.replace(/\s/g, '').length < 15) blank++;
    out.push(`=== page ${i} ===\n${text || '[no text on this page: likely a scan or picture]'}`);
    onPage(i, doc.numPages);
    page.cleanup();
  }
  await doc.destroy();
  return { text: out.join('\n\n'), pages: doc.numPages, blank };
}

async function put(cfg: SyncCfg, path: string, text: string) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const head = await fetch(url, { headers, cache: 'no-store' });
  const sha = head.ok ? (await head.json()).sha : undefined;
  const res = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ message: `Inbox: ${path}`, content: b64(text), sha }) });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'GitHub did not accept the sync token.' : `GitHub answered ${res.status}.`);
}

export async function sendFiles(files: File[], onStatus: (msg: string) => void): Promise<Sent[]> {
  const cfg = getCfg();
  if (!cfg) throw new Error('Connect Sync first.');
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.name));
  const done: Sent[] = [];
  for (const [k, f] of pdfs.entries()) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    const tag = `${k + 1} of ${pdfs.length}`;
    const { text, pages, blank } = await pdfText(f, (n, of) => { if (n === 1 || n % 10 === 0 || n === of) onStatus(`Reading ${tag}: ${f.name}, page ${n} of ${of}`); });
    const path = `inbox/${safe(rel)}.txt`;
    onStatus(`Sending ${tag}: ${f.name}`);
    await put(cfg, path, `Source: ${rel}\nPages: ${pages} (${blank} without text)\n\n${text}`);
    done.push({ name: rel, pages, blank, chars: text.length, path });
  }
  if (done.length) {
    const summary = [`Sent ${new Date().toISOString()}`, ...done.map((d) => `${d.path}\t${d.pages} pages\t${d.blank} without text`)].join('\n');
    await put(cfg, 'inbox/_index.txt', summary);
  }
  return done;
}
