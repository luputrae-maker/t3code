import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { monitorTask } from "../monitor.mjs";
NodeTest.test(
  "live work remains attached, updates the checklist, and returns only after completion",
  async () => {
    let n = 0;
    const updates = [];
    const host = {
      snapshot: async () => ({
        plan: [
          {
            content: n ? "Test code" : "Read files",
            status: n ? "completed" : "in_progress",
            priority: "medium",
          },
        ],
        counts: { running: n ? 0 : 1, completed: n ? 1 : 0, waiting: 0, blocked: 0, failed: 0 },
        rows: [],
        approvals: [],
        questions: [],
        quota: [],
      }),
      waitForChange: async () => {
        n++;
      },
      changed() {},
    };
    const result = await monitorTask({
      host,
      parentThreadId: "parent",
      rootThreadId: "child",
      readStatus: async () => ({ status: n ? "completed" : "running", hasPendingChildRuns: false }),
      update: (s) => updates.push(s),
      askPermission: async () => {
        throw Error("No permission expected");
      },
      cancelled: () => false,
    });
    NodeAssert.equal(result.status, "completed");
    NodeAssert.ok(updates.some((x) => x.plan[0].status === "in_progress"));
    NodeAssert.ok(updates.some((x) => x.plan[0].status === "completed"));
  },
);
NodeTest.test(
  "a pending child approval is routed to the main UI and never accepted automatically",
  async () => {
    let asked = 0,
      writes = 0;
    const permission = {
      threadId: "child",
      requestId: "approval",
      runId: "run",
      prompt: "Run tests?",
      fingerprint: "fixed",
    };
    const host = {
      snapshot: async () => ({
        plan: [],
        counts: {},
        rows: [],
        approvals: [permission],
        questions: [],
        quota: [],
      }),
      respondToUserApproval: async () => {
        writes++;
      },
      waitForChange: async () => {},
      changed() {},
    };
    const result = await monitorTask({
      host,
      parentThreadId: "parent",
      rootThreadId: "child",
      readStatus: async () => ({ status: "running", pendingApproval: { requestId: "approval" } }),
      update: () => {},
      askPermission: async () => {
        asked++;
        return { outcome: { outcome: "cancelled" } };
      },
      cancelled: () => false,
    });
    NodeAssert.equal(asked, 1);
    NodeAssert.equal(writes, 0);
    NodeAssert.equal(result.uiDeferred, true);
  },
);
NodeTest.test(
  "a running provider retry with an explicit quota error is surfaced promptly",
  async () => {
    let waits = 0;
    const host = {
      snapshot: async () => ({
        plan: [],
        counts: {},
        rows: [],
        approvals: [],
        questions: [],
        quota: [{ threadId: "child", runId: "run", message: "TPD rate limit exceeded" }],
      }),
      waitForChange: async () => {
        waits++;
      },
      changed() {},
    };
    const result = await monitorTask({
      host,
      parentThreadId: "parent",
      rootThreadId: "child",
      readStatus: async () => ({ status: "running" }),
      update: () => {},
      askPermission: async () => {},
      cancelled: () => false,
    });
    NodeAssert.equal(result.uiQuota, true);
    NodeAssert.equal(waits, 0);
  },
);
NodeTest.test("a nested router leaves approval forwarding to the main coordinator", async () => {
  let n = 0,
    asked = 0;
  const host = {
    snapshot: async () => ({
      plan: [],
      counts: {},
      rows: [],
      approvals: [{ requestId: "native" }],
      questions: [],
      quota: [],
    }),
    waitForChange: async () => {
      n++;
    },
    changed() {},
  };
  const result = await monitorTask({
    host,
    parentThreadId: "parent",
    rootThreadId: "child",
    relay: false,
    readStatus: async () => ({ status: n ? "completed" : "running", hasPendingChildRuns: false }),
    update: () => {},
    askPermission: async () => {
      asked++;
    },
    cancelled: () => false,
  });
  NodeAssert.equal(result.status, "completed");
  NodeAssert.equal(asked, 0);
});
NodeTest.test("other agents keep updating while the main chat waits for an approval", async () => {
  let updates = 0,
    resolveUi;
  const request = { threadId: "child", requestId: "request", runId: "run", fingerprint: "fixed" };
  const host = {
    snapshot: async () => ({
      plan: [],
      counts: {},
      rows: [],
      approvals: [request],
      questions: [],
      quota: [],
    }),
    waitForChange: async () => {
      if (updates >= 2 && resolveUi) resolveUi({ outcome: { outcome: "cancelled" } });
    },
    changed() {},
  };
  const r = await monitorTask({
    host,
    parentThreadId: "parent",
    rootThreadId: "child",
    readStatus: async () => ({ status: "running" }),
    update: () => {
      updates++;
    },
    askPermission: () =>
      new Promise((resolve) => {
        resolveUi = resolve;
      }),
    cancelled: () => false,
  });
  NodeAssert.ok(updates >= 2);
  NodeAssert.equal(r.uiDeferred, true);
});
