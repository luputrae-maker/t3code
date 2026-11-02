import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { HostClient, localHostOptions } from "../host-client.mjs";
const projection = (id, parent, provider = "claudeAgent") => ({
  thread: {
    id,
    title: id,
    lineage: { parentThreadId: parent },
    modelSelection: { instanceId: provider },
  },
  runs: [{ id: "run", ordinal: 1, status: "running", providerInstanceId: provider }],
  subagents: [],
  runtimeRequests: [],
  turnItems: [],
});
async function fixture() {
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((r) => wss.once("listening", r));
  const requests = [],
    tokens = [];
  let child = projection("child", "parent");
  const parents = new Map([["parent", projection("parent", undefined, "jev-auto")]]);
  wss.on("connection", (socket) =>
    socket.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m._tag !== "Request") return;
      requests.push(m);
      const value =
        m.tag === "orchestration.getThreadProjection"
          ? m.payload.threadId === "child"
            ? child
            : parents.get(m.payload.threadId)
          : {};
      socket.send(
        JSON.stringify({ _tag: "Exit", requestId: m.id, exit: { _tag: "Success", value } }),
      );
    }),
  );
  const options = {
    url: `ws://127.0.0.1:${wss.address().port}/ws`,
    issueToken: async (args) => {
      tokens.push(args);
      return "fixture";
    },
  };
  const host = new HostClient(options);
  return {
    host,
    requests,
    tokens,
    setChild: (p) => (child = p),
    parents,
    close: async () => {
      host.close();
      for (const ws of wss.clients) ws.terminate();
      await new Promise((r) => wss.close(r));
    },
  };
}
NodeTest.test("the UI bridge refuses remote endpoints and URL credentials", () => {
  for (const url of [
    "wss://example.com",
    "ws://example.com",
    "ws://user:pass@localhost:3773",
    "file:///tmp/t3",
  ])
    NodeAssert.throws(() => localHostOptions({ url }), /loopback/);
  NodeAssert.equal(localHostOptions().scopes[0], "orchestration:read");
});
NodeTest.test("progress reads get read-only scope and reject a foreign task family", async () => {
  const f = await fixture();
  try {
    await f.host.snapshot("parent", "child");
    NodeAssert.ok(f.tokens[0].includes("orchestration:read"));
    NodeAssert.ok(!f.tokens[0].includes("orchestration:operate"));
    f.setChild(projection("child", "different-parent"));
    await NodeAssert.rejects(f.host.snapshot("parent", "child"), /family/);
    NodeAssert.ok(!f.requests.some((r) => r.tag === "orchestration.dispatchCommand"));
  } finally {
    await f.close();
  }
});
NodeTest.test("an exact fresh UI approval gets only a short-lived one-time response", async () => {
  const f = await fixture();
  try {
    const p = projection("child", "parent");
    p.runtimeRequests = [{ id: "approval", kind: "command", status: "pending" }];
    p.turnItems = [
      { type: "approval_request", requestId: "approval", runId: "run", prompt: "Run node --test?" },
    ];
    f.setChild(p);
    const request = (await f.host.snapshot("parent", "child")).approvals[0];
    await f.host.respondToUserApproval({
      parentThreadId: "parent",
      rootThreadId: "child",
      request,
      decision: "accept",
    });
    const cmd = f.requests.find((r) => r.tag === "orchestration.dispatchCommand").payload;
    NodeAssert.equal(cmd.type, "runtime-request.respond");
    NodeAssert.equal(cmd.threadId, "child");
    NodeAssert.equal(cmd.requestId, "approval");
    NodeAssert.equal(cmd.decision, "accept");
    NodeAssert.ok(f.tokens[1].includes("2m"));
    NodeAssert.ok(f.tokens[1].includes("orchestration:operate"));
    await NodeAssert.rejects(
      f.host.respondToUserApproval({
        parentThreadId: "parent",
        rootThreadId: "child",
        request,
        decision: "acceptForSession",
      }),
      /one-time/,
    );
    p.turnItems[0].prompt = "Run a different command?";
    await NodeAssert.rejects(
      f.host.respondToUserApproval({
        parentThreadId: "parent",
        rootThreadId: "child",
        request,
        decision: "accept",
      }),
      /changed/,
    );
    NodeAssert.equal(f.requests.filter((r) => r.tag === "orchestration.dispatchCommand").length, 1);
  } finally {
    await f.close();
  }
});

NodeTest.test(
  "old Antigravity quota banners require a matching native error within the current run",
  async () => {
    const NodeFS = await import("node:fs"),
      NodeOS = await import("node:os"),
      NodePath = await import("node:path"),
      NodeSqlite = await import("node:sqlite");
    const directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-native-quota-")),
    );
    const f = await fixture();
    const session = "11111111-1111-1111-1111-111111111111";
    const profile = NodePath.join(directory, "a".repeat(64)),
      conversations = NodePath.join(profile, "antigravity-acp", "conversations"),
      file = NodePath.join(conversations, session + ".db");
    const banner =
      "Usage Limit Reached\n\nYou have reached your current quota for this period. Your limit will reset in 6 days, 15 hours.";
    try {
      NodeFS.mkdirSync(conversations, { recursive: true });
      const db = new NodeSqlite.DatabaseSync(file);
      db.exec(
        "CREATE TABLE steps(idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB, step_payload BLOB)",
      );
      const varint = (n) => {
        const bytes = [];
        do {
          bytes.push((n % 128) | (n >= 128 ? 128 : 0));
          n = Math.floor(n / 128);
        } while (n);
        return Buffer.from(bytes);
      };
      const seconds = 1700000000,
        stamp = Buffer.concat([
          Buffer.from([8]),
          varint(seconds),
          Buffer.from([16]),
          varint(500000000),
        ]);
      const metadata = Buffer.concat([Buffer.from([10, stamp.length]), stamp]);
      const error = Buffer.from(
        "Error 429, Message: Individual quota reached., Status: RESOURCE_EXHAUSTED, Details: [reason:QUOTA_EXHAUSTED]",
      );
      db.prepare("INSERT INTO steps VALUES (1,17,?,?)").run(metadata, error);
      db.close();
      f.host.options.antigravityProvidersDirectory = directory;
      const make = () => projection("child", "parent", "antigravity");
      const p = make();
      p.runs[0] = {
        ...p.runs[0],
        status: "completed",
        providerThreadId: "native",
        requestedAt: "2023-11-14T22:13:20.000Z",
        completedAt: "2023-11-14T22:13:21.000Z",
      };
      p.providerThreads = [
        {
          id: "native",
          driver: "antigravity",
          nativeThreadRef: { driver: "antigravity", strength: "strong", nativeId: session },
        },
      ];
      p.turnItems = [
        { type: "assistant_message", runId: "run", ordinal: 2, text: banner, streaming: false },
      ];
      f.setChild(p);
      const verified = await f.host.snapshot("parent", "child");
      NodeAssert.equal(verified.quota.length, 1);
      NodeAssert.match(verified.quota[0].message, /Antigravity/);
      NodeAssert.doesNotMatch(verified.quota[0].message, /weekly Anthropic|Claude subscription/);
      NodeAssert.equal(verified.plan[0].status, "pending");
      for (const alter of [
        (q) => (q.runs[0].requestedAt = "2023-11-14T22:13:20.700Z"),
        (q) => (q.turnItems[0].text = "The previous agent said: " + banner),
        (q) => (q.turnItems[0].runId = "old-run"),
        (q) => (q.providerThreads[0].nativeThreadRef.strength = "weak"),
        (q) => (q.runs[0].status = "cancelled"),
        (q) => q.runs.push({ ...q.runs[0], id: "overlap", ordinal: 0 }),
        (q) =>
          q.turnItems.push({
            type: "assistant_message",
            runId: "run",
            ordinal: 3,
            text: "Recovered and completed the task",
          }),
      ]) {
        const changed = structuredClone(p);
        alter(changed);
        f.setChild(changed);
        NodeAssert.equal((await f.host.snapshot("parent", "child")).quota.length, 0);
      }
      f.setChild(p);
      NodeFS.writeFileSync(file + "-wal", "");
      NodeAssert.equal((await f.host.snapshot("parent", "child")).quota.length, 0);
      NodeFS.unlinkSync(file + "-wal");
      NodeFS.renameSync(file, file + ".original");
      NodeFS.symlinkSync(file + ".original", file);
      NodeAssert.equal((await f.host.snapshot("parent", "child")).quota.length, 0);
    } finally {
      await f.close();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  },
);

NodeTest.test("a custom T3 home uses its own installed CLI for setup and UI reads", async () => {
  const NodeFS = await import("node:fs"),
    NodeOS = await import("node:os"),
    NodePath = await import("node:path");
  const base = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "jev-home-cli-"));
  try {
    const exe = NodePath.join(base, "bin", NodeOS.platform() === "win32" ? "t3.exe" : "t3");
    NodeFS.mkdirSync(NodePath.dirname(exe));
    NodeFS.writeFileSync(exe, "fixture");
    NodeAssert.equal(localHostOptions({ baseDir: base }).cli, exe);
  } finally {
    NodeFS.rmSync(base, { recursive: true, force: true });
  }
});
