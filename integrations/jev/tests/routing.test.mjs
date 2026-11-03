import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { route } from "../routing.mjs";
import { userRequest, routeMessage, workMessage, taskTitle } from "../presentation.mjs";

const pool = [
  { id: "r0", providerInstanceId: "claudeAgent", model: "opus", options: [] },
  { id: "r1", providerInstanceId: "claudeAgent", model: "sonnet", options: [] },
  {
    id: "r2",
    providerInstanceId: "kimi-api",
    model: "kimi-k3.1-pro",
    options: [{ id: "reasoning", value: "low" }],
  },
];
NodeTest.test(
  "providers compete once each before model/effort selection, and decisions retain actual evidence",
  async () => {
    const calls = [];
    const decision = await route(
      pool,
      { request: "Fix the checkout crash", history: [] },
      async (body) => {
        calls.push(body);
        if (calls.length === 1) {
          NodeAssert.equal(Object.keys(body.questions.provider.criteria).length, 2);
          return {
            model: "fixture",
            answers: {
              provider: { choice: "kimi-api", confidence: 0.2 },
              kind: { choice: "debugging" },
            },
          };
        }
        NodeAssert.deepEqual(Object.keys(body.questions.selection.criteria), ["r2"]);
        return {
          model: "fixture",
          answers: { selection: { choice: "r2" }, basis: { choice: "task_fit" } },
        };
      },
    );
    NodeAssert.equal(calls.length, 2);
    NodeAssert.equal(decision.providerInstanceId, "kimi-api");
    NodeAssert.equal(decision.providerConfidence, 0.2);
    NodeAssert.deepEqual(decision.eligibleProviders, ["claudeAgent", "kimi-api"]);
    NodeAssert.doesNotMatch(
      routeMessage(decision),
      /Selection basis|Comparative performance|no clear evidence/i,
    );
    NodeAssert.doesNotMatch(routeMessage(decision), /20%|best|fastest/i);
  },
);
NodeTest.test("an invalid provider or model never becomes a dispatch target", async () => {
  await NodeAssert.rejects(
    () =>
      route(pool, { request: "test" }, async () => ({
        answers: { provider: { choice: "unavailable" } },
      })),
    /unavailable/,
  );
  let n = 0;
  await NodeAssert.rejects(
    () =>
      route(pool, { request: "test" }, async () =>
        ++n === 1
          ? { answers: { provider: { choice: "kimi-api" } } }
          : { answers: { selection: { choice: "r0" } } },
      ),
    /unavailable/,
  );
});
NodeTest.test(
  "routing and titles prioritize user text while leaving execution input untouched",
  () => {
    const original =
      "<t3_code_instructions>Large harness instructions</t3_code_instructions>\n<user_request>Fix checkout\nand explain the result.</user_request>";
    NodeAssert.equal(userRequest(original), "Fix checkout\nand explain the result.");
    NodeAssert.equal(taskTitle(original), "Jev: Fix checkout and explain the result.");
    NodeAssert.match(original, /Large harness/);
    const quoted =
      "<t3_code_instructions>Rules</t3_code_instructions>\n<user_request>Explain this example: <user_request>quoted</user_request> and its risks.</user_request>";
    NodeAssert.equal(
      userRequest(quoted),
      "Explain this example: <user_request>quoted</user_request> and its risks.",
    );
    NodeAssert.equal(
      userRequest("Explain <user_request>quoted</user_request>"),
      "Explain <user_request>quoted</user_request>",
    );
    const withMetadata =
      original +
      "\n<runtime_info>Native runtime metadata</runtime_info>\n<pull_request_linking>Native PR rules</pull_request_linking>";
    NodeAssert.equal(userRequest(withMetadata), "Fix checkout\nand explain the result.");
    NodeAssert.equal(taskTitle(withMetadata), "Jev: Fix checkout and explain the result.");
  },
);
NodeTest.test(
  "API routes cannot be described as subscription choices even if Jev mislabels the basis",
  async () => {
    let n = 0;
    const d = await route(pool, { request: "Use Kimi" }, async () =>
      ++n === 1
        ? { answers: { provider: { choice: "kimi-api" } } }
        : { answers: { selection: { choice: "r2" }, basis: { choice: "subscription" } } },
    );
    NodeAssert.equal(d.basis, "uncertain");
    NodeAssert.equal(d.reportedBasis, "subscription");
  },
);
NodeTest.test(
  "work updates have meaningful state, use supplied links, and never expose raw identifiers as prose",
  () => {
    const raw = "thread:delegated-task:command%3Amcp%3A9831516a";
    const result = {
      childThreadId: raw,
      link: "[Checkout fix](t3://fixture-work)",
      status: "running",
    };
    NodeAssert.match(workMessage(result), /Working/);
    NodeAssert.match(workMessage(result), /\[Checkout fix\]\(t3:\/\/fixture-work\)/);
    NodeAssert.doesNotMatch(workMessage({ ...result, link: undefined }), /thread:|%3A|9831516a/);
    NodeAssert.match(
      workMessage({ ...result, hasPendingQuestion: true }),
      /Waiting for your answer/,
    );
    NodeAssert.match(workMessage({ ...result, pendingApproval: {} }), /Waiting for your approval/);
  },
);
NodeTest.test(
  "progress uses short paragraphs, readable model labels, and a named work link",
  () => {
    const message = routeMessage({
      providerInstanceId: "claudeAgent",
      model: "claude-sonnet-5-5",
      modelLabel: "Claude Sonnet 5.5",
      options: [{ id: "effort", value: "high" }],
      basis: "uncertain",
    });
    NodeAssert.match(message, /Claude Sonnet 5\.5/);
    NodeAssert.match(message, /High effort/);
    NodeAssert.doesNotMatch(message, /claude-sonnet-5-5|claudeAgent/);
    NodeAssert.ok(message.includes("\n\n"));
    const link = "<t3-thread://v2/fixture/thread:delegated-task:command%3Amcp%3Afixture>";
    NodeAssert.match(
      workMessage({ status: "running", link }),
      /\[Open live work\]\(t3-thread:\/\/v2\/fixture\/thread:delegated-task:command%3Amcp%3Afixture\)/,
    );
    NodeAssert.ok(workMessage({ status: "running", link }).includes("\n\n"));
  },
);

NodeTest.test(
  "only an explicit plan setting can restrict native execution to plan mode",
  async () => {
    for (const [interactionMode, scope, collaboration] of [
      [undefined, "execute", "parallel_build"],
      ["default", "execute", "parallel_build"],
      ["plan", "plan_only", "parallel_read"],
    ]) {
      let n = 0;
      const selected = await route(
        pool,
        { request: "Build checkout", interactionMode },
        async () =>
          ++n === 1
            ? {
                answers: {
                  provider: { choice: "claudeAgent" },
                  kind: { choice: "coding" },
                  scope: { choice: "plan_only" },
                  collaboration: { choice: "parallel_build" },
                },
              }
            : { answers: { selection: { choice: "r0" } } },
      );
      NodeAssert.equal(selected.scope, scope);
      NodeAssert.equal(selected.collaboration, collaboration);
    }
  },
);

NodeTest.test(
  "OpenRouter is billed as API usage and cannot be described as a subscription",
  async () => {
    const calls = [];
    const d = await route(
      [
        {
          id: "r0",
          providerInstanceId: "openrouter-api",
          model: "openrouter/fixture/coder",
          options: [],
        },
      ],
      { request: "Build the feature" },
      async (body) => {
        calls.push(body);
        return calls.length === 1
          ? { answers: { provider: { choice: "openrouter-api" }, kind: { choice: "coding" } } }
          : { answers: { selection: { choice: "r0" }, basis: { choice: "subscription" } } };
      },
    );
    NodeAssert.equal(
      calls[0].questions.provider.criteria["openrouter-api"].access,
      "pay-as-you-go API",
    );
    NodeAssert.equal(d.basis, "uncertain");
    NodeAssert.match(routeMessage(d), /OpenRouter/);
    NodeAssert.doesNotMatch(routeMessage(d), /openrouter-api/);
  },
);
