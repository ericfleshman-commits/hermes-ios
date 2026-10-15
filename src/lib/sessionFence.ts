// The runtime allows exactly one writer per chat. A second surface that tries to
// resume or submit into a chat another surface owns gets a typed refusal whose
// first line is a user sentence and whose second line is owner detail meant for
// logs ("Details: session <id> opened by desktop 5m ago."). The app used to show
// both lines verbatim, which reads like a crash and leaks lease jargon.
const FENCE_MARKER = "open in another Hermes window/terminal";
const DETAILS_PREFIX = "Details: session ";

export function isSessionFencedElsewhere(message: string): boolean {
  return typeof message === "string" && message.includes(FENCE_MARKER);
}

function describeSurface(surface: string): string {
  const s = surface.toLowerCase();
  if (s.includes("desktop")) return "the desktop app on your Mac";
  if (s.includes("mobile") || s.includes("ios") || s.includes("iphone")) return "the mobile app";
  if (s.includes("tui") || s.includes("terminal") || s.includes("cli")) return "a terminal";
  if (s.includes("telegram")) return "Telegram";
  return surface ? `another Hermes surface (${surface})` : "another Hermes surface";
}

function parseOwner(message: string): { surface: string; age: string } | null {
  const line = message.split("\n").map((l) => l.trim()).find((l) => l.startsWith(DETAILS_PREFIX));
  if (!line) return null;
  const match = /^Details: session \S+ opened by (.+?)\.?$/.exec(line);
  if (!match) return null;
  const ageMatch = /^(.*?)\s+(\S+\s+ago)$/.exec(match[1].trim());
  return {
    surface: (ageMatch ? ageMatch[1] : match[1]).trim(),
    age: ageMatch ? ageMatch[2] : "",
  };
}

// One plain sentence naming the other surface, the reason, and both ways out.
export function fenceNotice(message: string): string {
  const owner = parseOwner(message);
  const where = owner ? describeSurface(owner.surface) : "another Hermes window";
  const when = owner && owner.age ? `, opened ${owner.age}` : "";
  return (
    `Sent nothing: this chat is open in ${where}${when}, and Hermes allows one writer per chat. ` +
    `Close it there to send from here, or start a new chat with +.`
  );
}
