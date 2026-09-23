// Web access for the agents: keyless DuckDuckGo search and safe page fetching.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const MAX_PAGE_BYTES = 3_000_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** Turn an HTML page into readable plain text (title + main content). */
export function htmlToText(html) {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
  let body = html.replace(/<!--[\s\S]*?-->/g, ' ');
  body = body.replace(/<(script|style|noscript|svg|nav|footer|header|form|aside|iframe|button|select)\b[\s\S]*?<\/\1>/gi, ' ');
  // Prefer the main content region when the page marks one.
  const main = /<(article|main)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(body);
  if (main && main[2].length > 500) body = main[2];
  const text = decodeEntities(
    body
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre|dd|dt)>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}

// ---------------------------------------------------------------------------
// SSRF guard: never let a shared link make the server reach private networks.
// ---------------------------------------------------------------------------
function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::' || v6 === '::1' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80');
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That does not look like a valid link.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only http and https links are supported.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))) {
    throw new Error('Links to private or local network addresses are not allowed.');
  }
  return url;
}

/** Fetch a public web page and return { url, title, text }. Follows up to 3 redirects safely. */
export async function fetchPage(rawUrl, { timeoutMs = 8000 } = {}) {
  let url = await assertPublicUrl(rawUrl);
  let res;
  for (let hop = 0; ; hop++) {
    res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location') && hop < 3) {
      url = await assertPublicUrl(new URL(res.headers.get('location'), url).href);
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);

  const type = res.headers.get('content-type') || '';
  if (type.includes('pdf')) throw new Error('That link is a PDF. Download it and upload the file instead.');
  if (!/text\/|html|xml|json/.test(type)) throw new Error(`Can't read that kind of content (${type || 'unknown'}).`);

  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < MAX_PAGE_BYTES) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  reader.cancel().catch(() => {});
  const raw = Buffer.concat(chunks).toString('utf8');

  if (type.includes('html') || /^\s*</.test(raw)) {
    const { title, text } = htmlToText(raw);
    return { url: url.href, title: title || url.hostname, text };
  }
  return { url: url.href, title: url.pathname.split('/').pop() || url.hostname, text: raw };
}

/** Keyless web search via DuckDuckGo's HTML endpoint. Returns [{ title, url, snippet }]. */
export async function webSearch(query, { limit = 6 } = {}) {
  const res = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Search failed (HTTP ${res.status})`);
  const html = await res.text();

  const results = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const link = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    let href = decodeEntities(link[1]);
    const redirect = /[?&]uddg=([^&]+)/.exec(href); // DuckDuckGo sometimes wraps links
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith('//')) href = 'https:' + href;
    if (!/^https?:/.test(href) || /duckduckgo\.com\/y\.js/.test(href)) continue;
    const snippet = /class="result__snippet"[^>]*>([\s\S]*?)<\/(a|div)>/.exec(block);
    results.push({ title: stripTags(link[2]), url: href, snippet: snippet ? stripTags(snippet[1]) : '' });
    if (results.length >= limit) break;
  }
  return results;
}

export function extractUrls(text) {
  return [...new Set(text.match(/https?:\/\/[^\s<>"')\]]+/gi) || [])].map((u) => u.replace(/[.,;:!?]+$/, ''));
}
