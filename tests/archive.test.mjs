import test from "node:test";
import assert from "node:assert/strict";

const {
  isMemoArchived,
  filterMemosByArchive,
  memoArchiveKey,
  normalizeArchivedMemoKeys,
  setMemoArchived,
  transferArchivedMemoKey,
} = await import("../src/archive.ts");

const memo = {
  file: "Memoria/2026.md",
  date: "2026-08-18",
  time: "09:30",
  content: "一条需要稍后处理的笔记",
};

test("the same memo produces a stable archive key", () => {
  assert.equal(memoArchiveKey(memo), memoArchiveKey({ ...memo }));
  assert.notEqual(
    memoArchiveKey(memo),
    memoArchiveKey({ ...memo, content: "另一条笔记" })
  );
});

test("archiving and unarchiving toggles only the selected memo", () => {
  const archived = setMemoArchived([], memo, true);
  assert.equal(isMemoArchived(memo, archived), true);

  const restored = setMemoArchived(archived, memo, false);
  assert.equal(isMemoArchived(memo, restored), false);
});

test("archive keys are normalized to unique non-empty strings", () => {
  assert.deepEqual(
    normalizeArchivedMemoKeys(["a", "a", "", 42, null, "b"]),
    ["a", "b"]
  );
});

test("editing an archived memo transfers its archive state to the new content", () => {
  const archived = setMemoArchived([], memo, true);
  const editedMemo = { ...memo, content: "编辑后的笔记内容" };
  const updated = transferArchivedMemoKey(
    archived,
    memo,
    editedMemo
  );

  assert.equal(isMemoArchived(editedMemo, updated), true);
  assert.equal(isMemoArchived(memo, updated), false);
});

test("normal and archive views partition memos without losing either one", () => {
  const archivedMemo = { ...memo, content: "已归档笔记" };
  const keys = setMemoArchived([], archivedMemo, true);
  const memos = [memo, archivedMemo];

  assert.deepEqual(
    filterMemosByArchive(memos, keys, false).map((item) => item.content),
    [memo.content]
  );
  assert.deepEqual(
    filterMemosByArchive(memos, keys, true).map((item) => item.content),
    [archivedMemo.content]
  );
});
