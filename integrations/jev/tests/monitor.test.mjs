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
  "quota evidence is surfaced before terminal completion or a long provider retry",
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
    for (const status of ["running", "completed", "failed"]) {
      const result = await monitorTask({
        host,
        parentThreadId: "parent",
        rootThreadId: "child",
        readStatus: async () => ({ status }),
        update: () => {},
        askPermission: async () => {},
        cancelled: () => false,
      });
      NodeAssert.equal(result.uiQuota, true);
      NodeAssert.equal(waits, 0);
    }
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

NodeTest.test(
  "repeated structured rate-limit evidence survives the snapshot and monitor boundary",
  async () => {
    const { workSnapshot } = await import("../progress.mjs"),
      { quotaEvidence } = await import("../policy.mjs");
    const p = {
      thread: {
        id: "child",
        lineage: { parentThreadId: "parent" },
        modelSelection: { instanceId: "kimi-api" },
      },
      runs: [{ id: "run", ordinal: 1, status: "running", providerInstanceId: "kimi-api" }],
      turnItems: [
        {
          runId: "run",
          type: "error",
          ordinal: 1,
          failure: {
            class: "provider_error",
            code: "provider.rate-limit",
            message: "Provider temporarily unavailable",
          },
          retry: { attempt: 2 },
        },
      ],
    };
    const snapshot = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "child",
      projections: [p],
    });
    const result = await monitorTask({
      host: { snapshot: async () => snapshot, changed() {} },
      parentThreadId: "parent",
      rootThreadId: "child",
      readStatus: async () => ({ status: "running" }),
      update: () => {},
      cancelled: () => false,
    });
    NodeAssert.equal(result.uiQuota, true);
    NodeAssert.equal(quotaEvidence({ items: result.uiQuotaEvidence }, "run"), true);
  },
);
