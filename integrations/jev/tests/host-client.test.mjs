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
