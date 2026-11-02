import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeEvents from "node:events";
const root = NodeURL.fileURLToPath(new URL("../", import.meta.url));
async function client(cancel = false, extraEnv = {}, existing = null) {
  const state =
    existing?.state ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-execution-"));
  const fixtureConfig = NodePath.join(state, "test-config.json");
  NodeFS.writeFileSync(
    fixtureConfig,
    JSON.stringify({ allowedInstances: ["codex", "claudeAgent"], ui: { enabled: false } }),
  );
  const p = NodeChildProcess.spawn(
    process.execPath,
    ["--import", NodePath.join(root, "tests/fake-jev.mjs"), NodePath.join(root, "agent.mjs")],
    {
      env: {
        ...process.env,
        JEV_T3_STATE: state,
        JEV_T3_CONFIG: fixtureConfig,
        TYPESAFE_API_KEY: "fixture",
        FIXTURE_CANCEL: cancel ? "1" : "0",
        ...extraEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const pending = new Map(),
    messages = [];
  let id = 0;
  const lines = NodeReadline.createInterface({ input: p.stdout });
  lines.on("line", (line) => {
    const m = JSON.parse(line);
    messages.push(m);
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const call = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  await call("initialize", {});
  const created = await call(existing ? "session/load" : "session/new", {
    ...(existing ? { sessionId: existing.sessionId } : {}),
    cwd: state,
    mcpServers: [
      {
        name: "t3",
        command: process.execPath,
        args: [NodePath.join(root, "tests/fake-mcp.mjs")],
        env: [],
      },
    ],
  });
  return {
    p,
    call,
    messages,
    waitForMessage: (predicate) => {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => {
        const onLine = (line) => {
          const message = JSON.parse(line);
          if (predicate(message)) {
            lines.off("line", onLine);
            resolve(message);
          }
        };
        lines.on("line", onLine);
      });
    },
    state,
    sessionId: created.result.sessionId,
    stopPreservingState: async () => {
      const exited = NodeEvents.once(p, "exit");
      p.stdin.end();
      await exited;
      lines.close();
    },
    close: () => {
      p.stdin.end();
      p.kill();
      lines.close();
      NodeFS.rmSync(state, { recursive: true, force: true });
    },
  };
}
NodeTest.test(
  "quota switches to another provider and preserves the request without repeating first runner",
  async () => {
    const c = await client();
    try {
      const r = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Fixture task" }],
      });
      NodeAssert.equal(r.result.stopReason, "end_turn");
      const text = c.messages.map((m) => m.params?.update?.content?.text ?? "").join("");
      NodeAssert.match(text, /Codex/);
      NodeAssert.match(text, /Claude/);
      NodeAssert.match(text, /FALLBACK_OK/);
      NodeAssert.match(text, /\*\*Status:\*\* Finished\.\n\nFALLBACK_OK/);
      NodeAssert.match(text, /\[Open live work\]\(t3-thread:\/\/v2\/fixture\/child-1\)/);
      NodeAssert.doesNotMatch(text, /Execution started in|child thread child-|claudeAgent/);
      const state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.cooldowns.codex, 1_700_001_800_000);
      NodeAssert.equal(state.pending, null);
      const audit = NodeFS.readFileSync(NodePath.join(c.state, "decisions.ndjson"), "utf8");
      NodeAssert.doesNotMatch(audit, /Fixture task/);
      NodeAssert.equal(audit.trim().split("\n").length, 2);
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "a status check never launches a provider job, including while a child is attached",
  async () => {
    const c = await client(false, { FIXTURE_LONG_RUNNING: "1" });
    try {
      const invoke = (text) =>
        c.call("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text }] });
      await invoke("/jev-status");
      let s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(s.lastRoute, undefined);
      NodeAssert.equal(s.history.length, 0);
      await invoke("Keep this task running");
      const before = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      const response = await invoke(
        "<t3_code_instructions>Harness</t3_code_instructions>\n<user_request>/jev-status</user_request>\n<runtime_info>Native harness</runtime_info>\n<pull_request_linking>PR rules</pull_request_linking>",
      );
      NodeAssert.equal(response.error, undefined);
      s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.deepEqual(s.queue, []);
      NodeAssert.equal(s.pending.taskId, before.pending.taskId);
      NodeAssert.equal(s.attempts, before.attempts);
      NodeAssert.equal(s.history.length, 0);
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "the actual native delegation receives Jev’s workflow and existing skill paths with the original planning-only request",
  async () => {
    const c = await client(false, {
      FIXTURE_JEV_KIND: "planning",
      FIXTURE_JEV_STACK: "expo",
      FIXTURE_JEV_TEAM: "parallel_read",
      FIXTURE_JEV_SCOPE: "plan_only",
      FIXTURE_CAPTURE_TASKS: "1",
      FIXTURE_LONG_RUNNING: "1",
    });
    try {
      const request =
        "Planning only: prepare the Expo checkout implementation plan. Do not edit application files.";
      const response = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: request }],
      });
      NodeAssert.equal(response.error, undefined);
      const args = JSON.parse(
        NodeFS.readFileSync(NodePath.join(c.state, "delegated-tasks.ndjson"), "utf8").trim(),
      );
      NodeAssert.match(args.task, /Jev work brief/);
      NodeAssert.match(args.task, /Work type: planning; platform: expo/);
      NodeAssert.match(args.task, /t3-builder:/);
      NodeAssert.ok(args.task.endsWith(request));
      NodeAssert.equal(args.interactionMode, "plan");
      const s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(s.lastRoute.collaboration, "parallel_read");
      NodeAssert.ok(s.lastRoute.plannedSkills.includes("startup-workflow"));
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "a leaf role survives session replacement and an unmarked follow-up stays solo",
  async () => {
    const original = await client(false, {
      FIXTURE_PENDING: "1",
      FIXTURE_JEV_TEAM: "parallel_build",
    });
    let replacement;
    try {
      const call = (text) =>
        original.call("session/prompt", {
          sessionId: original.sessionId,
          prompt: [{ type: "text", text }],
        });
      await call("[jev-subtask:v1]\nInspect this module");
      await call("Delegated task task-1 (Inspect) [completed]:\nDone.");
      await original.stopPreservingState();
      replacement = await client(
        false,
        { FIXTURE_LONG_RUNNING: "1", FIXTURE_JEV_TEAM: "parallel_build" },
        { state: original.state, sessionId: original.sessionId },
      );
      const r = await replacement.call("session/prompt", {
        sessionId: original.sessionId,
        prompt: [{ type: "text", text: "Review the second module too" }],
      });
      NodeAssert.equal(r.error, undefined);
      const s = JSON.parse(
        NodeFS.readFileSync(NodePath.join(original.state, original.sessionId + ".json")),
      );
      NodeAssert.equal(s.leaf, true);
      NodeAssert.equal(s.lastRoute.leaf, true);
      NodeAssert.equal(s.lastRoute.collaboration, "solo");
    } finally {
      replacement?.close();
      original.close();
    }
  },
);
NodeTest.test(
  "a replacement ACP process resumes the saved child and status does not redispatch it",
  async () => {
    const original = await client(false, { FIXTURE_LONG_RUNNING: "1" });
    let replacement;
    try {
      await original.call("session/prompt", {
        sessionId: original.sessionId,
        prompt: [{ type: "text", text: "Original work must not repeat" }],
      });
      const before = JSON.parse(
        NodeFS.readFileSync(NodePath.join(original.state, original.sessionId + ".json")),
      );
      await original.stopPreservingState();
      replacement = await client(
        false,
        { FIXTURE_LONG_RUNNING: "1", FIXTURE_EXISTING_TASK: "1" },
        { state: original.state, sessionId: original.sessionId },
      );
      const response = await replacement.call("session/prompt", {
        sessionId: replacement.sessionId,
        prompt: [{ type: "text", text: "/jev-status" }],
      });
      NodeAssert.equal(response.error, undefined);
      const after = JSON.parse(
        NodeFS.readFileSync(NodePath.join(original.state, original.sessionId + ".json")),
      );
      NodeAssert.equal(after.pending.taskId, before.pending.taskId);
      NodeAssert.equal(after.request, before.request);
      NodeAssert.equal(after.attempts, before.attempts);
      NodeAssert.deepEqual(after.queue, []);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(original.state, "decisions.ndjson"), "utf8")
          .trim()
          .split("\n").length,
        1,
      );
      const text = replacement.messages.map((m) => m.params?.update?.content?.text ?? "").join("");
      NodeAssert.match(text, /Working/);
      NodeAssert.doesNotMatch(text, /Agent:/);
    } finally {
      replacement?.close();
      original.close();
    }
  },
);
NodeTest.test("cancellation stops the persisted child and never starts a fallback", async () => {
  const c = await client(true);
  try {
    const running = c.call("session/prompt", {
      sessionId: c.sessionId,
      prompt: [{ type: "text", text: "Fixture task" }],
    });
    await c.waitForMessage((m) => m.params?.update?.content?.text?.includes("Working."));
    await c.call("session/cancel", { sessionId: c.sessionId });
    const r = await running;
    NodeAssert.equal(r.result.stopReason, "cancelled");
    NodeAssert.equal(
      c.messages.filter((m) => m.params?.update?.content?.text?.includes("**Agent:**")).length,
      1,
    );
  } finally {
    c.close();
  }
});
NodeTest.test(
  "a new request after a waiting child is preserved and routed after completion",
  async () => {
    const c = await client(false, { FIXTURE_PENDING: "1" });
    try {
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "First task" }],
      });
      const r = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "New request must survive" }],
      });
      NodeAssert.equal(r.result.stopReason, "end_turn");
      const s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(s.history.at(-1).request, "New request must survive");
      NodeAssert.equal(s.pending, null);
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "unconfirmed cancellation retains the child id and blocks another writer",
  async () => {
    const c = await client(true, { FIXTURE_UNCONFIRMED: "1" });
    try {
      const running = c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "First task" }],
      });
      const timer = setInterval(() => {
        if (c.messages.some((m) => m.params?.update?.content?.text?.includes("Working."))) {
          clearInterval(timer);
          c.call("session/cancel", { sessionId: c.sessionId });
        }
      }, 5);
      const first = await running;
      clearInterval(timer);
      NodeAssert.equal(first.result.stopReason, "cancelled");
      const s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(s.pending.taskId, "task-1");
      const next = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Second task" }],
      });
      NodeAssert.match(next.error.message, /still stopping/);
      NodeAssert.equal(
        c.messages.filter((m) => m.params?.update?.content?.text?.includes("**Agent:**")).length,
        1,
      );
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "a child that outlives a safe bridge wait stays attached without failing the parent",
  async () => {
    const c = await client(false, { FIXTURE_LONG_RUNNING: "1" });
    try {
      const result = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Long running task" }],
      });
      NodeAssert.equal(result.error, undefined);
      NodeAssert.equal(result.result.stopReason, "end_turn");
      const state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.pending.taskId, "task-1");
      NodeAssert.equal(state.history.length, 0);
      NodeAssert.equal(
        c.messages.filter((m) => m.params?.update?.content?.text?.includes("**Agent:**")).length,
        1,
      );
      NodeAssert.equal(
        c.messages.filter((m) => m.params?.update?.content?.text?.includes("**Status:** Working."))
          .length,
        1,
      );
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "native completion envelopes settle once without queuing or delegating the completion notice",
  async () => {
    const c = await client(false, { FIXTURE_PENDING: "1" });
    try {
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Original user work" }],
      });
      const notice =
        "<t3_code_instructions>Native instructions</t3_code_instructions>\n<user_request>\nDelegated task task-1 (Original title) [completed]:\nFALLBACK_OK\n</user_request>\n<runtime_info>Native metadata</runtime_info>\n<pull_request_linking>PR rules</pull_request_linking>";
      for (let n = 0; n < 2; n++)
        await c.call("session/prompt", {
          sessionId: c.sessionId,
          prompt: [{ type: "text", text: notice }],
        });
      const s = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(s.history.length, 1);
      NodeAssert.equal(s.history[0].request, "Original user work");
      NodeAssert.equal(s.pending, null);
      NodeAssert.deepEqual(s.queue, []);
      NodeAssert.equal(
        NodeFS.readFileSync(NodePath.join(c.state, "decisions.ndjson"), "utf8").trim().split("\n")
          .length,
        1,
      );
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "T3 completion notices settle the original task and repeated delivery never starts another task",
  async () => {
    const c = await client(false, { FIXTURE_PENDING: "1" });
    try {
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Original user request" }],
      });
      const notice =
        "Delegated task task-1 (A task title\nwith a newline) [completed]:\nWork completed.";
      const result = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: notice }],
      });
      NodeAssert.equal(result.result.stopReason, "end_turn");
      const state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.pending, null);
      NodeAssert.equal(state.history.length, 1);
      NodeAssert.equal(state.history[0].request, "Original user request");
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: notice }],
      });
      NodeAssert.equal(
        c.messages.filter((m) => m.params?.update?.content?.text?.includes("**Agent:**")).length,
        1,
      );
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "completion notices without an inline result read the saved task instead of delegating the notice",
  async () => {
    const c = await client(false, { FIXTURE_PENDING: "1" });
    try {
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Original user request" }],
      });
      await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [
          {
            type: "text",
            text: "Delegated task task-1 (Long result) [completed]. Use task_status with taskId task-1 to read the result.",
          },
        ],
      });
      const state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.history.length, 1);
      NodeAssert.equal(state.history[0].request, "Original user request");
      NodeAssert.equal(state.pending, null);
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "saved legacy modes cannot override T3 native permissions or escalate the child",
  async () => {
    for (const mode of ["ask", "auto"]) {
      const c = await client(false, { FIXTURE_CAPTURE_TASKS: "1", FIXTURE_LONG_RUNNING: "1" });
      try {
        const changed = await c.call("session/set_mode", { sessionId: c.sessionId, modeId: mode });
        NodeAssert.equal(changed.error, undefined);
        const run = await c.call("session/prompt", {
          sessionId: c.sessionId,
          prompt: [{ type: "text", text: "Perform the fixture work" }],
        });
        NodeAssert.equal(run.error, undefined);
        const args = JSON.parse(
          NodeFS.readFileSync(NodePath.join(c.state, "delegated-tasks.ndjson"), "utf8").trim(),
        );
        NodeAssert.equal(args.runtimeMode, undefined);
      } finally {
        c.close();
      }
    }
  },
);

NodeTest.test(
  "completed typed quota failures switch instead of becoming successful answers",
  async () => {
    const c = await client(false, {
      FIXTURE_COMPLETED_QUOTA: "1",
      FIXTURE_TYPED_QUOTA: "1",
      FIXTURE_CAPTURE_TASKS: "1",
    });
    try {
      const result = await c.call("session/prompt", {
        sessionId: c.sessionId,
        prompt: [{ type: "text", text: "Continue my original work" }],
      });
      NodeAssert.equal(result.error, undefined);
      const tasks = NodeFS.readFileSync(NodePath.join(c.state, "delegated-tasks.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      NodeAssert.equal(tasks.length, 2);
      NodeAssert.match(tasks[1].task, /Continue my original work/);
      NodeAssert.match(tasks[1].task, /Codex.*connection/);
      const state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.history.at(-1).answer, "FALLBACK_OK");
    } finally {
      c.close();
    }
  },
);
NodeTest.test(
  "explicit plan mode survives a quota handoff, reload, and changes only on build",
  async () => {
    const c = await client(false, {
      FIXTURE_CAPTURE_TASKS: "1",
      FIXTURE_JEV_SCOPE: "execute",
      FIXTURE_JEV_TEAM: "parallel_build",
    });
    let replacement;
    try {
      const invoke = (text) =>
        c.call("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text }] });
      await invoke("/plan Design checkout");
      const tasks = NodeFS.readFileSync(NodePath.join(c.state, "delegated-tasks.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      NodeAssert.equal(tasks.length, 2);
      for (const task of tasks) {
        NodeAssert.equal(task.interactionMode, "plan");
        NodeAssert.match(task.task, /Do not edit project files/);
        NodeAssert.ok(task.task.endsWith("Design checkout"));
      }
      let state = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
      NodeAssert.equal(state.lastRoute.scope, "plan_only");
      NodeAssert.notEqual(state.lastRoute.collaboration, "parallel_build");
      await c.stopPreservingState();
      replacement = await client(
        false,
        { FIXTURE_CAPTURE_TASKS: "1", FIXTURE_EXISTING_TASK: "2", FIXTURE_JEV_SCOPE: "execute" },
        { state: c.state, sessionId: c.sessionId },
      );
      const send = (text) =>
        replacement.call("session/prompt", {
          sessionId: c.sessionId,
          prompt: [{ type: "text", text }],
        });
      await send("/plan");
      await send("Check the payment edge cases");
      await send("/build");
      await send("Implement the approved checkout");
      const all = NodeFS.readFileSync(NodePath.join(c.state, "delegated-tasks.ndjson"), "utf8")
        .trim()
        .split("\n")
        .map(JSON.parse);
      NodeAssert.equal(all.length, 4);
      NodeAssert.equal(all[2].interactionMode, "plan");
      NodeAssert.equal(all[3].interactionMode, undefined);
      NodeAssert.ok(
        replacement.messages.some(
          (m) =>
            m.params?.update?.sessionUpdate === "available_commands_update" &&
            m.params.update.availableCommands.some((c) => c.name === "plan"),
        ),
      );
    } finally {
      replacement?.close();
      c.close();
    }
  },
);
NodeTest.test("mode commands leave attached work and permissions untouched", async () => {
  const c = await client(false, { FIXTURE_CAPTURE_TASKS: "1", FIXTURE_LONG_RUNNING: "1" });
  try {
    const invoke = (text) =>
      c.call("session/prompt", { sessionId: c.sessionId, prompt: [{ type: "text", text }] });
    await invoke("Keep working");
    const before = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
    await invoke("/plan");
    const after = JSON.parse(NodeFS.readFileSync(NodePath.join(c.state, c.sessionId + ".json")));
    NodeAssert.equal(after.pending.taskId, before.pending.taskId);
    NodeAssert.deepEqual(after.queue, []);
    NodeAssert.equal(after.interactionMode, before.interactionMode);
  } finally {
    c.close();
  }
});
