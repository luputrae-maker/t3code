import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { workSnapshot } from "../progress.mjs";
const projection = (id, parent, provider, status = "running", extra = {}) => ({
  thread: {
    id,
    title: id,
    lineage: { parentThreadId: parent },
    modelSelection: { instanceId: provider, model: "fixture" },
  },
  runs: [{ id: id + "-run", ordinal: 1, status, providerInstanceId: provider }],
  subagents: [],
  runtimeRequests: [],
  turnItems: [],
  plans: [],
  ...extra,
});
NodeTest.test(
  "the checklist counts actual executors once and shows each agent’s observed activity",
  () => {
    const root = projection("main", "parent", "claudeAgent", "running", {
      subagents: [
        {
          origin: "app_owned",
          childThreadId: "router",
          title: "Review navigation",
          status: "running",
        },
      ],
      plans: [
        {
          runId: "main-run",
          steps: [
            { content: "Inspect files", status: "completed" },
            { content: "Combine findings", status: "pending" },
          ],
        },
      ],
    });
    const router = projection("router", "main", "jev-auto", "running", {
      subagents: [
        {
          origin: "app_owned",
          childThreadId: "worker",
          title: "Navigation specialist",
          status: "running",
        },
      ],
    });
    const worker = projection("worker", "router", "codex", "running", {
      turnItems: [
        {
          type: "file_search",
          runId: "worker-run",
          status: "running",
          title: "Checking navigation routes",
        },
      ],
    });
    const s = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [root, router, worker],
    });
    NodeAssert.equal(s.counts.running, 2);
    NodeAssert.equal(s.rows.length, 2);
    NodeAssert.ok(s.rows.some((r) => r.activity === "Checking navigation routes"));
    NodeAssert.ok(
      s.plan.some((p) => p.content.includes("Inspect files") && p.status === "completed"),
    );
    NodeAssert.ok(
      s.plan.some((p) => p.content.includes("Combine findings") && p.status === "pending"),
    );
  },
);
NodeTest.test(
  "failed, quota-blocked and approval-waiting tasks never get a completed check mark",
  () => {
    const root = projection("main", "parent", "kimi-api", "running", {
      turnItems: [
        {
          type: "error",
          runId: "main-run",
          status: "running",
          failure: {
            class: "provider_error",
            code: "provider.rate-limit",
            message: "Organization TPD rate limit exceeded",
          },
        },
      ],
    });
    const blocked = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [root],
    });
    NodeAssert.equal(blocked.counts.blocked, 1);
    NodeAssert.notEqual(blocked.plan[0].status, "completed");
    NodeAssert.equal(blocked.quota.length, 1);
    const waiting = projection("main", "parent", "claudeAgent", "running", {
      runtimeRequests: [{ id: "approve", kind: "command", status: "pending", runId: "main-run" }],
      turnItems: [{ type: "approval_request", requestId: "approve", prompt: "Run the test?" }],
    });
    const s = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [waiting],
    });
    NodeAssert.equal(s.counts.waiting, 1);
    NodeAssert.equal(s.approvals[0].requestId, "approve");
    NodeAssert.notEqual(s.plan[0].status, "completed");
  },
);
NodeTest.test(
  "only the bound task family is included; unrelated requests and quoted errors are excluded",
  () => {
    const root = projection("main", "parent", "claudeAgent", "running", {
      turnItems: [
        { type: "assistant_message", runId: "main-run", text: "Organization quota exceeded" },
      ],
    });
    const foreign = projection("other", "unrelated", "codex", "running", {
      runtimeRequests: [{ id: "foreign", kind: "command", status: "pending" }],
    });
    const s = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [root, foreign],
    });
    NodeAssert.equal(s.rows.length, 1);
    NodeAssert.equal(s.approvals.length, 0);
    NodeAssert.equal(s.quota.length, 0);
    NodeAssert.throws(
      () => workSnapshot({ parentThreadId: "wrong", rootThreadId: "main", projections: [root] }),
      /parent|bound/i,
    );
  },
);
NodeTest.test(
  "approval freshness includes the native action identity, not only its displayed prompt",
  () => {
    const p = projection("main", "parent", "claudeAgent", "running", {
      runtimeRequests: [
        { id: "a", kind: "command", status: "pending", nativeRequestRef: { nativeId: "tool-1" } },
      ],
      turnItems: [
        { type: "approval_request", requestId: "a", runId: "main-run", prompt: "Proceed?" },
        {
          type: "dynamic_tool",
          nativeItemRef: { nativeId: "tool-1" },
          toolName: "read_file",
          input: { path: "fixture" },
        },
      ],
    });
    const snapshot = () =>
      workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
    const original = snapshot().approvals[0].fingerprint;
    p.turnItems[1].toolName = "delete_file";
    NodeAssert.notEqual(snapshot().approvals[0].fingerprint, original);
  },
);
NodeTest.test(
  "an incomplete family is explicitly disclosed rather than silently reporting full coverage",
  () => {
    const p = projection("main", "parent", "claudeAgent");
    const s = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [p],
      incomplete: true,
    });
    NodeAssert.equal(s.incomplete, true);
    NodeAssert.ok(
      s.plan.some((x) => x.content.includes("outside the live overview") && x.status === "pending"),
    );
  },
);
NodeTest.test(
  "main-chat milestones show team state changes without repeating every activity tick",
  async () => {
    const { teamMilestone } = await import("../progress.mjs");
    const snap = {
      rows: [
        {
          threadId: "1",
          title: "Build checkout",
          provider: "Claude",
          state: "running",
          activity: "Editing files",
        },
        {
          threadId: "2",
          title: "Check accessibility",
          provider: "Codex",
          state: "waiting",
          activity: "Waiting for your response",
        },
      ],
      counts: { running: 1, waiting: 1, blocked: 0, completed: 0 },
    };
    NodeAssert.match(teamMilestone(snap), /1 working · 1 waiting/);
    NodeAssert.match(teamMilestone(snap), /- \[ \] Check accessibility/);
    NodeAssert.equal(teamMilestone(snap, snap), "");
    const done = {
      ...snap,
      rows: snap.rows.map((r) => ({ ...r, state: "completed", activity: "Finished" })),
      counts: { running: 0, waiting: 0, blocked: 0, completed: 2 },
    };
    NodeAssert.match(teamMilestone(done, snap), /- \[x\] Check accessibility/);
  },
);
NodeTest.test(
  "a provider that produced a new response after a rate-limit retry is no longer marked quota-blocked",
  () => {
    const p = projection("main", "parent", "kimi-api", "running", {
      turnItems: [
        {
          type: "error",
          runId: "main-run",
          ordinal: 10,
          failure: {
            class: "provider_error",
            code: "provider.rate-limit",
            message: "organization TPD rate limit exceeded",
          },
        },
        {
          type: "assistant_message",
          runId: "main-run",
          ordinal: 11,
          text: "Continuing the requested implementation.",
        },
      ],
    });
    const s = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
    NodeAssert.equal(s.quota.length, 0);
    NodeAssert.equal(s.counts.blocked, 0);
    NodeAssert.equal(s.counts.running, 1);
  },
);

NodeTest.test("terminal typed usage limits remain blocked and retain structured evidence", () => {
  for (const provider of [
    "claudeAgent",
    "codex",
    "grok",
    "antigravity",
    "deepseek-api",
    "kimi-api",
  ]) {
    const failure = {
      class: "usage_limit",
      code: "api_error_429",
      message: "Provider allowance unavailable",
    };
    const p = projection("main", "parent", provider, "failed", {
      turnItems: [{ type: "error", runId: "main-run", ordinal: 4, failure }],
    });
    const s = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
    NodeAssert.equal(s.quota.length, 1, provider);
    NodeAssert.deepEqual(s.quota[0].failure, failure);
    NodeAssert.equal(s.counts.blocked, 1);
    NodeAssert.notEqual(s.plan[0].status, "completed");
  }
});

NodeTest.test(
  "agent rows preserve exact run model and effort and current-run checklist states",
  () => {
    const p = projection("main", "parent", "grok", "completed", {
      runs: [
        {
          id: "main-run",
          ordinal: 2,
          status: "completed",
          providerInstanceId: "grok",
          modelSelection: {
            model: "grok-4.7",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
          completedAt: "2026-11-02T20:00:00Z",
        },
      ],
      plans: [
        { runId: "old", status: "active", steps: [{ text: "Old plan", status: "completed" }] },
        {
          runId: "main-run",
          status: "completed",
          steps: [
            { id: "one", text: "Inspect form", status: "completed" },
            { id: "two", text: "Implement errors", status: "running" },
            { id: "three", text: "Check result", status: "pending" },
          ],
        },
      ],
      turnItems: [
        {
          id: "old",
          type: "file_search",
          runId: "old",
          title: "Do not include old tools",
          status: "completed",
        },
      ],
    });
    const snap = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
    const row = snap.rows[0];
    NodeAssert.equal(row.model, "grok-4.7");
    NodeAssert.equal(row.effort, "high");
    NodeAssert.deepEqual(
      row.steps.map((s) => s.status),
      ["completed", "in_progress", "pending"],
    );
    NodeAssert.ok(!row.steps.some((s) => /Old|old/.test(s.content)));
    NodeAssert.equal(row.completedAt, "2026-11-02T20:00:00Z");
  },
);
NodeTest.test(
  "observed tool checks exclude previous runs and failed commands never receive a success check",
  () => {
    const p = projection("main", "parent", "codex", "running", {
      turnItems: [
        {
          id: "old",
          runId: "old",
          type: "file_search",
          status: "completed",
          ordinal: 1,
          title: "Old search",
        },
        {
          id: "read",
          runId: "main-run",
          type: "file_search",
          status: "completed",
          ordinal: 2,
          title: "Read signup",
        },
        {
          id: "test",
          runId: "main-run",
          type: "command_execution",
          status: "completed",
          exitCode: 1,
          ordinal: 3,
          title: "Run tests",
        },
        {
          id: "edit",
          runId: "main-run",
          type: "file_change",
          status: "running",
          ordinal: 4,
          title: "Add validation",
        },
      ],
    });
    const row = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] })
      .rows[0];
    NodeAssert.deepEqual(
      row.steps.map((s) => [s.content, s.status]),
      [
        ["Read signup", "completed"],
        ["Run tests", "failed"],
        ["Add validation", "in_progress"],
      ],
    );
    NodeAssert.equal(row.effort, "Provider default");
  },
);
NodeTest.test(
  "native and app-owned specialists retain hierarchy without counting router wrappers",
  () => {
    const root = projection("main", "parent", "claudeAgent", "running", {
      subagents: [
        { id: "wrapper", origin: "app_owned", childThreadId: "router", status: "running" },
        {
          id: "native",
          runId: "main-run",
          origin: "provider_native",
          childThreadId: null,
          title: "Check labels",
          providerInstanceId: "claudeAgent",
          status: "running",
          progress: "Inspecting labels",
          model: null,
        },
        {
          id: "old-native",
          runId: "old",
          origin: "provider_native",
          childThreadId: null,
          title: "Old specialist",
          status: "running",
        },
      ],
    });
    const router = projection("router", "main", "jev-auto", "running", {
      subagents: [{ origin: "app_owned", childThreadId: "worker", status: "running" }],
    });
    const worker = projection("worker", "router", "grok", "running");
    const s = workSnapshot({
      parentThreadId: "parent",
      rootThreadId: "main",
      projections: [root, router, worker],
    });
    NodeAssert.equal(s.rows.length, 3);
    NodeAssert.equal(s.counts.running, 3);
    NodeAssert.equal(s.rows.find((r) => r.threadId === "worker").parentThreadId, "main");
    const native = s.rows.find((r) => r.title === "Check labels");
    NodeAssert.equal(native.parentThreadId, "main");
    NodeAssert.equal(native.model, null);
    NodeAssert.equal(native.effort, "Not reported");
  },
);

NodeTest.test(
  "a finished run's checklist does not invent completion for unfinished plan steps",
  () => {
    const p = projection("main", "parent", "codex", "completed", {
      plans: [
        {
          runId: "main-run",
          status: "active",
          steps: [{ id: "pending", text: "Deploy", status: "pending" }],
        },
      ],
    });
    const s = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
    NodeAssert.equal(s.rows[0].steps[0].status, "pending");
  },
);

NodeTest.test(
  "the team input stays within T3's wire limit, retains parents and has a readable old-client fallback",
  async () => {
    const progress = await import("../progress.mjs");
    const rows = Array.from({ length: 30 }, (_, i) => ({
      threadId: "row-" + i,
      parentThreadId: i ? "row-0" : null,
      title: "Review " + i,
      provider: "Grok",
      model: "grok-4.7",
      effort: "high",
      state: i ? "completed" : "running",
      activity: "Inspecting signup",
      steps: Array.from({ length: 12 }, (_, j) => ({
        id: "step-" + j,
        content: "界".repeat(180),
        status: j ? "completed" : "in_progress",
      })),
      updatedAt: null,
      completedAt: null,
      result: null,
    }));
    const input = progress.teamInput?.({ rows, incomplete: false }, true);
    NodeAssert.equal(input?.kind, "jev.team.v1");
    NodeAssert.ok(Buffer.byteLength(JSON.stringify(input), "utf8") <= 14000);
    NodeAssert.equal(input.incomplete, true);
    const ids = new Set(input.rows.map((r) => r.threadId));
    NodeAssert.ok(input.rows.every((r) => r.parentThreadId === null || ids.has(r.parentThreadId)));
    const text = progress.teamMarkdown?.(input) ?? "";
    NodeAssert.match(text, /grok-4.7/);
    NodeAssert.match(text, /high/);
    NodeAssert.match(text, /Working on/);
    NodeAssert.match(text, /- \[x\]/);
    NodeAssert.equal(progress.teamInput?.({ rows: [], incomplete: false }, false)?.updating, false);
  },
);

NodeTest.test("long checklists keep the current step visible and disclose omitted history", () => {
  const p = projection("main", "parent", "codex", "running", {
    plans: [
      {
        runId: "main-run",
        status: "active",
        steps: Array.from({ length: 20 }, (_, i) => ({
          id: String(i),
          text: "Step " + i,
          status: i === 18 ? "running" : i < 18 ? "completed" : "pending",
        })),
      },
    ],
  });
  const s = workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] });
  NodeAssert.ok(
    s.rows[0].steps.some((step) => step.content === "Step 18" && step.status === "in_progress"),
  );
  NodeAssert.equal(s.incomplete, true);
});

NodeTest.test("a completed MCP call reporting isError is displayed as a failed step", () => {
  const p = projection("main", "parent", "codex", "running", {
    turnItems: [
      {
        id: "mcp",
        runId: "main-run",
        type: "dynamic_tool",
        status: "completed",
        title: "Browser check",
        output: { isError: true },
      },
    ],
  });
  NodeAssert.equal(
    workSnapshot({ parentThreadId: "parent", rootThreadId: "main", projections: [p] }).rows[0]
      .steps[0].status,
    "failed",
  );
});
