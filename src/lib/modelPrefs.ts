import * as SecureStore from "expo-secure-store";

/**
 * Model picker memory: favorites the user pinned, plus the last few models
 * they actually switched to. One small JSON blob in the keychain, which the
 * app already links, so this adds no native module.
 */
export type ModelRef = { provider: string; model: string };

export type ModelPrefs = {
  favorites: ModelRef[];
  recents: ModelRef[];
  /** Last model the user (or the auto-default) settled on. Applied only when
   *  it still exists in the backend listing; otherwise re-resolved below. */
  defaultModel?: ModelRef;
};

export const EMPTY_PREFS: ModelPrefs = { favorites: [], recents: [] };

const KEY = "hermes.modelPrefs.v1";
const MAX_RECENTS = 6;

/** Stable identity for a provider/model pair. */
export function refKey(r: ModelRef): string {
  return `${r.provider}::${r.model}`;
}

function norm(v: any): ModelRef | null {
  if (!v || typeof v.provider !== "string" || typeof v.model !== "string") return null;
  if (!v.provider || !v.model) return null;
  return { provider: v.provider, model: v.model };
}

function normList(v: any): ModelRef[] {
  if (!Array.isArray(v)) return [];
  const out: ModelRef[] = [];
  for (const item of v) {
    const r = norm(item);
    if (r) out.push(r);
  }
  return out;
}

export async function loadModelPrefs(): Promise<ModelPrefs> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return EMPTY_PREFS;
    const parsed = JSON.parse(raw);
    const def = norm(parsed?.defaultModel);
    return {
      favorites: normList(parsed?.favorites),
      recents: normList(parsed?.recents),
      ...(def ? { defaultModel: def } : {}),
    };
  } catch {
    return EMPTY_PREFS;
  }
}

async function save(prefs: ModelPrefs): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, JSON.stringify(prefs));
  } catch {
    // Preferences are a convenience. Storage failing must never break a switch.
  }
}

export async function toggleFavorite(prefs: ModelPrefs, ref: ModelRef): Promise<ModelPrefs> {
  const k = refKey(ref);
  const isFav = prefs.favorites.some((f) => refKey(f) === k);
  const favorites = isFav
    ? prefs.favorites.filter((f) => refKey(f) !== k)
    : [...prefs.favorites, ref];
  const next: ModelPrefs = { ...prefs, favorites };
  await save(next);
  return next;
}

export async function rememberRecent(prefs: ModelPrefs, ref: ModelRef): Promise<ModelPrefs> {
  const k = refKey(ref);
  const recents = [ref, ...prefs.recents.filter((r) => refKey(r) !== k)].slice(0, MAX_RECENTS);
  const next: ModelPrefs = { ...prefs, recents };
  await save(next);
  return next;
}

/** Persist the settled model so the next launch never starts model-less. */
export async function setDefaultModel(prefs: ModelPrefs, ref: ModelRef): Promise<ModelPrefs> {
  const next: ModelPrefs = { ...prefs, defaultModel: ref };
  await save(next);
  return next;
}

export type ModelProviderOption = {
  slug?: string;
  name?: string;
  models?: Array<string | { id?: string; name?: string }>;
};

/**
 * Resolve the model to select when the backend reports none for a session.
 * Order: persisted default, most-recent picks, favorites, then the first
 * model the backend actually lists. Returns null only when the backend
 * lists nothing usable.
 */
export function resolveDefaultModel(
  prefs: ModelPrefs,
  providers: ModelProviderOption[],
): ModelRef | null {
  const available: ModelRef[] = [];
  for (const p of providers ?? []) {
    const slug = p?.slug || p?.name;
    if (!slug || !Array.isArray(p?.models)) continue;
    for (const m of p.models) {
      const name = typeof m === "string" ? m : m?.id || m?.name;
      if (name) available.push({ provider: slug, model: name });
    }
  }
  if (!available.length) return null;
  const known = new Set(available.map(refKey));
  const candidates: Array<ModelRef | undefined> = [
    prefs.defaultModel,
    ...prefs.recents,
    ...prefs.favorites,
  ];
  for (const c of candidates) {
    if (c && known.has(refKey(c))) return { provider: c.provider, model: c.model };
  }
  return available[0];
}
