import type { ConnState } from "./gateway";
const number = (value: unknown): number | null =>
  (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) &&
  Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
export function usageLines(usage: any, billing: any, provider: string): string[] {
  const tokens = number(usage?.total);
  const cost = number(usage?.cost_usd);
  const estimate = number(usage?.estimated_cost_usd);
  // billing.state is Nous billing, not the selected third-party provider's account.
  const balance = provider === "nous" && billing?.logged_in === true ? number(billing?.balance_usd) : null;
  return [
    tokens === null ? "Token usage unavailable" : `Tokens (text units): ${tokens.toLocaleString()}`,
    cost !== null ? `Reported cost: $${cost.toFixed(4)}` : estimate !== null ? `Estimated cost: $${estimate.toFixed(4)}` : "Cost unavailable",
    balance === null ? "Balance unavailable for this provider" : `Nous balance: $${balance.toFixed(2)}`,
  ];
}
export function buildLabel(sourceTag: string, nativeBuild: string | null | undefined): string {
  return nativeBuild ? `${sourceTag} · TestFlight ${nativeBuild}` : sourceTag;
}

export function connectionLabel(state: ConnState): string {
  // Honest about first boot vs a dropped connection: "Reconnecting" on a
  // cold start would imply a connection that never existed.
  if (state === "open") return "Connected";
  if (state === "idle" || state === "connecting") return "Connecting to Hermes\u2026";
  return "Reconnecting. You can type; sending waits for a connection.";
}
export function diagnosticReport(info: { build: string; connection: string; provider: string; delivery?: string }): string {
  // Do not copy raw gateway errors, URLs, tickets, session IDs, or transcripts.
  return JSON.stringify({ build: info.build, connection: info.connection, provider: info.provider,
    delivery: info.delivery || "idle", capturedAt: new Date().toISOString() }, null, 2);
}
