import type { PendingImage } from "../components/Composer";

export type PendingTurn = {
  sessionId: string;
  text: string;
  images: PendingImage[];
  imagePaths: string[];
  /** Set when the turn has a user bubble: lets tap-to-retry replay the exact turn. */
  messageId?: string;
};

// Keep completed paths in the caller's retry record before starting the next upload.
/** Duck-typed Error check: `instanceof Error` fails across the vm-realm
 *  boundary the node tests run the module in, which would double-wrap the
 *  message ("Error: boom"). */
function asError(e: unknown): Error {
  if (typeof e === "object" && e !== null && typeof (e as { message?: unknown }).message === "string") {
    return e as Error;
  }
  return new Error(String(e));
}

/** Retry policy for the pre-submit upload phase. The submit RPC itself is
 *  always single-attempt: a post-submit timeout may hide an accepted prompt,
 *  so only the user's explicit tap-to-retry may replay a submission. */
export type SubmitRetryOpts = {
  /** Max upload attempts per photo. Default 1: fail fast, tap-to-retry owns the retry. */
  maxUploadAttempts?: number;
  /** Base delay for exponential upload-retry backoff (attempt n waits base * 2^(n-1)). */
  uploadRetryDelayMs?: number;
  /** Called before each upload retry with the upcoming 1-based attempt number. */
  onUploadRetry?: (attempt: number, maxAttempts: number, error: Error) => void;
  /** Sleep injector for tests. */
  sleep?: (ms: number) => Promise<void>;
};

export async function submitTurn(
  sessionId: string,
  text: string,
  images: PendingImage[],
  imagePaths: string[],
  io: {
    uploadImage: (image: PendingImage) => Promise<string>;
    submit: (sessionId: string, body: string) => Promise<unknown>;
  },
  opts: SubmitRetryOpts = {},
): Promise<void> {
  const maxAttempts = Math.max(1, Math.floor(opts.maxUploadAttempts ?? 1));
  const baseDelayMs = Math.max(0, opts.uploadRetryDelayMs ?? 1000);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = imagePaths.length; i < images.length; i++) {
    let attempt = 0;
    for (;;) {
      attempt++;
      try {
        const path = await io.uploadImage(images[i]);
        if (typeof path !== "string" || !path.trim()) throw new Error("Photo upload returned no path");
        imagePaths.push(path);
        break;
      } catch (e) {
        if (attempt >= maxAttempts) throw e;
        opts.onUploadRetry?.(attempt + 1, maxAttempts, asError(e));
        await sleep(baseDelayMs * 2 ** (attempt - 1));
      }
    }
  }
  const body = [...imagePaths.map(path => `@image:${path}`), text].filter(Boolean).join("\n\n");
  await io.submit(sessionId, body);
}
