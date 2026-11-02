import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import WebSocket from "ws";
import { antigravityQuotaEvidence } from "./native-quota.mjs";
import { workSnapshot } from "./progress.mjs";

export function localHostOptions(config = {}) {
  const url = new URL(config.url ?? "ws://127.0.0.1:3773/ws?orchestrationProtocol=2");
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.protocol !== "ws:" ||
    url.username ||
    url.password
  )
    throw Error("The T3 UI bridge requires a local loopback endpoint");
  const installed = NodePath.join(
    NodeOS.homedir(),
    ".t3/bin",
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone ACP tooling has no Effect runtime.
    process.platform === "win32" ? "t3.exe" : "t3",
  );
  return {
    url: url.toString(),
    cli: config.cli ?? (NodeFS.existsSync(installed) ? installed : "t3"),
    baseDir: config.baseDir,
    scopes: ["orchestration:read"],
  };
}
export class HostClient {
  constructor(options) {
    const local = localHostOptions(options);
    this.options = { ...options, ...local, scopes: options.scopes ?? local.scopes };
    this.n = 0;
    this.pending = new Map();
    this.watched = new Set();
    this.closed = false;
    this.dirty = true;
    this.waiters = new Set();
  }
  changed() {
    this.dirty = true;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }
  async waitForChange(ms = 5000) {
    const throttle = Math.max(0, 1500 - (Date.now() - (this.lastSnapshotAt ?? 0)));
    if (throttle) await new Promise((resolve) => setTimeout(resolve, throttle));
    if (this.closed || this.dirty) {
      this.dirty = false;
      return;
    }
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        this.dirty = false;
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }
  async connect() {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const args = [
        "auth",
        "session",
        "issue",
        ...this.options.scopes.flatMap((s) => ["--scope", s]),
        "--ttl",
        this.options.write ? "2m" : "15m",
        "--label",
        this.options.write ? "Jev user approval relay" : "Jev live task overview",
        "--token-only",
      ];
      if (this.options.baseDir) args.push("--base-dir", this.options.baseDir);
      const token = this.options.issueToken
        ? await this.options.issueToken(args)
        : NodeChildProcess.execFileSync(this.options.cli, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
            timeout: 12000,
          }).trim();
      if (!token) throw Error("T3 UI authentication is unavailable");
      const ws = new WebSocket(this.options.url, { headers: { Authorization: "Bearer " + token } });
      this.ws = ws;
      ws.on("message", (data) => {
        let list;
        try {
          list = JSON.parse(data.toString());
        } catch {
          return;
        }
        for (const m of Array.isArray(list) ? list : [list]) {
          const p = this.pending.get(m.requestId);
          if (m._tag === "Chunk") {
            if (p?.onChunk) p.onChunk(m.values ?? m.chunk ?? []);
            ws.send(JSON.stringify({ _tag: "Ack", requestId: m.requestId }));
          } else if (m._tag === "Exit" && p) {
            this.pending.delete(m.requestId);
            clearTimeout(p.timer);
            if (m.exit?._tag === "Success") p.resolve(m.exit.value);
            else p.reject(Error("T3 rejected the local UI request"));
          }
        }
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(Error("T3 UI connection closed"));
        }
        this.pending.clear();
        this.watched.clear();
        this.changed();
      });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          ws.close();
          reject(Error("T3 UI connection timed out"));
        }, 10000);
        ws.once("open", () => {
          clearTimeout(timer);
          resolve();
        });
        ws.once("error", () => {
          clearTimeout(timer);
          reject(Error("T3 UI connection is unavailable"));
        });
      });
    })();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }
  async rpc(tag, payload, { onChunk, stream = false } = {}) {
    if (this.closed) throw Error("T3 UI bridge is closed");
    await this.connect();
    if (this.closed) throw Error("T3 UI bridge is closed");
    const id = String(++this.n);
    return new Promise((resolve, reject) => {
      const timer = stream
        ? null
        : setTimeout(() => {
            this.pending.delete(id);
            reject(Error("T3 UI request timed out"));
          }, 15000);
      this.pending.set(id, { resolve, reject, timer, onChunk });
      this.ws.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  }
  watch(threadId, onChange) {
    if (this.watched.has(threadId)) return;
    this.watched.add(threadId);
    this.rpc(
      "orchestration.subscribeThread",
      { threadId },
      { stream: true, onChunk: onChange },
    ).catch(() => {
      this.watched.delete(threadId);
      onChange();
    });
  }
  async isTopLevelProxy(parentThreadId) {
    let id = parentThreadId;
    const seen = new Set();
    for (let depth = 0; id && depth < 12; depth++) {
      if (seen.has(id)) throw Error("Invalid T3 thread lineage");
      seen.add(id);
      const p = await this.rpc("orchestration.getThreadProjection", { threadId: id });
      if (id !== parentThreadId && p.thread.modelSelection?.instanceId === "jev-auto") return false;
      id = p.thread.lineage?.parentThreadId;
    }
    return true;
  }
  async snapshot(parentThreadId, rootThreadId, onChange) {
    const projections = [];
    const seen = new Set();
    let incomplete = false;
    const visit = async (id, parent, depth) => {
      if (seen.has(id)) return;
      if (seen.size >= 30 || depth > 8) {
        incomplete = true;
        return;
      }
      seen.add(id);
      const p = await this.rpc("orchestration.getThreadProjection", { threadId: id });
      if (p.thread?.lineage?.parentThreadId !== parent)
        throw Error("Task family changed; UI relay refused");
      const evidence = await antigravityQuotaEvidence(
        p,
        this.options.antigravityProvidersDirectory ??
          NodePath.join(
            this.options.baseDir ?? NodePath.join(NodeOS.homedir(), ".t3"),
            "userdata/providers/antigravity",
          ),
      );
      projections.push(evidence ? { ...p, turnItems: [...(p.turnItems ?? []), evidence] } : p);
      if (onChange) this.watch(id, onChange);
      for (const task of p.subagents ?? [])
        if (task.childThreadId) await visit(task.childThreadId, id, depth + 1);
    };
    await visit(rootThreadId, parentThreadId, 0);
    this.lastSnapshotAt = Date.now();
    return workSnapshot({ parentThreadId, rootThreadId, projections, incomplete });
  }
  async respondToUserApproval({ parentThreadId, rootThreadId, request, decision }) {
    if (!["accept", "decline"].includes(decision))
      throw Error("Only one-time UI decisions are supported");
    const fresh = await this.snapshot(parentThreadId, rootThreadId);
    const current = fresh.approvals.find(
      (r) => r.threadId === request.threadId && r.requestId === request.requestId,
    );
    if (!current || current.fingerprint !== request.fingerprint)
      throw Error("The approval changed or was already resolved");
    const write = new HostClient({
      ...this.options,
      scopes: ["orchestration:read", "orchestration:operate"],
      write: true,
    });
    try {
      await write.rpc("orchestration.dispatchCommand", {
        type: "runtime-request.respond",
        commandId: "jev-user-decision-" + NodeCrypto.randomUUID(),
        threadId: request.threadId,
        requestId: request.requestId,
        decision,
      });
    } finally {
      write.close();
    }
  }
  close() {
    this.closed = true;
    this.ws?.close();
    this.changed();
  }
}
