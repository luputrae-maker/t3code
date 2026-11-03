import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import * as NodeReadline from "node:readline";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { candidates, quotaEvidence, quiescent } from "./policy.mjs";
import { route } from "./routing.mjs";
import {
  userRequest,
  taskTitle,
  routeMessage,
  workMessage,
  providerName,
} from "./presentation.mjs";
import { isLeafRequest, selectedSkills, workflowBrief } from "./workflow.mjs";
import { ClientChannel } from "./client-channel.mjs";
import { HostClient, localHostOptions } from "./host-client.mjs";
import { monitorTask } from "./monitor.mjs";
import { beginQuestion, answerQuestion, questionPrompt } from "./question-flow.mjs";
import { approvalToolCall } from "./approval-relay.mjs";
import { teamMilestone, teamInput, teamMarkdown } from "./progress.mjs";
const root = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const stateDir =
  process.env.JEV_T3_STATE ??
  NodePath.join(NodeOS.homedir(), "Library/Application Support/JevT3/router");
NodeFS.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const sessions = new Map();
const bridges = new Set();
const active = new Set();
const locks = new Set();
const shownWork = new Map();
const write = (x) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...x }) + "\n");
const clientChannel = new ClientChannel(write);
const liveHosts = new Set();
const config = () =>
  JSON.parse(
    NodeFS.readFileSync(process.env.JEV_T3_CONFIG ?? NodePath.join(root, "config.json"), "utf8"),
  );
const sessionFile = (id) => {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error("Invalid session");
  return NodePath.join(stateDir, id + ".json");
};
function save(s) {
  const f = sessionFile(s.id),
    tmp = f + ".tmp";
  NodeFS.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  NodeFS.renameSync(tmp, f);
}
function claim(id) {
  const f = sessionFile(id) + ".lock";
  if (locks.has(f)) return;
  try {
    const owner = Number(NodeFS.readFileSync(f, "utf8"));
    try {
      process.kill(owner, 0);
      throw Error("Session is owned by another running ACP process");
    } catch (e) {
      if (e.code !== "ESRCH") throw e;
    }
    NodeFS.unlinkSync(f);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const fd = NodeFS.openSync(f, "wx", 0o600);
  NodeFS.writeFileSync(fd, String(process.pid));
  NodeFS.closeSync(fd);
  locks.add(f);
}
function load(id) {
  if (!sessions.has(id)) {
    let s;
    try {
      s = JSON.parse(NodeFS.readFileSync(sessionFile(id), "utf8"));
    } catch {
      throw Error("Unknown session");
    }
    claim(id);
    sessions.set(id, s);
  }
  return sessions.get(id);
}
function emit(id, text) {
  write({
    method: "session/update",
    params: {
      sessionId: id,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}
function emitWork(s, result) {
  const message = workMessage(result, s.pending?.link);
  if (shownWork.get(s.id) !== message) {
    emit(s.id, message);
    shownWork.set(s.id, message);
  }
}
function sessionUpdate(s, update) {
  write({ method: "session/update", params: { sessionId: s.id, update } });
}
async function monitoredStatus(s, b, result) {
  const ui = config().ui;
  if (!ui?.enabled || !result.childThreadId) return result;
  if (!s.hostParentThreadId) {
    const c = await b.call("orchestrator_capabilities", {});
    s.hostParentThreadId = c.parentThreadId;
    save(s);
  }
  if (!s.hostParentThreadId) return result;
  const host = new HostClient(localHostOptions(ui));
  liveHosts.add(host);
  const teamId = "jev-team-" + s.pending.requestId;
  let signature,
    started = false,
    previousTeam,
    lastSnapshot;
  try {
    const relay = await host.isTopLevelProxy(s.hostParentThreadId);
    const monitored = await monitorTask({
      host,
      parentThreadId: s.hostParentThreadId,
      rootThreadId: result.childThreadId,
      readStatus: () => b.call("task_status", { taskId: s.pending.taskId }),
      cancelled: () => !!s.cancelled,
      relay,
      update: (snapshot) => {
        lastSnapshot = snapshot;
        const compact = {
          rows: snapshot.rows.map(({ threadId: _threadId, ...row }) => row),
          plan: snapshot.plan,
          counts: snapshot.counts,
          incomplete: snapshot.incomplete,
        };
        const next = JSON.stringify(compact);
        if (next === signature) return;
        signature = next;
        const milestone = teamMilestone(snapshot, previousTeam);
        if (milestone) emit(s.id, milestone);
        previousTeam = snapshot;
        sessionUpdate(s, { sessionUpdate: "plan", entries: snapshot.plan.slice(0, 50) });
        const c = snapshot.counts;
        const title = `Team${snapshot.incomplete ? " (partial)" : ""} · ${c.running} working · ${c.waiting} waiting · ${c.blocked} blocked · ${c.completed} done`;
        const view = teamInput(snapshot);
        const body = teamMarkdown(view);
        sessionUpdate(s, {
          sessionUpdate: started ? "tool_call_update" : "tool_call",
          toolCallId: teamId,
          title,
          kind: "other",
          status: "in_progress",
          rawInput: view,
          content: [{ type: "content", content: { type: "text", text: body } }],
        });
        started = true;
      },
      askPermission: async (request) => {
        const toolCall = approvalToolCall(request),
          toolCallId = toolCall.toolCallId;
        sessionUpdate(s, { sessionUpdate: "tool_call", ...toolCall });
        const answer = await clientChannel.requestPermission(s.id, toolCall);
        sessionUpdate(s, {
          sessionUpdate: "tool_call_update",
          toolCallId,
          status: answer?.outcome?.outcome === "selected" ? "completed" : "failed",
        });
        return answer;
      },
    });
    if (started)
      sessionUpdate(s, {
        sessionUpdate: "tool_call_update",
        toolCallId: teamId,
        ...(lastSnapshot ? { rawInput: teamInput(lastSnapshot, false) } : {}),
        status:
          monitored.status === "completed"
            ? "completed"
            : monitored.status === "failed"
              ? "failed"
              : "pending",
      });
    return monitored;
  } catch {
    if (started && lastSnapshot)
      sessionUpdate(s, {
        sessionUpdate: "tool_call_update",
        toolCallId: teamId,
        status: "pending",
        rawInput: teamInput(lastSnapshot, false),
      });
    emit(
      s.id,
      "The live task view is unavailable. Your task is preserved. Send `/jev-status` here to reconnect, or use its work link.\n\n",
    );
    return { ...result, uiUnavailable: true };
  } finally {
    host.close();
    liveHosts.delete(host);
    clientChannel.cancel(s.id);
  }
}
class Bridge {
  constructor(spec) {
    this.n = 0;
    this.closed = false;
    this.pending = new Map();
    const env = { ...process.env };
    for (const e of spec.env ?? []) env[e.name] = e.value;
    this.child = NodeChildProcess.spawn(spec.command, spec.args ?? [], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    bridges.add(this);
    this.child.stderr.resume();
    NodeReadline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      try {
        const m = JSON.parse(line),
          p = this.pending.get(m.id);
        if (p) {
          this.pending.delete(m.id);
          clearTimeout(p.timer);
          if (m.error) p.reject(Error("T3 MCP request rejected: " + (m.error.code ?? "error")));
          else p.resolve(m.result);
        }
      } catch {}
    });
    this.child.on("error", () => this.fail());
    this.child.on("exit", () => this.fail());
    this.child.stdin.on("error", () => this.fail());
  }
  fail() {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("T3 MCP connection ended; dispatch outcome may be unknown"));
    }
    this.pending.clear();
    for (const [id, b] of connections) if (b === this) connections.delete(id);
    bridges.delete(this);
  }
  request(method, params) {
    if (this.closed)
      return Promise.reject(Error("T3 MCP connection ended; reload session to reconnect"));
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("T3 MCP response timeout; do not redispatch automatically"));
      }, 660000);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (e) => {
        if (e) this.fail();
      });
    });
  }
  async init() {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "jev-auto", version: "0.1.0" },
    });
    this.child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
    );
  }
  async call(name, args) {
    const r = await this.request("tools/call", { name, arguments: args });
    let v = r.structuredContent;
    if (v === undefined) {
      const text = r.content
        ?.filter((x) => x.type === "text")
        .map((x) => x.text)
        .join("\n");
      try {
        v = JSON.parse(text);
      } catch {
        throw Error("T3 returned an unreadable tool result");
      }
    }
    if (r.isError || v?.error) throw Error("T3 tool failed: " + (v?.code ?? name));
    return v;
  }
  close() {
    this.fail();
    this.child.stdin.end();
    this.child.kill();
    bridges.delete(this);
  }
}
const connections = new Map();
async function connect(s, servers) {
  let b = connections.get(s.id);
  if (b && !b.closed) return b;
  const spec = servers.find((x) => /t3/i.test(x.name));
  if (!spec) throw Error("T3 MCP bridge is required");
  b = new Bridge(spec);
  await b.init();
  connections.set(s.id, b);
  return b;
}
function jevKey() {
  if (process.env.TYPESAFE_API_KEY) return process.env.TYPESAFE_API_KEY;
  try {
    const a = JSON.parse(
      NodeFS.readFileSync(NodePath.join(NodeOS.homedir(), ".pi/agent/auth.json"), "utf8"),
    );
    if (a.typesafe?.key) return a.typesafe.key;
  } catch {}
  try {
    return NodeChildProcess.execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", "ai-router.jev", "-a", "JEV_API_KEY", "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 8000 },
    ).trim();
  } catch {
    throw Error("Existing Jev credential is unavailable");
  }
}
async function choose(s, pool, prompt) {
  const started = Date.now();
  const selected = await route(
    pool,
    {
      request: userRequest(prompt).slice(0, 18000),
      leaf: !!s.leaf || isLeafRequest(userRequest(prompt)),
      interactionMode: s.interactionMode ?? "default",
      history: s.history.slice(-4).map((h) => ({
        request: userRequest(h.request).slice(0, 4000),
        answer: h.answer.slice(-4000),
      })),
    },
    async (body) => {
      const r = await fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + jevKey(),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw Error("Jev request failed (HTTP " + r.status + ")");
      return await r.json();
    },
  );
  if (s.interactionMode === "plan" || s.handoff?.scope === "plan_only") {
    selected.scope = "plan_only";
    if (selected.collaboration === "parallel_build") selected.collaboration = "parallel_read";
  }
  s.lastRoute = {
    ...selected,
    plannedSkills: selectedSkills(selected).map((s) => s.name),
    routingMs: Date.now() - started,
    at: new Date().toISOString(),
  };
  save(s);
  const { constraints: _constraints, ...audit } = s.lastRoute;
  NodeFS.appendFileSync(
    NodePath.join(stateDir, "decisions.ndjson"),
    JSON.stringify({
      sessionId: s.id,
      requestHash: NodeCrypto.createHash("sha256").update(userRequest(prompt)).digest("hex"),
      ...audit,
    }) + "\n",
    { mode: 0o600 },
  );
  return selected;
}
function advertiseCommands(s) {
  sessionUpdate(s, {
    sessionUpdate: "available_commands_update",
    availableCommands: [
      {
        name: "plan",
        description: "Plan without implementation until /build",
        input: { hint: "Optional task to plan" },
      },
      {
        name: "build",
        description: "Return to implementation using T3 permissions",
        input: { hint: "Optional task to implement" },
      },
      { name: "jev-status", description: "Show the attached task without launching work" },
    ],
  });
}
function setupResult(s) {
  return {
    sessionId: s.id,
    models: {
      currentModelId: "auto",
      availableModels: [{ modelId: "auto", name: "Jev Auto — model and effort" }],
    },
    // Explicitly replace previously advertised modes in T3's cached discovery.
    // This informational mode never changes the native permission policy.
    modes: {
      currentModeId: "supervised",
      availableModes: [
        {
          id: "supervised",
          name: "Use T3 permissions",
          description: "Use the Permissions setting in T3’s composer.",
        },
      ],
    },
    configOptions: [
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "auto",
        options: [{ value: "auto", name: "Jev Auto" }],
      },
    ],
  };
}
async function confirmStop(s, b) {
  if (!s.pending?.taskId) return !s.pending;
  await b.call("task_cancel", {
    taskId: s.pending.taskId,
    reason: "Stop before any further execution",
    clientRequestId: s.pending.requestId + "-cancel",
  });
  let r = await b.call("task_status", { taskId: s.pending.taskId });
  if (!quiescent(r) && r.childThreadId) {
    await b.call("t3_thread_wait", {
      threadId: r.childThreadId,
      timeoutMs: 30000,
    });
    r = await b.call("task_status", { taskId: s.pending.taskId });
  }
  if (!quiescent(r)) return false;
  s.pending = null;
  save(s);
  return true;
}
async function finish(s, b, result, { allowFallback = true } = {}) {
  if (result.uiQuestions?.length) {
    const question = result.uiQuestions[0];
    if (s.awaitingQuestion?.request.fingerprint !== question.fingerprint)
      s.awaitingQuestion = beginQuestion(question);
    save(s);
    emit(s.id, questionPrompt(s.awaitingQuestion));
    return true;
  }
  if (result.uiDeferred) {
    emit(
      s.id,
      "The approval is still pending. Your work is preserved; send another message here to show it again.\n\n",
    );
    return true;
  }
  if (
    !result.pendingApproval &&
    !result.hasPendingQuestion &&
    result.childThreadId &&
    (["completed", "failed", "waiting"].includes(result.status) || result.uiQuota)
  ) {
    const read = await b.call("t3_thread_read", {
      threadId: result.childThreadId,
      view: "activity",
      limit: 100,
      runLimit: 1,
    });
    if (
      quotaEvidence(read, s.pending.runId) ||
      quotaEvidence({ items: result.uiQuotaEvidence }, s.pending.runId)
    ) {
      if (!allowFallback) {
        emit(
          s.id,
          "The current provider reported a usage limit. Send ‘continue’ to let Jev resume with another available connection.\n\n",
        );
        return true;
      }
      const previous = { ...s.pending };
      if (!quiescent(result) && !(await confirmStop(s, b))) {
        emit(s.id, "Provider limited; waiting for its child work to stop before handoff.");
        return true;
      }
      s.cooldowns[previous.providerInstanceId] = Date.now() + 30 * 60000;
      s.handoff = {
        threadId: result.childThreadId,
        scope: previous.scope,
        text:
          `The ${providerName(previous.providerInstanceId)} provider connection running ${previous.model} reported a usage limit. This evidence applies only to that connection; do not infer another subscription or a weekly/global limit.\n` +
          JSON.stringify(read).slice(-12000),
      };
      s.pending = null;
      save(s);
      emit(
        s.id,
        `\n${providerName(previous.providerInstanceId)} reached a usage limit. Jev is choosing another available provider to continue.\n\n`,
      );
      return false;
    }
  }
  if (result.status === "completed" && quiescent(result)) {
    delete s.awaitingQuestion;
    const text =
      result.summary ??
      result.latestTerminalSummary ??
      "Task completed. Open the child thread for its result.";
    s.history.push({
      request: s.request,
      answer: text.slice(-16000),
      childThreadId: result.childThreadId,
    });
    s.pending = null;
    s.attempts = 0;
    save(s);
    emit(s.id, "\n**Status:** Finished.\n\n" + text + "\n\n");
    return true;
  }
  if (["cancelled", "interrupted"].includes(result.status) && quiescent(result)) {
    s.pending = null;
    save(s);
    emit(s.id, "Task stopped.");
    return true;
  }
  if (result.status === "failed" && quiescent(result)) {
    s.pending = null;
    save(s);
    throw Error(
      "Selected agent failed. See its child thread; no automatic retry for ordinary failures.",
    );
  }
  emitWork(s, result);
  return true;
}
function nextRequest(s, text) {
  s.request = text;
  s.attempts = 0;
  s.handoff = null;
  save(s);
}
async function prompt(s, p) {
  const b = connections.get(s.id);
  if (!b) throw Error("T3 MCP connection is missing; reload this session");
  if (active.has(s.id)) throw Error("This session already has an active request");
  active.add(s.id);
  try {
    if (p.prompt.some((x) => x.type !== "text"))
      throw Error(
        "Jev Auto currently supports text requests; select a native provider for attachments",
      );
    let text = p.prompt.map((x) => x.text).join("\n");
    s.leaf = !!s.leaf || isLeafRequest(userRequest(text));
    s.queue ??= [];
    const completion =
      /^Delegated tasks? [\s\S]*?(?:reached (?:a )?terminal states?\.| \[(?:completed|failed|cancelled|interrupted)\](?::\r?\n|\. Use task_status\b))/.test(
        userRequest(text),
      );
    if (userRequest(text).trim() === "/jev-status") {
      if (s.awaitingQuestion) {
        emit(s.id, questionPrompt(s.awaitingQuestion));
        return { stopReason: "end_turn" };
      }
      if (s.pending?.taskId) {
        let status = await b.call("task_status", { taskId: s.pending.taskId });
        if (config().ui?.enabled && status.childThreadId)
          status = await monitoredStatus(s, b, status);
        if (status.uiQuota)
          emit(
            s.id,
            "The current provider reported a usage limit. Send ‘continue’ to let Jev resume with another available connection.\n\n",
          );
        else if (status.uiQuestions || quiescent(status))
          await finish(s, b, status, { allowFallback: false });
        else emit(s.id, workMessage(status, s.pending.link));
      } else emit(s.id, "Jev is ready. There is no delegated task attached to this chat.\n\n");
      return { stopReason: "end_turn" };
    }
    const modeCommand = /^\/\s*(plan|build)(?:\s+([\s\S]*))?$/.exec(userRequest(text).trim());
    if (modeCommand) {
      if (s.pending || s.awaitingQuestion) {
        emit(
          s.id,
          "Finish or cancel the attached task before changing its planning mode. Your current work is still attached.\n\n",
        );
        return { stopReason: "end_turn" };
      }
      s.interactionMode = modeCommand[1] === "plan" ? "plan" : "default";
      save(s);
      emit(
        s.id,
        s.interactionMode === "plan"
          ? "Planning mode is on. Jev will inspect and prepare a plan without implementing changes. Use /build when you want implementation.\n\n"
          : "Build mode is on. Jev will use your existing T3 permissions.\n\n",
      );
      text = modeCommand[2]?.trim() ?? "";
      if (!text) return { stopReason: "end_turn" };
    }
    if (s.awaitingQuestion && !completion && s.pending?.taskId) {
      if (/^\/?(?:stop|cancel|never mind)[.!]?$/i.test(userRequest(text).trim())) {
        s.cancelled = true;
        const stopped = await confirmStop(s, b);
        delete s.awaitingQuestion;
        save(s);
        emit(
          s.id,
          stopped
            ? "Stopped.\n\n"
            : "Stop requested. Waiting for the current task to stop; no replacement will start yet.\n\n",
        );
        return { stopReason: "cancelled" };
      }
      const status = await b.call("task_status", { taskId: s.pending.taskId });
      const host = new HostClient(localHostOptions(config().ui ?? {}));
      let current;
      try {
        const snapshot = await host.snapshot(s.hostParentThreadId, status.childThreadId);
        current = snapshot.questions.find(
          (q) =>
            q.requestId === s.awaitingQuestion.request.requestId &&
            q.fingerprint === s.awaitingQuestion.request.fingerprint,
        );
      } finally {
        host.close();
      }
      if (current) {
        const answer = answerQuestion(s.awaitingQuestion, userRequest(text));
        if (answer.error) {
          emit(s.id, answer.error + "\n\n" + questionPrompt(s.awaitingQuestion));
          return { stopReason: "end_turn" };
        }
        s.awaitingQuestion = answer.flow;
        save(s);
        if (!answer.done) {
          emit(s.id, questionPrompt(s.awaitingQuestion));
          return { stopReason: "end_turn" };
        }
        await b.call("t3_pending_request", {
          action: "respond",
          threadId: current.threadId,
          requestId: current.requestId,
          answers: s.awaitingQuestion.answers,
        });
        emit(s.id, "Your answer has been sent. Continuing the same task.\n\n");
      } else emit(s.id, "That question was already resolved. Checking the task.\n\n");
      delete s.awaitingQuestion;
      save(s);
      text = "";
    }
    if (s.cancelled) {
      if (s.pending && !(await confirmStop(s, b)))
        throw Error("Previous child is still stopping. No new task was started.");
      s.cancelled = false;
      save(s);
    }
    if (s.pending && !s.pending.taskId) {
      const recovery = /^\/jev-recover\s+(\S+)\s*$/.exec(text);
      if (!recovery)
        throw Error(
          "Dispatch outcome unknown. Inspect the T3 child, then use /jev-recover TASK_ID to reattach without dispatching again.",
        );
      const r = await b.call("task_status", { taskId: recovery[1] });
      s.pending.taskId = r.taskId;
      s.pending.runId = r.childRunId;
      save(s);
      text = "";
    }
    if (completion && !s.pending) return { stopReason: "end_turn" };
    if (s.pending) {
      if (text && !completion) s.queue.push(text);
      save(s);
      let status = await b.call("task_status", { taskId: s.pending.taskId });
      if (config().ui?.enabled && status.childThreadId)
        status = await monitoredStatus(s, b, status);
      if (await finish(s, b, status)) {
        if (s.pending || !s.queue.length) return { stopReason: "end_turn" };
        nextRequest(s, s.queue.shift());
      }
    } else nextRequest(s, text);
    for (; s.attempts < 6;) {
      const c = config();
      const catalog = await b.call("orchestrator_capabilities", {});
      s.hostParentThreadId = catalog.parentThreadId ?? s.hostParentThreadId;
      const pool = candidates(
        catalog,
        c.allowedInstances,
        s.cooldowns,
        Date.now(),
        c.modelAllowlist,
      );
      const target = await choose(s, pool, s.request);
      emit(s.id, routeMessage(target));
      if (s.cancelled) return { stopReason: "cancelled" };
      const requestId = NodeCrypto.randomUUID();
      s.pending = { ...target, requestId, taskId: null };
      s.attempts++;
      save(s);
      const context = s.history
        .slice(-4)
        .map(
          (h) =>
            `Previous request: ${h.request}\nResult: ${h.answer}\nT3 history thread: ${h.childThreadId}`,
        )
        .join("\n\n");
      const task = [
        workflowBrief(target),
        "Write the user-facing answer in clear, easy-to-scan Markdown. Lead with the direct answer or result. Use short paragraphs with blank lines; keep bullets short. For substantial reports, use a few descriptive headings, a brief verdict first, then evidence and next actions. Explain technical terms in everyday language. Follow the user's requested format, including presentation-style output when requested. State what you actually did and verified, and anything blocked or needing their answer. Use descriptive link labels for supplied T3 work links; keep raw task/thread identifiers out of prose. Never claim an agent is objectively best or that checks ran without evidence.",
        context,
        s.handoff
          ? `Continue work from T3 thread ${s.handoff.threadId}. Inspect existing files and completed commands before taking action; avoid repeating completed external effects. Prior activity:\n${s.handoff.text}`
          : "",
        s.request,
      ]
        .filter(Boolean)
        .join("\n\n")
        .slice(-110000);
      let result;
      try {
        result = await b.call("delegate_task", {
          task,
          target: {
            providerInstanceId: target.providerInstanceId,
            model: target.model,
            options: target.options,
          },
          title: taskTitle(s.request),
          isolation: "shared",
          mode: "async",
          ...(target.scope === "plan_only" ? { interactionMode: "plan" } : {}),
          clientRequestId: requestId,
        });
      } catch (e) {
        emit(s.id, "Dispatch outcome is unknown. Check T3 child threads before continuing.");
        throw e;
      }
      s.pending.taskId = result.taskId;
      s.pending.runId = result.childRunId;
      s.pending.childThreadId = result.childThreadId;
      s.pending.link = result.link;
      save(s);
      if (s.cancelled) {
        await confirmStop(s, b);
        return { stopReason: "cancelled" };
      }
      emitWork(s, result);
      if (config().ui?.enabled && result.childThreadId) {
        result = await monitoredStatus(s, b, result);
      } else if (result.childThreadId && ["running", "queued"].includes(result.status)) {
        await b.call("t3_thread_wait", {
          threadId: result.childThreadId,
          // The HTTP bridge expires long before the previous ten-minute wait.
          timeoutMs: 30000,
        });
        result = await b.call("task_status", { taskId: result.taskId });
      }
      if (s.cancelled) {
        await confirmStop(s, b);
        return { stopReason: "cancelled" };
      }
      if (await finish(s, b, result)) {
        if (s.pending || !s.queue.length) return { stopReason: "end_turn" };
        nextRequest(s, s.queue.shift());
      }
    }
    throw Error("All configured fallback attempts exhausted");
  } finally {
    shownWork.delete(s.id);
    active.delete(s.id);
    save(s);
  }
}
async function handle(m) {
  const p = m.params ?? {};
  switch (m.method) {
    case "initialize":
      return {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {},
          mcpCapabilities: {},
        },
        agentInfo: { name: "Jev Auto", version: "0.4.3" },
        authMethods: [],
      };
    case "session/new": {
      const s = {
        id: NodeCrypto.randomUUID(),
        cwd: p.cwd,
        history: [],
        queue: [],
        pending: null,
        cooldowns: {},
        attempts: 0,
      };
      claim(s.id);
      sessions.set(s.id, s);
      save(s);
      if (p.mcpServers?.length) await connect(s, p.mcpServers);
      advertiseCommands(s);
      return setupResult(s);
    }
    case "session/load": {
      if (active.has(p.sessionId))
        throw Error("Session is actively executing and cannot be reloaded");
      const s = load(p.sessionId);
      await connect(s, p.mcpServers ?? []);
      advertiseCommands(s);
      return setupResult(s);
    }
    case "session/set_model":
      if (p.modelId !== "auto") throw Error("Only auto is supported");
      return {};
    case "session/set_mode":
      // Accept saved legacy selections without changing T3's native permission policy.
      if (!["supervised", "ask", "auto"].includes(p.modeId))
        throw Error("Use T3’s Permissions control");
      return {};
    case "session/set_config_option":
      return { configOptions: setupResult(load(p.sessionId)).configOptions };
    case "session/prompt":
      return prompt(load(p.sessionId), p);
    case "session/cancel": {
      const s = load(p.sessionId),
        b = connections.get(s.id);
      s.cancelled = true;
      clientChannel.cancel(s.id);
      save(s);
      if (s.pending?.taskId && b)
        await b.call("task_cancel", {
          taskId: s.pending.taskId,
          reason: "User cancelled Jev Auto",
          clientRequestId: s.pending.requestId + "-cancel",
        });
      return {};
    }
    default:
      throw Error("Unsupported ACP method");
  }
}
const input = NodeReadline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (clientChannel.handle(m)) return;
  Promise.resolve()
    .then(() => handle(m))
    .then((result) => {
      if (m.id !== undefined) write({ id: m.id, result });
    })
    .catch((error) => {
      if (m.id !== undefined) write({ id: m.id, error: { code: -32602, message: error.message } });
    });
});
function cleanup() {
  clientChannel.cancel();
  for (const host of liveHosts) host.close();
  for (const b of bridges) b.close();
  for (const f of locks) {
    try {
      NodeFS.unlinkSync(f);
    } catch {}
  }
  locks.clear();
}
input.on("close", cleanup);
process.on("exit", cleanup);
