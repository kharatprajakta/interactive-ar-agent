// Shared documents (RAG): PDFs are turned into text in the browser with pdf.js,
// then embedded and stored by the server for this browser session.
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/';
let pdfjsPromise = null;

function pdfjs() {
  pdfjsPromise ??= import(`${PDFJS}pdf.min.mjs`).then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}pdf.worker.min.mjs`;
    return lib;
  });
  return pdfjsPromise;
}

export function sessionId() {
  let id = null;
  try {
    id = localStorage.getItem('session-id');
    if (!id) localStorage.setItem('session-id', (id = crypto.randomUUID()));
  } catch {
    id = window.__sessionId ??= crypto.randomUUID();
  }
  return id;
}

async function extractPdfText(file, onProgress) {
  const lib = await pdfjs();
  const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => it.str + (it.hasEOL ? '\n' : ' ')).join(''));
    onProgress?.(i, pdf.numPages);
  }
  return pages.join('\n\n');
}

async function post(body) {
  const res = await fetch('/api/docs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session: sessionId(), ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Upload failed (${res.status})`);
  return data.doc;
}

/** Upload a PDF / text / markdown file. onProgress(message) for status text. */
export async function uploadFile(file, onProgress) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  let text;
  if (isPdf) {
    onProgress?.(`Reading ${file.name}…`);
    text = await extractPdfText(file, (i, n) => onProgress?.(`Reading ${file.name} (page ${i}/${n})…`));
    if (text.replace(/\s/g, '').length < 50) throw new Error("That PDF has no selectable text (it may be scanned images).");
  } else {
    text = await file.text();
  }
  onProgress?.(`Indexing ${file.name}…`);
  return post({ title: file.name.replace(/\.[^.]+$/, ''), text, type: isPdf ? 'pdf' : 'text' });
}

export function addLink(url) {
  return post({ url });
}

export async function listDocs() {
  const res = await fetch(`/api/docs?session=${encodeURIComponent(sessionId())}`);
  return res.ok ? (await res.json()).docs : [];
}

export async function removeDoc(id) {
  await fetch(`/api/docs?session=${encodeURIComponent(sessionId())}&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
}
