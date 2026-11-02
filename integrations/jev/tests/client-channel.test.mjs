import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { ClientChannel } from "../client-channel.mjs";
NodeTest.test("permission answers are correlated to a specific outbound UI request", async () => {
  const sent = [];
  const c = new ClientChannel((x) => sent.push(x));
  const pending = c.requestPermission("session", { title: "Run tests", toolCallId: "tool-1" });
  NodeAssert.equal(sent[0].method, "session/request_permission");
  NodeAssert.equal(
    c.handle({
      id: "unrelated",
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }),
    false,
  );
  NodeAssert.equal(
    c.handle({
      id: sent[0].id,
      result: { outcome: { outcome: "selected", optionId: "allow-once" } },
    }),
    true,
  );
  NodeAssert.equal((await pending).outcome.optionId, "allow-once");
  NodeAssert.ok(sent[0].params.options.every((o) => !o.kind.includes("always")));
});
NodeTest.test(
  "cancellation resolves a waiting UI prompt without creating an approval",
  async () => {
    const c = new ClientChannel(() => {});
    const p = c.requestPermission("session", { title: "Run tests", toolCallId: "tool" });
    c.cancel("session");
    NodeAssert.equal((await p).outcome.outcome, "cancelled");
  },
);
