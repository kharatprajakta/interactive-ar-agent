// Per-user memory: chat history with each character, plus one profile the whole
// crew shares: preferred language and style, key facts, and Kiki's study progress.
// After each reply, a small structured LLM call updates the profile in the background.
import { db } from './db.js';
import { ollamaChat } from './chat.js';

const HISTORY_LIMIT = 30; // messages sent to the browser when a call starts
const MAX_FACTS = 30;
const EMPTY = () => ({ language: '', style: '', facts: [], study: null });

// ---------------------------------------------------------------------------
// Chat history
// ---------------------------------------------------------------------------
export function getHistory(userId, persona, limit = HISTORY_LIMIT) {
  return db
    .prepare('SELECT role, content FROM messages WHERE user_id = ? AND persona = ? ORDER BY id DESC LIMIT ?')
    .all(userId, persona, limit)
    .reverse()
    .map((m) => ({ role: m.role, content: m.content }));
}

export function addMessage(userId, persona, role, content) {
  db.prepare('INSERT INTO messages (user_id, persona, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
    userId, persona, role, content.slice(0, 8000), Date.now(),
  );
}

export function historyCounts(userId) {
  return Object.fromEntries(
    db.prepare('SELECT persona, COUNT(*) AS n FROM messages WHERE user_id = ? GROUP BY persona').all(userId).map((r) => [r.persona, r.n]),
  );
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------
export function getMemory(userId) {
  const row = db.prepare('SELECT data FROM memory WHERE user_id = ?').get(userId);
  try {
    return { ...EMPTY(), ...(row ? JSON.parse(row.data) : {}) };
  } catch {
    return EMPTY();
  }
}

function saveMemory(userId, memory) {
  db.prepare(
    'INSERT INTO memory (user_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  ).run(userId, JSON.stringify(memory), Date.now());
}

/** Forget one thing: a fact (by text), or a whole field ('language' | 'style' | 'study' | 'history'). */
export function forget(userId, { fact, field }) {
  const memory = getMemory(userId);
  if (fact) memory.facts = memory.facts.filter((f) => f !== fact);
  if (field === 'language' || field === 'style') memory[field] = '';
  if (field === 'study') memory.study = null;
  if (field === 'history') db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
  saveMemory(userId, memory);
}

export function eraseAll(userId) {
  db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM memory WHERE user_id = ?').run(userId);
}

/** Kiki confirmed a book/chapter: remember it so the next call can pick up there. */
export function saveStudy(userId, study) {
  const memory = getMemory(userId);
  const prev = memory.study || {};
  const recent = (prev.recent || []).filter((r) => !(r.subject === study.subject && r.chapter === study.chapter));
  if (study.chapter) recent.unshift({ subject: study.subject, chapter: study.chapter, chapter_title: study.chapter_title });
  memory.study = {
    class_num: study.class_num,
    subject: study.subject,
    // Keep the last chapter if this turn only named the book.
    chapter: study.chapter || (prev.subject === study.subject ? prev.chapter : null),
    chapter_title: study.chapter_title || (prev.subject === study.subject ? prev.chapter_title : null),
    recent: recent.slice(0, 8),
    at: Date.now(),
  };
  saveMemory(userId, memory);
}

// ---------------------------------------------------------------------------
// Learning from a conversation turn
// ---------------------------------------------------------------------------
const LEARN_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string' },
    style: { type: 'string' },
    add_facts: { type: 'array', items: { type: 'string' } },
    remove_facts: { type: 'array', items: { type: 'string' } },
  },
  required: ['language', 'style', 'add_facts', 'remove_facts'],
};

const LEARN_PROMPT = `You maintain a short memory profile about a user of a voice assistant app, so every assistant can personalise future chats.
Given the current profile and the latest exchange, return updates:
- language: how the user likes to talk, e.g. "English", "Hinglish (Hindi words written in English)", "Marathi and English mix". Base it on how they actually write or an explicit request. Return "" to keep the current value.
- style: explicit preferences about replies, e.g. "short answers", "explain simply with examples", "likes jokes". Return "" to keep the current value.
- add_facts: NEW durable personal details the USER stated about themselves: where they live, school class, job, diet, health notes they shared, goals, family, likes, dislikes, upcoming plans or exams. Short third-person phrases like "Lives in Pune", "Vegetarian", "Board exams in March". Never include what the assistant said, the subject or topic they're asking about or studying right now (that's tracked separately), or anything already in the profile. Usually this is empty.
- remove_facts: existing facts (copied exactly) that the user just said are wrong or out of date.`;

const learning = new Map(); // userId -> promise chain, so updates never race

/** Update the profile from one exchange, in the background (never throws). */
export function learnFromTurn(userId, userText, reply) {
  if (userText.trim().split(/\s+/).length < 3) return; // "yes", "ok thanks"…
  const prev = learning.get(userId) || Promise.resolve();
  const next = prev.then(() => learn(userId, userText, reply)).catch((err) => console.warn('[memory]', err.message));
  learning.set(userId, next);
  next.finally(() => learning.get(userId) === next && learning.delete(userId));
}

async function learn(userId, userText, reply) {
  const memory = getMemory(userId);
  const profile = { language: memory.language, style: memory.style, facts: memory.facts };
  const res = await ollamaChat({
    stream: false,
    format: LEARN_SCHEMA,
    options: { temperature: 0 },
    messages: [
      { role: 'system', content: LEARN_PROMPT },
      { role: 'user', content: `Current profile: ${JSON.stringify(profile)}\n\nUser said: ${userText.slice(0, 1500)}\nAssistant replied: ${reply.slice(0, 800)}` },
    ],
  });
  const out = JSON.parse((await res.json()).message.content);
  const fresh = getMemory(userId); // may have changed while the model ran
  let changed = false;
  for (const key of ['language', 'style']) {
    const v = String(out[key] || '').trim().slice(0, 120);
    if (v && v.toLowerCase() !== fresh[key].toLowerCase()) (fresh[key] = v), (changed = true);
  }
  const remove = new Set((out.remove_facts || []).map((f) => String(f).toLowerCase()));
  if (remove.size) {
    const before = fresh.facts.length;
    fresh.facts = fresh.facts.filter((f) => !remove.has(f.toLowerCase()));
    changed ||= fresh.facts.length !== before;
  }
  const known = new Set(fresh.facts.map((f) => f.toLowerCase()));
  for (const f of out.add_facts || []) {
    const fact = String(f).trim().replace(/\.$/, '').slice(0, 140);
    if (fact.length > 2 && !known.has(fact.toLowerCase())) {
      fresh.facts.push(fact);
      known.add(fact.toLowerCase());
      changed = true;
    }
  }
  fresh.facts = fresh.facts.slice(-MAX_FACTS);
  if (changed) saveMemory(userId, fresh);
}

// ---------------------------------------------------------------------------
// Using memory in a conversation
// ---------------------------------------------------------------------------
/** Private notes for the system prompt: who the user is and what the crew remembers. */
export function memoryNote(user, memory, persona) {
  const lines = [
    `You're talking with ${user.name}. Use their name naturally now and then (a greeting, encouragement), not in every sentence. Don't assume their gender: no "bhai", "didi", "bro", "sir" or "ma'am".`,
  ];
  if (memory.language) lines.push(`They like to talk in ${memory.language}. Reply in that same way, but keep it easy to read aloud.`);
  if (memory.style) lines.push(`Their preferences for replies: ${memory.style}.`);
  if (memory.facts.length) {
    lines.push(
      `What you remember about ${user.name} from earlier chats. Use a detail only when it clearly fits the current question (e.g. their diet for a recipe, their city for a trip); otherwise ignore it, and never list these back:\n- ${memory.facts.join('\n- ')}`,
    );
  }
  if (persona.ncert && memory.study) {
    const s = memory.study;
    lines.push(`Last time with you they studied Class ${s.class_num} ${s.subject}${s.chapter ? `, Chapter ${s.chapter}: ${s.chapter_title}` : ''}.`);
  }
  return lines.join('\n');
}

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** The first thing a character says when the call connects. */
export function greetingFor(persona, user, memory, hasHistory) {
  const name = user.name.split(' ')[0];
  if (persona.ncert && memory.study) {
    const s = memory.study;
    const where = `Class ${s.class_num} ${titleCase(s.subject)}${s.chapter ? `, Chapter ${s.chapter}: ${s.chapter_title}` : ''}`;
    return `Hi ${name}, welcome back! Last time we were on ${where}. Shall we carry on with that, or study something new?`;
  }
  if (hasHistory) {
    // Drop their usual opener ("Hey there, Bruno here!") for a welcome back.
    return `Hey ${name}, good to hear from you again! ${persona.greeting.replace(/^[^!.?]*[!.?]\s*/, '')}`;
  }
  // "Hi, Jasper here" -> "Hi Asha, Jasper here"; "Hello from the moon base!" -> "Hi Asha, greetings from…";
  // otherwise just say hi first.
  const g = persona.greeting;
  if (/^Hello from\b/.test(g)) return `Hi ${name}, greetings${g.slice('Hello'.length)}`;
  const opener = g.match(/^(Hey there|Hi|Hey|Hello),?\s+/);
  return opener ? `${opener[1]} ${name}, ${g.slice(opener[0].length)}` : `Hi ${name}! ${g}`;
}
