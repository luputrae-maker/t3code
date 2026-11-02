import * as NodeReadline from "node:readline";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
let n = Number(process.env.FIXTURE_EXISTING_TASK ?? 0),
  waiter,
  cancelled = false,
  statusCalls = 0;
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
const tools = {
  orchestrator_capabilities: () => ({
    providers: ["codex", "claudeAgent"].map((providerInstanceId) => ({
      providerInstanceId,
      canRunChildTask: true,
      models: [{ id: "fixture-model" }],
    })),
  }),
  delegate_task: (args) => {
    if (process.env.FIXTURE_CAPTURE_TASKS === "1")
      NodeFS.appendFileSync(
        NodePath.join(process.env.JEV_T3_STATE, "delegated-tasks.ndjson"),
        JSON.stringify(args) + "\n",
      );
    return {
      taskId: "task-" + ++n,
      childThreadId: "child-" + n,
      link: "<t3-thread://v2/fixture/child-" + n + ">",
      childRunId: "run-" + n,
      status: "running",
      hasPendingChildRuns: false,
    };
  },
  task_status: () => ({
    taskId: "task-" + n,
    childThreadId: "child-" + n,
    childRunId: "run-" + n,
    status: cancelled
      ? "cancelled"
      : n === 1 && process.env.FIXTURE_COMPLETED_QUOTA !== "1"
        ? "failed"
        : "completed",
    summary: n === 1 ? "usage limit reached" : "FALLBACK_OK",
    hasPendingChildRuns: false,
  }),
  t3_thread_read: () => ({
    items:
      n > 1 || (process.env.FIXTURE_PENDING === "1" && statusCalls > 1)
        ? []
        : [
            {
              runId: "run-" + n,
              type: process.env.FIXTURE_TYPED_QUOTA === "1" ? "error" : "system_notice",
              ...(process.env.FIXTURE_TYPED_QUOTA === "1"
                ? {
                    failure: {
                      class: "usage_limit",
                      code: "api_error_429",
                      message: "Allowance unavailable",
                    },
                    text: undefined,
                  }
                : {}),
              creationSource: "provider",
              createdBy: "system",
              text:
                process.env.FIXTURE_TYPED_QUOTA === "1" ? undefined : "Claude usage limit reached",
            },
          ],
  }),
  task_cancel: () => {
    cancelled = true;
    if (waiter) {
      reply(waiter, {
        content: [{ type: "text", text: JSON.stringify({ status: "cancelled" }) }],
      });
      waiter = null;
    }
    return { status: "cancel_requested" };
  },
};
NodeReadline.createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize")
    return reply(m.id, { protocolVersion: "2025-06-18", capabilities: {} });
  if (m.params.name === "t3_thread_wait") {
    if (process.env.FIXTURE_LONG_RUNNING === "1") {
      if (m.params.arguments.timeoutMs >= 300000) {
        process.stdout.write(
          JSON.stringify({
            jsonrpc: "2.0",
            id: m.id,
            error: { code: -32603, message: "T3 bridge request exceeded its HTTP deadline" },
          }) + "\n",
        );
        return;
      }
      return reply(m.id, {
        content: [{ type: "text", text: JSON.stringify({ status: "running", timedOut: true }) }],
      });
    }
    if (process.env.FIXTURE_CANCEL === "1" && !cancelled) {
      waiter = m.id;
      return;
    }
    return reply(m.id, {
      content: [{ type: "text", text: '{"status":"completed"}' }],
    });
  }
  let result = tools[m.params.name]?.(m.params.arguments);
  if (m.params.name === "task_status" && process.env.FIXTURE_LONG_RUNNING === "1") {
    result = { ...result, status: "running", summary: undefined };
  }
  if (m.params.name === "task_status" && process.env.FIXTURE_PENDING === "1") {
    statusCalls++;
    result = {
      ...result,
      status: statusCalls === 1 ? "waiting" : "completed",
      hasPendingQuestion: statusCalls === 1,
      summary: "FALLBACK_OK",
    };
  }
  if (m.params.name === "task_status" && process.env.FIXTURE_UNCONFIRMED === "1" && cancelled)
    result = { ...result, status: "running" };
  reply(m.id, {
    content: [{ type: "text", text: JSON.stringify(result ?? {}) }],
  });
});
