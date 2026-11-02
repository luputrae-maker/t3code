import * as NodeCrypto from "node:crypto";
import { quotaEvidence } from "./policy.mjs";
import { providerName } from "./presentation.mjs";

const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const clean = (s, fallback = "Working") =>
  String(s ?? fallback)
    .replace(/\[jev-subtask:v1\]/g, "")
    .replace(/(?:thread|node|run):delegated-task:\S+/g, "work item")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180) || fallback;
const latest = (p) =>
  (p.runs ?? []).reduce((a, b) => (!a || (b.ordinal ?? 0) > (a.ordinal ?? 0) ? b : a), null);
function activity(item) {
  if (!item) return "Waiting for the next update";
  if (item.title) return clean(item.title);
  if (item.type === "command_execution")
    return /(?:--test|pytest|vitest|jest|test:)/i.test(item.input ?? "")
      ? "Running tests or checks"
      : "Running a command";
  return (
    {
      file_change: "Editing files",
      file_search: "Inspecting project files",
      web_search: "Researching sources",
      reasoning: "Working through the task",
      assistant_message: "Preparing the result",
      dynamic_tool: clean(
        item.toolName?.replace(/^mcp__[^_]+__/, "").replaceAll("_", " "),
        "Using a tool",
      ),
    }[item.type] ?? "Working"
  );
}
function requestRecord(p, request) {
  const item = (p.turnItems ?? []).find((i) => i.requestId === request.id);
  if (!item) return null;
  const nativeId = request.nativeRequestRef?.nativeId;
  const tool = (p.turnItems ?? []).find(
    (i) =>
      nativeId &&
      i.nativeItemRef?.nativeId === nativeId &&
      i.type !== "approval_request" &&
      i.type !== "user_input_request",
  );
  const prompt = item.prompt ?? item.question ?? item.title ?? "Permission requested by this agent";
  const frozen = {
    threadId: p.thread.id,
    requestId: request.id,
    runId: item.runId ?? latest(p)?.id,
    prompt,
    toolInput: tool?.input ?? null,
    questions: item.questions ?? null,
    kind: request.kind,
    nativeRequestRef: request.nativeRequestRef ?? null,
    action: tool
      ? { type: tool.type, name: tool.toolName ?? null, nativeItemRef: tool.nativeItemRef ?? null }
      : null,
  };
  return {
    ...frozen,
    kind: request.kind,
    title: clean(p.thread.title, "Agent"),
    fingerprint: NodeCrypto.createHash("sha256").update(JSON.stringify(frozen)).digest("hex"),
  };
}
export function workSnapshot({ parentThreadId, rootThreadId, projections, incomplete = false }) {
  const all = new Map(projections.map((p) => [p.thread.id, p]));
  const root = all.get(rootThreadId);
  if (!root || root.thread.lineage?.parentThreadId !== parentThreadId)
    throw Error("Progress root is not bound to this parent");
  const family = new Map();
  const visit = (id, parent) => {
    if (family.has(id)) return;
    if (family.size >= 30) {
      incomplete = true;
      return;
    }
    const p = all.get(id);
    if (!p || p.thread.lineage?.parentThreadId !== parent) return;
    family.set(id, p);
    for (const task of p.subagents ?? []) if (task.childThreadId) visit(task.childThreadId, id);
  };
  visit(rootThreadId, parentThreadId);
  const rows = [],
    plan = [],
    approvals = [],
    questions = [],
    quota = [];
  const counts = { running: 0, waiting: 0, blocked: 0, completed: 0, failed: 0 };
  for (const p of family.values()) {
    const run = latest(p),
      pending = (p.runtimeRequests ?? []).filter((r) => r.status === "pending");
    const failures = (p.turnItems ?? []).filter(
      (i) =>
        quotaEvidence({ items: [i] }, run?.id) &&
        !(p.turnItems ?? []).some(
          (later) =>
            later.runId === run?.id &&
            ["assistant_message", "reasoning"].includes(later.type) &&
            later.ordinal > i.ordinal,
        ),
    );
    for (const r of pending) {
      const record = requestRecord(p, r);
      if (record) (record.questions ? questions : approvals).push(record);
    }
    for (const f of failures)
      if (!["cancelled", "interrupted"].includes(run?.status))
        quota.push({
          threadId: p.thread.id,
          runId: run?.id,
          message: f.failure?.message ?? f.text ?? f.title,
          failure: f.failure,
          retry: f.retry,
        });
    const provider = run?.providerInstanceId ?? p.thread.modelSelection?.instanceId;
    if (provider === "jev-auto") continue; // Routers are not additional working models.
    const childWork = (p.subagents ?? []).filter((t) =>
      ["running", "queued", "waiting", "cancel_requested"].includes(t.status),
    );
    const state = pending.length
      ? "waiting"
      : failures.length && !["cancelled", "interrupted"].includes(run?.status)
        ? "blocked"
        : run?.status === "completed" && childWork.length
          ? "waiting"
          : run?.status === "completed"
            ? "completed"
            : terminal.has(run?.status)
              ? "failed"
              : run?.status === "queued"
                ? "waiting"
                : "running";
    counts[state]++;
    const title = clean(p.thread.title, p.thread.id === rootThreadId ? "Main agent" : "Specialist");
    const recent = (p.turnItems ?? [])
      .filter(
        (i) =>
          i.type !== "approval_request" &&
          i.type !== "user_input_request" &&
          i.type !== "checkpoint",
      )
      .at(-1);
    const observed =
      state === "waiting"
        ? pending.length
          ? "Waiting for your response"
          : childWork.length
            ? `Waiting for ${childWork.length} specialist task(s)`
            : "Queued"
        : state === "blocked"
          ? "Provider usage limit"
          : state === "completed"
            ? "Finished"
            : state === "failed"
              ? run?.status === "interrupted"
                ? "Stopped"
                : "Failed"
              : activity(recent);
    rows.push({
      threadId: p.thread.id,
      title,
      provider: providerName(provider),
      model: run?.modelSelection?.model ?? p.thread.modelSelection?.model,
      state,
      activity: observed,
    });
    const label = {
      running: "Working",
      waiting: "Waiting",
      blocked: "Blocked",
      completed: "Done",
      failed: "Stopped / failed",
    }[state];
    plan.push({
      content: `${title} · ${providerName(provider)} — ${label}: ${observed}`,
      priority: "medium",
      status: state === "completed" ? "completed" : state === "running" ? "in_progress" : "pending",
    });
    for (const step of p.plans?.findLast((x) => x.steps && x.status !== "superseded")?.steps ??
      []) {
      plan.push({
        content: `${title}: ${clean(step.content ?? step.step ?? step.text, "Task step")}`,
        priority: "medium",
        status:
          step.status === "running"
            ? "in_progress"
            : ["completed", "in_progress", "pending"].includes(step.status)
              ? step.status
              : "pending",
      });
    }
  }
  if (incomplete)
    plan.push({
      content:
        "Some specialist tasks are outside the live overview. Open the full work view for their remaining approvals.",
      priority: "high",
      status: "pending",
    });
  return {
    rows,
    plan,
    counts,
    approvals,
    questions,
    quota,
    incomplete,
    threadIds: [...family.keys()],
  };
}

// Main-chat milestones remain readable even when T3 collapses its tool activity.
// Tool-by-tool updates stay in the native checklist; only task-state changes add prose.
export function teamMilestone(snapshot, previous) {
  const before = new Map((previous?.rows ?? []).map((r) => [r.threadId, r.state]));
  const changed = snapshot.rows.filter((r) => before.get(r.threadId) !== r.state);
  if (!changed.length) return "";
  if (
    snapshot.rows.length === 1 &&
    !["waiting", "blocked"].includes(snapshot.rows[0].state) &&
    !["waiting", "blocked"].includes(before.get(snapshot.rows[0].threadId))
  )
    return "";
  const c = snapshot.counts;
  const heading = `**Team update${snapshot.incomplete ? " (partial)" : ""}:** ${c.running} working · ${c.waiting} waiting · ${c.blocked} blocked · ${c.completed} done`;
  return (
    "\n" +
    heading +
    "\n\n" +
    changed
      .map(
        (r) =>
          `- [${r.state === "completed" ? "x" : " "}] ${r.title} · ${r.provider} — ${r.activity}`,
      )
      .join("\n") +
    "\n\n"
  );
}
