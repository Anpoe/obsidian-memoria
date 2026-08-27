import type { Memo } from "./types";

type MemoArchiveIdentity = Pick<Memo, "file" | "date" | "time" | "content">;

const ARCHIVE_KEY_PREFIX = "v1:";
const ARCHIVE_SEPARATOR = "\u001f";

/**
 * Create a compact, deterministic identity for a memo without writing metadata
 * into the user's Markdown files.
 */
export function memoArchiveKey(memo: MemoArchiveIdentity): string {
  const identity = [memo.file, memo.date, memo.time, memo.content].join(
    ARCHIVE_SEPARATOR
  );
  return `${ARCHIVE_KEY_PREFIX}${hashText(identity)}:${identity.length}`;
}

/** Normalize plugin data written by current or older versions. */
export function normalizeArchivedMemoKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function isMemoArchived(
  memo: MemoArchiveIdentity,
  archivedMemoKeys: readonly string[]
): boolean {
  return archivedMemoKeys.includes(memoArchiveKey(memo));
}

export function filterMemosByArchive<T extends MemoArchiveIdentity>(
  memos: readonly T[],
  archivedMemoKeys: readonly string[],
  showArchived: boolean
): T[] {
  return memos.filter(
    (memo) => isMemoArchived(memo, archivedMemoKeys) === showArchived
  );
}

export function setMemoArchived(
  archivedMemoKeys: readonly string[],
  memo: MemoArchiveIdentity,
  archived: boolean
): string[] {
  const next = new Set(normalizeArchivedMemoKeys(archivedMemoKeys));
  const key = memoArchiveKey(memo);
  if (archived) next.add(key);
  else next.delete(key);
  return [...next];
}

/** Keep an archive marker attached when the memo body is edited. */
export function transferArchivedMemoKey(
  archivedMemoKeys: readonly string[],
  memo: MemoArchiveIdentity,
  updatedMemo: MemoArchiveIdentity
): string[] {
  const next = new Set(normalizeArchivedMemoKeys(archivedMemoKeys));
  const oldKey = memoArchiveKey(memo);
  if (!next.has(oldKey)) return [...next];

  next.delete(oldKey);
  next.add(memoArchiveKey(updatedMemo));
  return [...next];
}

function hashText(value: string): string {
  let first = 2166136261;
  let second = 2654435761;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second ^ (code + i), 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}-${(
    second >>> 0
  )
    .toString(16)
    .padStart(8, "0")}`;
}
