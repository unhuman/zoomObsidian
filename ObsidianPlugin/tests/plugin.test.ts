import assert from "node:assert/strict";
import test from "node:test";
import { runDeletePhase } from "../src/delete-phase.js";
import { classifyMeetingParticipants } from "../src/meeting-routing.js";
import { OperationLock } from "../src/operation-lock.js";
import { collectPaginatedItems } from "../src/participant-pagination.js";
import { runWithTimeout } from "../src/timeout.js";

test("operation lock rejects overlap and only the owner can release it", () => {
  const lock = new OperationLock();

  assert.equal(lock.tryAcquire("sync"), true);
  assert.equal(lock.activeOperation, "sync");
  assert.equal(lock.tryAcquire("list"), false);

  lock.release("list");
  assert.equal(lock.activeOperation, "sync");

  lock.release("sync");
  assert.equal(lock.activeOperation, null);
  assert.equal(lock.tryAcquire("list"), true);
});

test("timeout aborts the task and reports the timeout", async () => {
  let taskObservedAbort = false;
  let timeoutMessage = "";

  const result = runWithTimeout(
    async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          taskObservedAbort = true;
          resolve();
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            taskObservedAbort = true;
            resolve();
          },
          { once: true }
        );
      });
      return "task stopped";
    },
    20,
    (error) => {
      timeoutMessage = error.message;
    }
  );

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Sync timeout after /);
    return true;
  });
  assert.equal(taskObservedAbort, true);
  assert.match(timeoutMessage, /^Sync timeout after /);
});

test("participant pagination collects all pages and stops at the reported total", async () => {
  const requestedPages: number[] = [];

  const result = await collectPaginatedItems(async (page) => {
    requestedPages.push(page);
    if (page === 1) return { items: ["A", "B"], total: 5, pageSize: 2 };
    if (page === 2) return { items: ["C", "D"], total: 5, pageSize: 2 };
    return { items: ["E"], total: 5, pageSize: 2 };
  });

  assert.deepEqual(result.items, ["A", "B", "C", "D", "E"]);
  assert.equal(result.pagesFetched, 3);
  assert.deepEqual(requestedPages, [1, 2, 3]);
});

test("participant pagination avoids duplicating a page when the endpoint ignores page", async () => {
  const requestedPages: number[] = [];

  const result = await collectPaginatedItems(async (page) => {
    requestedPages.push(page);
    return { items: ["same page"], total: 10, pageSize: 1 };
  });

  assert.deepEqual(result.items, ["same page"]);
  assert.equal(result.pagesFetched, 2);
  assert.deepEqual(requestedPages, [1, 2]);
});

test("group classification keeps full names together and ignores 1:1 numeric fragments", () => {
  const group = classifyMeetingParticipants(
    "Dhruti Shah: Alex Chen: Priya Rao",
    ["Alex Chen", "Priya Rao"],
    "Dhruti",
    "owned"
  );
  assert.deepEqual(group.topicParts, ["Dhruti Shah", "Alex Chen", "Priya Rao"]);
  assert.deepEqual(group.topicNonSelf, ["Alex Chen", "Priya Rao"]);
  assert.equal(group.isGroupTopic, true);

  const oneOnOne = classifyMeetingParticipants(
    "Dhruti Shah: 1:1",
    ["Dhruti Shah"],
    "Dhruti",
    "owned"
  );
  assert.deepEqual(oneOnOne.topicParts, ["Dhruti Shah"]);
  assert.equal(oneOnOne.isGroupTopic, false);
});

test("delete phase preserves date hints for recurring meetings with the same ID", async () => {
  const calls: Array<[string, string | undefined]> = [];

  const report = await runDeletePhase(
    [
      { topic: "First occurrence", rawId: "98455060768", dateHint: "2026-08-25" },
      { topic: "Second occurrence", rawId: "98455060768", dateHint: "2026-08-26" },
    ],
    async (meetingId, dateHint) => {
      calls.push([meetingId, dateHint]);
      return { success: true, message: "deleted" };
    }
  );

  assert.deepEqual(calls, [
    ["98455060768", "2026-08-25"],
    ["98455060768", "2026-08-26"],
  ]);
  assert.deepEqual(report, { deleted: 2, deleteFailed: 0 });
});
