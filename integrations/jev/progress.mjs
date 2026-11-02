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
function effort(selection, fallback = "Provider default") {
  const values = (selection?.options ?? [])
    .filter((o) => /^(?:effort|reasoningEffort|thinking_level|variant)$/i.test(o.id))
    .map((o) => o.value)
    .filter((v) => typeof v === "string");
  return values.length ? values.join(", ") : fallback;
}
function currentSteps(p, run) {
  const plan = p.plans?.findLast(
    (x) => x.runId === run?.id && x.steps && x.status !== "superseded",
  );
  if (plan) {
    const active = plan.steps.findIndex((step) => ["running", "in_progress"].includes(step.status));
    const start = Math.max(0, Math.min(active < 0 ? 0 : active - 4, plan.steps.length - 12));
    return plan.steps.slice(start, start + 12).map((step, index) => ({
      id: String(step.id ?? `plan-${index}`),
      content: clean(step.content ?? step.step ?? step.text, "Task step"),
      status:
        step.status === "running"
          ? "in_progress"
          : ["completed", "in_progress", "pending"].includes(step.status)
            ? step.status
            : "pending",
    }));
  }
  return (p.turnItems ?? [])
    .filter(
      (i) =>
        i.runId === run?.id &&
        ["command_execution", "file_change", "file_search", "web_search", "dynamic_tool"].includes(
          i.type,
        ),
    )
    .slice(-8)
    .map((item, index) => ({
      id: String(item.id ?? `activity-${index}`),
      content: activity(item),
      status:
        item.status === "failed" ||
        (item.type === "command_execution" && item.exitCode != null && item.exitCode !== 0) ||
        item.outputIndicatesFailure === true ||
        item.output?.isError === true
          ? "failed"
          : item.status === "completed"
            ? "completed"
            : ["cancelled", "interrupted"].includes(item.status)
              ? "cancelled"
              : item.status === "running"
                ? "in_progress"
                : "pending",
    }));
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
    if (
      (p.plans?.findLast((x) => x.runId === run?.id && x.steps && x.status !== "superseded")?.steps
        .length ?? 0) > 12
    )
      incomplete = true;
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
          i.runId === run?.id &&
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
      model: run?.modelSelection?.model ?? p.thread.modelSelection?.model ?? null,
      effort: effort(run?.modelSelection ?? p.thread.modelSelection),
      parentThreadId:
        p.thread.id === rootThreadId ? null : (p.thread.lineage?.parentThreadId ?? null),
      state,
      activity: observed,
      steps: currentSteps(p, run),
      updatedAt: recent?.updatedAt ?? run?.updatedAt ?? run?.completedAt ?? null,
      completedAt: run?.completedAt ?? null,
      result:
        state === "completed"
          ? ((p.turnItems ?? [])
              .findLast((i) => i.runId === run?.id && i.type === "assistant_message")
              ?.text?.slice(0, 600) ?? null)
          : null,
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
    for (const step of rows.at(-1).steps) {
      plan.push({
        content: `${title}: ${step.content}`,
        priority: "medium",
        status: ["completed", "in_progress"].includes(step.status) ? step.status : "pending",
      });
    }
    for (const child of p.subagents ?? []) {
      if (child.origin !== "provider_native" || child.childThreadId || child.runId !== run?.id)
        continue;
      const childState =
        child.status === "completed"
          ? "completed"
          : ["failed", "cancelled", "interrupted"].includes(child.status)
            ? "failed"
            : ["waiting", "pending", "idle"].includes(child.status)
              ? "waiting"
              : "running";
      counts[childState]++;
      rows.push({
        threadId: `native:${p.thread.id}:${child.id}`,
        parentThreadId: p.thread.id,
        title: clean(child.title, "Native specialist"),
        provider: providerName(child.providerInstanceId ?? provider),
        model: child.modelSelection?.model ?? child.model ?? null,
        effort: effort(child.modelSelection, "Not reported"),
        state: childState,
        activity: clean(
          child.progress,
          childState === "completed"
            ? "Finished"
            : childState === "waiting"
              ? "Waiting"
              : childState === "failed"
                ? "Stopped / failed"
                : "Working",
        ),
        steps: [],
        updatedAt: child.updatedAt ?? null,
        completedAt: child.completedAt ?? null,
        result: childState === "completed" ? (child.result?.slice(0, 600) ?? null) : null,
      });
    }
  }
  const rowIds = new Set(rows.map((row) => row.threadId));
  for (const row of rows) {
    const seen = new Set([row.threadId]);
    while (row.parentThreadId && !rowIds.has(row.parentThreadId)) {
      if (seen.has(row.parentThreadId)) {
        row.parentThreadId = null;
        break;
      }
      seen.add(row.parentThreadId);
      row.parentThreadId = family.get(row.parentThreadId)?.thread.lineage?.parentThreadId ?? null;
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

export function teamInput(snapshot, updating = true) {
  const text = (value, length = 600) => String(value ?? "").slice(0, length);
  const date = (value) =>
    typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
  const id = (value) =>
    "agent:" + NodeCrypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 32);
  const rows = snapshot.rows.slice(0, 30).map((row) => ({
    threadId: id(row.threadId),
    parentThreadId: row.parentThreadId ? id(row.parentThreadId) : null,
    title: text(row.title, 180),
    provider: text(row.provider, 180),
    model: row.model ? text(row.model, 300) : null,
    effort: text(row.effort ?? "Provider default", 180),
    state: row.state,
    activity: text(row.activity, 180),
    steps: (row.steps ?? []).slice(0, 12).map((step, index) => ({
      id: `${index}:${text(step.id, 200)}`,
      content: text(step.content, 180),
      status: step.status,
    })),
    updatedAt: date(row.updatedAt),
    completedAt: date(row.completedAt),
    result: row.result ? text(row.result) : null,
  }));
  const result = {
    kind: "jev.team.v1",
    updating,
    incomplete: !!snapshot.incomplete || snapshot.rows.length > rows.length,
    rows,
  };
  while (Buffer.byteLength(JSON.stringify(result), "utf8") >= 14000) {
    result.incomplete = true;
    if (rows.length > 1) rows.pop();
    else if (rows[0]?.steps.length) {
      const removable = rows[0].steps.findLastIndex((step) => step.status !== "in_progress");
      rows[0].steps.splice(removable >= 0 ? removable : rows[0].steps.length - 1, 1);
    } else break;
  }
  const ids = new Set(rows.map((row) => row.threadId));
  for (const row of rows) if (!ids.has(row.parentThreadId)) row.parentThreadId = null;
  return result;
}

export function teamMarkdown(input) {
  const escape = (value) =>
    String(value ?? "")
      .replace(/\s+/g, " ")
      .replace(/([\\`*_{}[\]<>#|])/g, "\\$1");
  return [
    "### Agent activity",
    ...input.rows.flatMap((row) => [
      `**${escape(row.title)}** · ${escape(row.provider)} · ${escape(row.model ?? "Model not reported")} · ${escape(row.effort)}`,
      `**${{ running: "Working on", waiting: "Waiting", blocked: "Blocked", completed: "Done", failed: "Stopped / failed" }[row.state]}:** ${escape(row.activity)}`,
      ...row.steps.map(
        (step) =>
          `- [${step.status === "completed" ? "x" : " "}] ${step.status === "in_progress" ? "**Working on:** " : step.status === "failed" ? "**Failed:** " : step.status === "cancelled" ? "**Stopped:** " : ""}${escape(step.content)}`,
      ),
      ...(row.result ? [`Result: ${escape(row.result)}`] : []),
      "",
    ]),
    ...(input.incomplete ? ["Some activity is outside this overview."] : []),
    ...(!input.updating &&
    input.rows.some((row) => ["running", "waiting", "blocked"].includes(row.state))
      ? ["Live updates paused. Send /jev-status to reconnect to the same work."]
      : []),
  ].join("\n\n");
}
