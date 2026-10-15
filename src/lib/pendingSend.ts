// Durable outbox: every text the user sends is written here first, so typing
// and sending never wait on the network. Items leave the outbox only when the
// server acknowledges them, a fresh server history proves delivery, or the
// user removes them.
//
// Storage: a JSON file in the app's documents directory, written to two
// alternating slots with a sequence number, so a crash mid-write cannot
// destroy the last good copy. The old single-message Keychain record is
// imported once on first read.
import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";

const LEGACY_KEY = "hermes.m.pendingText.v1";
const SLOTS = ["hermes-outbox-a.json", "hermes-outbox-b.json"];
const MAX_TEXT_CHARS = 200_000;

export type PendingState = "queued" | "submitting" | "uncertain";
export type PendingText = {
  id: string;
  sessionId: string;
  text: string;
  state: PendingState;
  /** Highest server row id in the chat before the submit RPC. A later heal
   *  only treats server rows newer than this as delivery evidence. */
  baseRowId?: number | null;
  /** When the send became uncertain (ms epoch). */
  uncertainAt?: number;
  createdAt?: number;
};

type Snapshot = { v: 2; seq: number; items: PendingText[] };

let writes: Promise<unknown> = Promise.resolve();
let cache: Snapshot | null = null;

function valid(p: any): p is PendingText {
  return !!p && typeof p.id === "string" && typeof p.sessionId === "string" &&
    typeof p.text === "string" && ["queued", "submitting", "uncertain"].includes(p.state);
}

async function readSlot(name: string): Promise<Snapshot | null> {
  try {
    const f = new File(Paths.document, name);
    if (!f.exists) return null;
    const d = JSON.parse(await f.text());
    if (!d || d.v !== 2 || typeof d.seq !== "number" || !Array.isArray(d.items)) return null;
    return { v: 2, seq: d.seq, items: d.items.filter(valid) };
  } catch { return null; }
}

async function readLegacy(): Promise<PendingText | null> {
  try {
    const value = JSON.parse((await SecureStore.getItemAsync(LEGACY_KEY)) || "null");
    return valid(value) ? value : null;
  } catch { return null; }
}

function persist(next: Snapshot): void {
  const f = new File(Paths.document, SLOTS[next.seq % 2]);
  if (!f.exists) f.create();
  f.write(JSON.stringify(next));
  cache = next;
}

async function load(): Promise<Snapshot> {
  if (cache) return cache;
  const slots = (await Promise.all(SLOTS.map(readSlot))).filter(Boolean) as Snapshot[];
  let snap: Snapshot = slots.sort((a, b) => b.seq - a.seq)[0] ?? { v: 2, seq: 0, items: [] };
  const legacy = await readLegacy();
  if (legacy) {
    if (!snap.items.some(i => i.id === legacy.id)) {
      snap = { v: 2, seq: snap.seq + 1, items: [legacy, ...snap.items] };
      persist(snap);
    }
    try { await SecureStore.deleteItemAsync(LEGACY_KEY); } catch {}
  }
  cache = snap;
  return snap;
}

/** Serialize every read-modify-write so concurrent calls never lose items. */
function mutate<T>(fn: (items: PendingText[]) => { items: PendingText[]; result: T }): Promise<T> {
  const task = writes.then(async () => {
    const snap = await load();
    const { items, result } = fn(snap.items.map(i => ({ ...i })));
    persist({ v: 2, seq: snap.seq + 1, items });
    return result;
  });
  writes = task.catch(() => {});
  return task;
}

/** Every outbox item, oldest first. */
export async function loadOutbox(): Promise<PendingText[]> {
  await writes;
  return (await load()).items.map(i => ({ ...i }));
}

/** The oldest item, optionally for one chat. */
export async function loadPending(sessionId?: string): Promise<PendingText | null> {
  const items = await loadOutbox();
  return items.find(i => !sessionId || i.sessionId === sessionId) ?? null;
}

export function canAutoSend(pending: PendingText): boolean { return pending.state === "queued"; }

export function queueText(sessionId: string, text: string): Promise<PendingText> {
  if (!sessionId || !text.trim()) return Promise.reject(new Error("No saved chat or message"));
  if (text.length > MAX_TEXT_CHARS) return Promise.reject(new Error("Message too long; your draft is saved"));
  const pending: PendingText = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    sessionId, text, state: "queued", createdAt: Date.now(),
  };
  return mutate(items => ({ items: [...items, pending], result: { ...pending } }));
}

function update(pending: PendingText, state: PendingState, extra: Partial<PendingText> = {}): Promise<PendingText> {
  return mutate(items => {
    const i = items.findIndex(x => x.id === pending.id);
    if (i === -1) throw new Error("Pending message changed");
    items[i] = { ...items[i], ...extra, state };
    return { items, result: { ...items[i] } };
  });
}

export function markSubmitting(pending: PendingText, baseRowId?: number | null): Promise<PendingText> {
  if (!canAutoSend(pending)) return Promise.reject(new Error("Send already attempted"));
  return update(pending, "submitting", baseRowId === undefined ? {} : { baseRowId });
}
// Call only before an RPC has started. A post-submit timeout is uncertain,
// never queued, because the server may already have accepted the message.
export function returnToQueue(pending: PendingText): Promise<PendingText> {
  return update(pending, "queued");
}
export function markUncertain(pending: PendingText): Promise<PendingText> {
  return update(pending, "uncertain", { uncertainAt: Date.now() });
}
export async function clearPending(pending: PendingText): Promise<void> {
  await mutate(items => ({ items: items.filter(x => x.id !== pending.id), result: undefined }));
}

/** On launch nothing can still be mid-RPC: a "submitting" item left by a
 *  crash or kill has an unknown outcome, so it becomes uncertain and goes
 *  through the evidence-based heal instead of being silently resent. */
export function settleAfterLaunch(): Promise<number> {
  return mutate(items => {
    let n = 0;
    const now = Date.now();
    for (const it of items) if (it.state === "submitting") { it.state = "uncertain"; it.uncertainAt = now; n++; }
    return { items, result: n };
  });
}

/** Test hook: forget the in-memory copy (simulates an app relaunch). */
export function __resetForTests(): void { cache = null; writes = Promise.resolve(); }
