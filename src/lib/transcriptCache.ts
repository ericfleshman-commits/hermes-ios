// Per-chat transcript cache on the phone, so every recently used chat opens
// instantly (even with no link to the Mac) and server history merges in
// underneath. Each chat has two slot files written in turn (like
// pendingSend), so a crash mid-write always leaves the last complete copy.
// An index evicts the least recently saved chats.
//
// Replaces the old single-chat Keychain cache (12 messages, 900 chars each).
// The old Keychain entries are ignored; the next server sync refills chats.
import { File, Paths } from "expo-file-system";
import type { Msg } from "../hooks/useChatStore";

const PREFIX = "hermes-chat-";
const INDEX = "hermes-chat-index.json";
const MAX_MESSAGES = 200;
const MAX_CHATS = 40;
const MAX_TEXT = 20000;

type Snapshot = { v: 1; seq: number; sessionId: string; messages: Msg[] };
type Index = Record<string, number>; // file key -> save order (higher is newer)
let writes: Promise<unknown> = Promise.resolve();

function fileKey(sessionId: string): string {
  // Never trust an id as a filename.
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").replace(/^\.+/, "_").slice(0, 120);
}
function slotName(key: string, slot: number): string { return `${PREFIX}${key}.${slot}.json`; }
function file(name: string): File { return new File(Paths.document, name); }

async function readJSON<T>(name: string): Promise<T | null> {
  try {
    const f = file(name);
    if (!f.exists) return null;
    return JSON.parse(await f.text()) as T;
  } catch { return null; }
}

function writeJSON(name: string, value: unknown): void {
  const f = file(name);
  if (!f.exists) f.create();
  f.write(JSON.stringify(value));
}

async function newest(sessionId: string): Promise<Snapshot | null> {
  const key = fileKey(sessionId);
  const slots = await Promise.all([0, 1].map(i => readJSON<Snapshot>(slotName(key, i))));
  const good = slots.filter((s): s is Snapshot =>
    !!s && s.v === 1 && s.sessionId === sessionId && Array.isArray(s.messages) && typeof s.seq === "number");
  return good.sort((a, b) => b.seq - a.seq)[0] || null;
}

export async function loadTranscript(sessionId: string): Promise<Msg[] | null> {
  if (!sessionId) return null;
  await writes;
  const snap = await newest(sessionId);
  return snap && snap.messages.length ? snap.messages : null;
}

export function saveTranscript(sessionId: string, messages: Msg[]): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const snapshot = messages
    .filter(m => (m.role === "user" || m.role === "assistant") && m.text && !m.streaming)
    .slice(-MAX_MESSAGES)
    .map(m => ({ id: m.id, role: m.role, text: m.text.length > MAX_TEXT ? `${m.text.slice(0, MAX_TEXT - 1)}…` : m.text }));
  if (!snapshot.length) return Promise.resolve();
  const task = writes.then(async () => {
    const key = fileKey(sessionId);
    const prev = await newest(sessionId);
    const seq = (prev?.seq ?? 0) + 1;
    writeJSON(slotName(key, seq % 2), { v: 1, seq, sessionId, messages: snapshot });
    const index = (await readJSON<Index>(INDEX)) || {};
    // A counter, not the clock: saves in the same millisecond (or after a
    // clock change) must still order correctly for eviction.
    index[key] = Math.max(0, ...Object.values(index).filter(n => typeof n === "number")) + 1;
    const keys = Object.keys(index).sort((a, b) => index[b] - index[a]);
    for (const old of keys.slice(MAX_CHATS)) {
      for (const i of [0, 1]) {
        try { const f = file(slotName(old, i)); if (f.exists) f.delete(); } catch { /* best effort */ }
      }
      delete index[old];
    }
    writeJSON(INDEX, index);
  });
  writes = task.catch(() => {});
  return task;
}
