import * as SecureStore from "expo-secure-store";

// Text only. Photos remain in memory until proper file storage is added.
const KEY = "hermes.m.drafts.v1";
let writes: Promise<void> = Promise.resolve();
async function readDrafts(): Promise<Record<string, string>> {
  const value: unknown = JSON.parse((await SecureStore.getItemAsync(KEY)) ?? "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid draft storage");
  return Object.fromEntries(Object.entries(value).filter(([, text]) => typeof text === "string"));
}
export async function loadDraft(sessionId: string): Promise<string> {
  if (!sessionId) return "";
  await writes;
  const drafts = await readDrafts();
  return Object.prototype.hasOwnProperty.call(drafts, sessionId) ? drafts[sessionId] : "";
}
export function saveDraft(sessionId: string, text: string): Promise<void> {
  if (!sessionId) return Promise.resolve();
  const task = writes.then(async () => {
    const drafts = await readDrafts();
    if (text) Object.defineProperty(drafts, sessionId, { value: text, enumerable: true, configurable: true });
    else delete drafts[sessionId];
    if (Object.keys(drafts).length) await SecureStore.setItemAsync(KEY, JSON.stringify(drafts));
    else await SecureStore.deleteItemAsync(KEY);
  });
  writes = task.catch(() => {});
  return task;
}
export function clearDraft(sessionId: string): Promise<void> {
  return saveDraft(sessionId, "");
}
