// On-phone copy of the drawer's chat list, so the sidebar opens instantly
// even when the Mac can't be reached. Only ids, titles and flags are kept;
// never message text.
import { File, Paths } from "expo-file-system";

const NAME = "hermes-session-list.json";
const MAX_ROWS = 60;

type Row = { id: string; [k: string]: unknown };

export async function loadSessionList<T extends Row>(): Promise<T[]> {
  try {
    const f = new File(Paths.document, NAME);
    if (!f.exists) return [];
    const d = JSON.parse(await f.text());
    return Array.isArray(d?.rows) ? d.rows.filter((r: any) => r && typeof r.id === "string") : [];
  } catch { return []; }
}

export function saveSessionList<T extends Row>(rows: T[]): void {
  try {
    const keep = rows.slice(0, MAX_ROWS).map(r => ({
      id: r.id,
      stored_session_id: r.stored_session_id,
      title: r.title,
      display_name: r.display_name,
      source: r.source,
      archived: r.archived,
    }));
    const f = new File(Paths.document, NAME);
    if (!f.exists) f.create();
    f.write(JSON.stringify({ v: 1, savedAt: Date.now(), rows: keep }));
  } catch {
    // A cache write must never break the drawer.
  }
}
