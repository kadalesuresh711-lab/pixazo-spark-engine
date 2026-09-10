/**
 * API key pools.
 *
 * Image keys (Pixazo) are used in parallel — TEN renders at once, and never
 * more: one key renders exactly ONE image at a time. The text key (Agnes AI)
 * is read directly from the environment in agnes.server.ts.
 */

/** How many image keys the pool may hold. */
export const MAX_IMAGE_KEYS = 10;

function readPool(prefix: string): string[] {
  const keys: string[] = [];
  const base = process.env[prefix];
  if (base) keys.push(base.trim());
  for (let i = 1; i <= MAX_IMAGE_KEYS + 2; i++) {
    const v = process.env[`${prefix}_${i}`];
    if (v && v.trim()) keys.push(v.trim());
  }
  return [...new Set(keys)].slice(0, MAX_IMAGE_KEYS);
}

export function pixazoKeys(): string[] {
  const keys = readPool("PIXAZO_API_KEY");
  if (keys.length === 0) throw new Error("Missing PIXAZO_API_KEY");
  return keys;
}

/**
 * Deterministic spread for the IMAGE pool: a caller passes the scene index as
 * `slot`, so consecutive scenes running at the same time land on different
 * keys. `attempt` shifts to the next key on a retry.
 */
export function pickKey(keys: string[], slot: number, attempt = 0): string {
  const n = keys.length;
  const i = ((((slot % n) + n) % n) + attempt) % n;
  return keys[i] as string;
}

/* ------------------------------------------------------------------ */
/* One image per key at a time                                         */
/* ------------------------------------------------------------------ */

/** Keys currently rendering an image. */
const busy = new Set<string>();
/** Callers waiting for any key to free up. */
const waiters: (() => void)[] = [];

function takeFree(keys: string[], slot: number, attempt: number): string | undefined {
  const n = keys.length;
  for (let step = 0; step < n; step++) {
    const key = pickKey(keys, slot + step, attempt);
    if (!busy.has(key)) return key;
  }
  return undefined;
}

/**
 * Leases one free image key for the duration of `fn`, so a single key never
 * has two renders in flight. With ten keys configured, exactly ten images are
 * generated in parallel; an eleventh request simply waits its turn.
 */
export async function withImageKey<T>(
  slot: number,
  attempt: number,
  fn: (key: string, keyIndex: number) => Promise<T>,
): Promise<T> {
  const keys = pixazoKeys();
  let key = takeFree(keys, slot, attempt);
  while (!key) {
    await new Promise<void>((resolve) => waiters.push(resolve));
    key = takeFree(keys, slot, attempt);
  }
  busy.add(key);
  try {
    return await fn(key, keys.indexOf(key));
  } finally {
    busy.delete(key);
    waiters.shift()?.();
  }
}
