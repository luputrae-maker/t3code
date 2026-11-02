import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { relayApproval } from "../approval-relay.mjs";
const request = {
  threadId: "worker",
  requestId: "permission-1",
  runId: "run-1",
  prompt: "Run node --test?",
  fingerprint: "same",
};
NodeTest.test("an approval is never sent without a matching explicit user choice", async () => {
  const sent = [];
  const options = { request, readCurrent: async () => request, respond: async (x) => sent.push(x) };
  await relayApproval({ ...options, askUser: async () => ({ outcome: { outcome: "cancelled" } }) });
  NodeAssert.deepEqual(sent, []);
  await relayApproval({
    ...options,
    askUser: async () => ({ outcome: { outcome: "selected", optionId: "invented" } }),
  });
  NodeAssert.deepEqual(sent, []);
});
NodeTest.test(
  "only allow-once or decline maps to the exact still-pending native request",
  async () => {
    const sent = [];
    await relayApproval({
      request,
      askUser: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
      readCurrent: async () => request,
      respond: async (x) => sent.push(x),
    });
    NodeAssert.deepEqual(sent, [
      { threadId: "worker", requestId: "permission-1", decision: "accept" },
    ]);
    await relayApproval({
      request,
      askUser: async () => ({ outcome: { outcome: "selected", optionId: "decline" } }),
      readCurrent: async () => request,
      respond: async (x) => sent.push(x),
    });
    NodeAssert.equal(sent[1].decision, "decline");
    NodeAssert.ok(sent.every((x) => !["acceptAlways", "acceptForSession"].includes(x.decision)));
  },
);
NodeTest.test(
  "resolved or changed requests cannot be approved using an old displayed prompt",
  async () => {
    for (const current of [
      null,
      { ...request, fingerprint: "changed" },
      { ...request, threadId: "foreign" },
    ]) {
      let sent = false;
      await relayApproval({
        request,
        askUser: async () => ({ outcome: { outcome: "selected", optionId: "allow-once" } }),
        readCurrent: async () => current,
        respond: async () => {
          sent = true;
        },
      });
      NodeAssert.equal(sent, false);
    }
  },
);
NodeTest.test(
  "a command approval carries the exact executable input into T3’s native approval card",
  async () => {
    const { approvalToolCall } = await import("../approval-relay.mjs");
    const command = "node --test fixture.test.mjs";
    const call = approvalToolCall({
      kind: "command",
      title: "Test checkout",
      fingerprint: "1234567890abcdef",
      prompt: command,
      toolInput: command,
    });
    NodeAssert.equal(call.kind, "execute");
    NodeAssert.deepEqual(call.rawInput, { command });
    NodeAssert.match(call.content[0].content.text, /node --test fixture/);
  },
);
