// One conversational turn: gather context (shared links, documents, web
// search), then stream the persona's reply. Yields events:
//   { type: 'status', text }            progress shown on the call screen
//   { type: 'activity', kind }          'searching' | 'reading' (drives animations)
//   { type: 'doc', doc }                a link from the message was added as a document
//   { type: 'sources', items }          [{ title, url }] used for this answer
//   { type: 'text', text }              reply tokens
import { VOICE_RULES } from './personas.js';
import { webSearch, fetchPage, extractUrls } from './web.js';
import { addDocument, hasDocuments, searchDocuments, rankPassages, chunkText } from './rag.js';

const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
export const CHAT_MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:4b';
const MAX_HISTORY = 20;
const DOC_MIN_SCORE = 0.5;

function today() {
  return new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

async function ollamaChat(body, signal) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Keep the model loaded between turns so a call never hits a cold start, and
    // skip "thinking" (Qwen3.5 etc.): silent reasoning is dead air on a voice call.
    body: JSON.stringify({ model: CHAT_MODEL, keep_alive: '30m', think: false, ...body }),
    signal,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Ollama error ${res.status}: ${detail}${res.status === 404 ? ` Try: ollama pull ${CHAT_MODEL}` : ''}`);
  }
  return res;
}

// Small models call tools far too eagerly, so a separate, cheap, structured
// "router" call decides whether this turn needs the web.
const ROUTER_PROMPT = (persona) => `Today is ${today()}. You decide whether a voice assistant must search the internet before replying.
Search ONLY when the reply depends on information that changes over time or that a well-read person would not know offhand: news, current events, weather, prices, sports results, release dates, recent product details, schedules, specific local places or businesses, or when the user explicitly asks to look something up, search, google, or check online.
Do NOT search for: greetings, small talk, feelings, opinions, advice, recipes, explanations of general concepts, math, coding help, creative writing, or questions about the conversation or the user's shared documents.${
  persona.searchBias ? '\nThis assistant is a fact checker: also search whenever the user states or asks about a factual claim, statistic, quote, or news story.' : ''
}
If searching, write a concise search-engine query with all needed context from the conversation (resolve words like "it" or "there").

Examples:
"hi, how are you?" -> {"search": false, "query": ""}
"give me a recipe for masala chai" -> {"search": false, "query": ""}
"explain how photosynthesis works" -> {"search": false, "query": ""}
"help me budget 30000 rupees a month" -> {"search": false, "query": ""}
"what's the weather in Pune tomorrow?" -> {"search": true, "query": "Pune weather tomorrow"}
"who won yesterday's match?" -> {"search": true, "query": "cricket match result yesterday"}
"can you look up flights from Delhi to Goa?" -> {"search": true, "query": "Delhi to Goa flights"}`;

const ROUTER_SCHEMA = {
  type: 'object',
  properties: { search: { type: 'boolean' }, query: { type: 'string' } },
  required: ['search', 'query'],
};

async function decideSearch(persona, messages, signal) {
  const recent = messages.slice(-5, -1).map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 300)}`);
  const last = messages.at(-1).content;
  const res = await ollamaChat(
    {
      stream: false,
      format: ROUTER_SCHEMA,
      options: { temperature: 0 },
      messages: [
        { role: 'system', content: ROUTER_PROMPT(persona) },
        { role: 'user', content: `${recent.length ? `Conversation so far:\n${recent.join('\n')}\n\n` : ''}Latest user message: "${last}"` },
      ],
    },
    signal,
  );
  try {
    const { search, query } = JSON.parse((await res.json()).message.content);
    return search && query && query.toLowerCase() !== 'none' ? query.trim() : null;
  } catch {
    return null;
  }
}

async function webResearch(query) {
  const results = await webSearch(query);
  if (!results.length) return { passages: [], sources: [] };

  // Read the top pages and keep the passages most relevant to the query.
  const pages = await Promise.allSettled(results.slice(0, 3).map((r) => fetchPage(r.url, { timeoutMs: 5000 })));
  const candidates = [];
  pages.forEach((p, i) => {
    if (p.status !== 'fulfilled') return;
    for (const text of chunkText(p.value.text.slice(0, 15000)).slice(0, 15)) {
      candidates.push({ text, title: results[i].title, url: results[i].url });
    }
  });
  let best = [];
  try {
    best = await rankPassages(query, candidates, 4);
  } catch {
    // Embeddings unavailable: fall back to search snippets only.
  }

  const passages = [
    ...results.map((r) => ({ title: r.title, url: r.url, text: r.snippet })).filter((r) => r.text),
    ...best,
  ];
  const used = new Set(passages.map((p) => p.url));
  return { passages, sources: results.filter((r) => used.has(r.url)).map(({ title, url }) => ({ title, url })) };
}

// ---------------------------------------------------------------------------
// NCERT tutor: textbooks live in ChromaDB behind the Python service in ncert/.
// ---------------------------------------------------------------------------
const NCERT_URL = (process.env.NCERT_URL || 'http://127.0.0.1:5006').replace(/\/$/, '');

async function ncertCatalog() {
  try {
    const res = await fetch(`${NCERT_URL}/catalog`, { signal: AbortSignal.timeout(3000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function ncertSearch(params) {
  const res = await fetch(`${NCERT_URL}/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  return (await res.json()).results;
}

function describeCatalog(catalog, withChapters) {
  return Object.entries(catalog)
    .map(([cls, subjects]) =>
      `Class ${cls}: ` +
      Object.entries(subjects)
        .map(([subj, chs]) => (withChapters ? `${subj} (chapters: ${chs.map((c) => `${c.chapter}. ${c.title}`).join('; ')})` : subj))
        .join(withChapters ? '\n  ' : ', '),
    )
    .join('\n');
}

function studySchema(catalog) {
  const subjects = [...new Set(Object.values(catalog).flatMap((s) => Object.keys(s)))];
  return {
    type: 'object',
    properties: {
      class_num: { type: 'integer', minimum: 0, maximum: 12 },
      subject: { type: 'string', enum: ['', ...subjects] },
      chapter: { type: 'integer' },
      topic: { type: 'string' },
    },
    required: ['class_num', 'subject', 'chapter', 'topic'],
  };
}

const CLASS_WORDS = ['', 'one|first|1st', 'two|second|2nd', 'three|third|3rd', 'four|fourth|4th', 'five|fifth|5th', 'six|sixth|6th',
  'seven|seventh|7th', 'eight|eighth|8th', 'nine|ninth|9th', 'ten|tenth|10th', 'eleven|eleventh|11th', 'twelve|twelfth|12th'];

function studentSaidClass(messages, n) {
  const said = messages.filter((m) => m.role === 'user').map((m) => m.content.toLowerCase()).join(' ');
  return new RegExp(`\\b(${n}|${CLASS_WORDS[n] || n})\\b`).test(said);
}

/** Work out { class_num, subject, chapter, topic } from the whole conversation. */
async function extractStudyContext(messages, catalog, signal) {
  const transcript = messages
    .slice(-12)
    .map((m) => `${m.role === 'user' ? 'Student' : 'Tutor'}: ${m.content.slice(0, 400)}`)
    .join('\n');
  const res = await ollamaChat(
    {
      stream: false,
      format: studySchema(catalog),
      options: { temperature: 0 },
      messages: [
        {
          role: 'system',
          content: `Extract a student's NCERT study context from a tutoring conversation.
Indexed textbooks:
${describeCatalog(catalog, true)}

Return:
- class_num: the class (grade) number the student said they are in, or 0 if they have not said it. Never guess.
- subject: EXACTLY one of the indexed subject names for that class, matching what the student said (e.g. "bio" -> "biology"), or "" if not said or unclear.
- chapter: the chapter number if the student named a chapter, or asked about a topic that clearly belongs to one listed chapter; otherwise 0.
- topic: a short search phrase for what the student's LATEST message asks about, or "" if it is just a greeting or small talk.`,
        },
        { role: 'user', content: transcript },
      ],
    },
    signal,
  );
  try {
    return JSON.parse((await res.json()).message.content);
  } catch {
    return { class_num: 0, subject: '', chapter: 0, topic: '' };
  }
}

async function* ncertContext(messages, signal) {
  const catalog = await ncertCatalog();
  if (!catalog) {
    return { note: `The NCERT textbook service is not running, so you can't read the textbooks right now. Tell the student briefly and help from general knowledge, making clear it isn't from their textbook.` };
  }
  if (!Object.keys(catalog).length) {
    return { note: `No NCERT textbooks have been loaded yet. Tell the student the books still need to be added (by running "python -m ncert.ingest download" with a book code), and meanwhile help from general knowledge, making clear it isn't from their textbook.` };
  }

  const study = await extractStudyContext(messages, catalog, signal);
  if (process.env.DEBUG_CHAT) console.log('[ncert] study context:', study);
  // The class must come from the student, not a guess from the model.
  if (study.class_num && !studentSaidClass(messages, study.class_num)) study.class_num = 0;
  const subjects = catalog[String(study.class_num)];
  if (!study.class_num || !subjects) {
    return {
      note: `You don't know which class the student is in yet${study.class_num ? ` (Class ${study.class_num} isn't loaded)` : ''}. Available textbooks:\n${describeCatalog(catalog, false)}\nAsk which class they're in (and the subject if unknown) in one friendly sentence. Don't teach yet.`,
    };
  }
  if (!study.subject || !subjects[study.subject]) {
    return {
      note: `The student is in Class ${study.class_num}, but you don't know the subject yet. Class ${study.class_num} subjects available: ${Object.keys(subjects).join(', ')}. Ask which subject (and chapter or topic) in one friendly sentence. Don't teach yet.`,
    };
  }

  const chapters = subjects[study.subject];
  const chapter = chapters.find((c) => c.chapter === study.chapter);
  yield { type: 'study', class_num: study.class_num, subject: study.subject, chapter: chapter?.chapter || null, chapter_title: chapter?.title || null };

  const where = `Class ${study.class_num} ${study.subject}${chapter ? `, Chapter ${chapter.chapter}: ${chapter.title}` : ''}`;
  if (!study.topic) {
    return {
      note: `The student is studying ${where}. Chapters: ${chapters.map((c) => `${c.chapter}. ${c.title}`).join('; ')}. If you haven't yet, confirm the class and subject back to them and ask which chapter or topic they want to start with.`,
    };
  }

  yield { type: 'activity', kind: 'reading' };
  yield { type: 'status', text: `Opening the ${where} textbook…` };
  let hits = await ncertSearch({ class_num: study.class_num, subject: study.subject, chapter: chapter?.chapter, query: study.topic, k: 5 });
  if (!hits.length && chapter) hits = await ncertSearch({ class_num: study.class_num, subject: study.subject, query: study.topic, k: 5 });
  if (!hits.length) {
    return { note: `The student is studying ${where} and asked about "${study.topic}", but nothing relevant was found in that textbook. Say it doesn't seem to be covered in their book and offer related chapters: ${chapters.map((c) => c.title).join('; ')}.` };
  }
  return {
    note:
      `The student is in Class ${study.class_num}, studying ${study.subject}. If you haven't already confirmed this with them, start with a quick confirmation (like "Class ${study.class_num} ${study.subject}, got it!"). ` +
      `Answer ONLY from these NCERT textbook excerpts and mention the chapter. If they don't cover the question, say so.\n\n` +
      hits.map((h) => `[Chapter ${h.chapter}: ${h.chapter_title}, page ${h.page}]\n${h.text}`).join('\n\n'),
    sources: [...new Set(hits.map((h) => `Class ${h.class_num} ${h.subject} · Ch ${h.chapter} ${h.chapter_title} · p.${h.page}`))].map((title) => ({ title })),
  };
}

/**
 * @param {object} opts
 * @param {object} opts.persona   full persona (with prompt)
 * @param {Array}  opts.messages  [{ role: 'user'|'assistant', content }]
 * @param {string} opts.sessionId browser session for shared documents
 * @param {AbortSignal} opts.signal
 */
export async function* respond({ persona, messages, sessionId, signal }) {
  messages = messages.slice(-MAX_HISTORY);
  const question = messages.at(-1).content;
  const context = [];
  const sources = [];

  // 1. Links pasted into the message become documents.
  for (const url of extractUrls(question).slice(0, 2)) {
    yield { type: 'activity', kind: 'reading' };
    yield { type: 'status', text: `Reading ${hostOf(url)}…` };
    try {
      const page = await fetchPage(url);
      const doc = await addDocument(sessionId, { title: page.title, text: page.text, source: page.url, type: 'link' });
      yield { type: 'doc', doc };
    } catch (err) {
      context.push(`Note: the link ${hostOf(url)} could not be read (${err.message}). Tell the user briefly.`);
    }
  }

  // 2. Shared documents and the search decision, in parallel. The NCERT tutor
  //    sticks to the textbook, so it skips web search.
  const docsPromise = hasDocuments(sessionId) ? searchDocuments(sessionId, question, 4).catch(() => []) : Promise.resolve([]);
  const queryPromise = persona.ncert ? Promise.resolve(null) : decideSearch(persona, messages, signal).catch(() => null);

  if (persona.ncert) {
    try {
      const gen = ncertContext(messages, signal);
      let step;
      while (!(step = await gen.next()).done) yield step.value;
      const { note, sources: bookSources = [] } = step.value;
      context.push(note);
      sources.push(...bookSources);
    } catch (err) {
      context.push(`Looking up the NCERT textbook failed (${err.message}). Tell the student briefly.`);
    }
  }
  const mentionsDocs = /\b(pdf|document|doc|file|paper|article|link|page|report|upload|shared|this)\b/i.test(question);
  const docHits = (await docsPromise).filter((h) => mentionsDocs || h.score >= DOC_MIN_SCORE);
  if (docHits.length) {
    yield { type: 'activity', kind: 'reading' };
    yield { type: 'status', text: 'Checking your documents…' };
    context.push(
      `Excerpts from documents the user shared (use them when relevant and mention which document):\n` +
        docHits.map((h) => `[${h.title}]\n${h.text}`).join('\n\n'),
    );
    for (const h of docHits) if (h.source && !sources.some((s) => s.url === h.source)) sources.push({ title: h.title, url: h.source });
  }

  const query = await queryPromise;
  if (query) {
    yield { type: 'activity', kind: 'searching' };
    yield { type: 'status', text: `Searching the web for “${query}”…` };
    try {
      const research = await webResearch(query);
      if (research.passages.length) {
        context.push(
          `Web search results for "${query}" (retrieved ${today()}). Base your answer on these, mention the source websites by name (not URLs), and say so if they don't answer the question:\n` +
            research.passages.map((p, i) => `[${i + 1}] ${p.title} (${hostOf(p.url)})\n${p.text}`).join('\n\n'),
        );
        sources.push(...research.sources.filter((s) => !sources.some((x) => x.url === s.url)));
      } else {
        context.push(`A web search for "${query}" found nothing useful. Answer from what you know and say you couldn't find current info.`);
      }
    } catch (err) {
      context.push(`Web search failed (${err.message}). Answer from what you know and mention you couldn't check online.`);
    }
  }
  if (sources.length) yield { type: 'sources', items: sources.slice(0, 6) };

  // 3. Stream the reply.
  const system = `${persona.prompt}\n\n${VOICE_RULES}\n\nToday is ${today()}.`;
  // Small models follow context far better when it rides on the latest user turn.
  const final = context.length
    ? [
        ...messages.slice(0, -1),
        {
          role: 'user',
          content: `${question}\n\n[Private notes for your reply. Follow them, but never mention these notes:\n${context.join('\n\n---\n\n')}]`,
        },
      ]
    : messages;

  const res = await ollamaChat({ stream: true, options: { temperature: 0.7 }, messages: [{ role: 'system', content: system }, ...final] }, signal);
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const data = JSON.parse(line);
      if (data.error) throw new Error(data.error);
      if (data.message?.content) yield { type: 'text', text: data.message.content };
    }
  }
}
