import assert from "node:assert/strict";
import test from "node:test";

import {
  clearDraft,
  clearScroll,
  forget,
  loadDraft,
  loadScroll,
  restoreAnchorScrollTop,
  saveDraft,
  saveScroll,
  topVisibleRow,
} from "./view-state.ts";

const id = (suffix: string) => `view-state-test-${suffix}`;

test("scroll anchors round-trip and overwrite", () => {
  const sid = id("scroll-roundtrip");
  forget(sid);

  saveScroll(sid, { messageId: "m-1", offsetTop: -18 });
  assert.deepEqual(loadScroll(sid), { messageId: "m-1", offsetTop: -18 });

  saveScroll(sid, { messageId: "m-2", offsetTop: 42 });
  assert.deepEqual(loadScroll(sid), { messageId: "m-2", offsetTop: 42 });
  forget(sid);
});

test("drafts round-trip and overwrite", () => {
  const sid = id("draft-roundtrip");
  forget(sid);

  saveDraft(sid, "half written");
  assert.equal(loadDraft(sid), "half written");

  saveDraft(sid, "updated");
  assert.equal(loadDraft(sid), "updated");
  forget(sid);
});

test("sessions do not share scroll or draft state", () => {
  const left = id("isolated-left");
  const right = id("isolated-right");
  forget(left);
  forget(right);

  saveScroll(left, { messageId: "left-message", offsetTop: -4 });
  saveScroll(right, { messageId: "right-message", offsetTop: 9 });
  saveDraft(left, "left draft");
  saveDraft(right, "right draft");

  assert.deepEqual(loadScroll(left), { messageId: "left-message", offsetTop: -4 });
  assert.deepEqual(loadScroll(right), { messageId: "right-message", offsetTop: 9 });
  assert.equal(loadDraft(left), "left draft");
  assert.equal(loadDraft(right), "right draft");

  forget(left);
  forget(right);
});

test("clearScroll and clearDraft only remove their own value", () => {
  const sid = id("clear-one-kind");
  forget(sid);

  saveScroll(sid, { messageId: "m", offsetTop: 3 });
  saveDraft(sid, "draft");
  clearScroll(sid);
  assert.equal(loadScroll(sid), null);
  assert.equal(loadDraft(sid), "draft");

  saveScroll(sid, { messageId: "m", offsetTop: 3 });
  clearDraft(sid);
  assert.deepEqual(loadScroll(sid), { messageId: "m", offsetTop: 3 });
  assert.equal(loadDraft(sid), "");
  forget(sid);
});

test("forget removes both scroll and draft state", () => {
  const sid = id("forget");
  forget(sid);
  saveScroll(sid, { messageId: "m", offsetTop: -2 });
  saveDraft(sid, "draft");

  forget(sid);

  assert.equal(loadScroll(sid), null);
  assert.equal(loadDraft(sid), "");
});

test("at most 200 session entries are kept, evicting the oldest insertion", () => {
  const prefix = id("capacity");
  for (let index = 0; index < 201; index += 1) {
    saveDraft(`${prefix}-${index}`, `draft-${index}`);
  }

  assert.equal(loadDraft(`${prefix}-0`), "");
  assert.equal(loadDraft(`${prefix}-1`), "draft-1");
  assert.equal(loadDraft(`${prefix}-200`), "draft-200");
  for (let index = 0; index < 201; index += 1) forget(`${prefix}-${index}`);
});

test("overwriting an entry does not refresh its insertion order", () => {
  const prefix = id("capacity-overwrite");
  for (let index = 0; index < 200; index += 1) {
    saveDraft(`${prefix}-${index}`, `draft-${index}`);
  }
  saveDraft(`${prefix}-0`, "updated");
  saveDraft(`${prefix}-200`, "new");

  assert.equal(loadDraft(`${prefix}-0`), "");
  assert.equal(loadDraft(`${prefix}-1`), "draft-1");
  assert.equal(loadDraft(`${prefix}-200`), "new");
  for (let index = 0; index < 201; index += 1) forget(`${prefix}-${index}`);
});

test("topVisibleRow finds the first row intersecting the viewport top", () => {
  const rows = [
    { index: 0, start: 0, size: 50 },
    { index: 1, start: 50, size: 80 },
    { index: 2, start: 130, size: 40 },
  ];

  assert.deepEqual(topVisibleRow(rows, 70), rows[1]);
  assert.equal(topVisibleRow(rows, 170), null);
});

test("anchor restore keeps a negative original offset", () => {
  const anchor = { messageId: "m", offsetTop: -30 };
  assert.equal(restoreAnchorScrollTop(anchor, 500, 12), 542);
});

test("anchor restore handles an original offset larger than the current row height", () => {
  const rowHeight = 40;
  const anchor = { messageId: "m", offsetTop: 120 };
  assert.equal(restoreAnchorScrollTop(anchor, 500, rowHeight), 420);
});
