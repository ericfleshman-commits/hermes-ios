// One-shot runs are finite jobs, not conversations. Desktop keeps them out of
// its chat recents; keep the phone drawer aligned without altering their data.
export function visibleChatSessions<T extends { archived?: boolean; status?: string; source?: string }>(rows: T[]): T[] {
  return rows.filter(row => !row.archived && row.status !== "archived" && row.source !== "oneshot");
}
