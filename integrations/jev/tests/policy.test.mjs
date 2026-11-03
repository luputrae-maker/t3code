import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { candidates, isQuota, selectChoice, quotaEvidence, quiescent } from "../policy.mjs";
const catalog = {
  providers: [
    {
      providerInstanceId: "codex",
      driverKind: "codex",
      canRunChildTask: true,
      models: [
        {
          id: "actual-model",
          options: [{ id: "effort", values: ["low", "high"] }],
        },
      ],
    },
    {
      providerInstanceId: "pi",
      driverKind: "pi",
      canRunChildTask: true,
      models: [{ id: "other" }],
    },
    {
      providerInstanceId: "jev-auto",
      driverKind: "acpRegistry",
      canRunChildTask: true,
      models: [{ id: "auto" }],
    },
  ],
};
NodeTest.test(
  "only approved native instances can run, and cooldown excludes every model of the exhausted account",
  () => {
    NodeAssert.equal(candidates(catalog, ["codex"], {}, 0).length, 2);
    NodeAssert.deepEqual(candidates(catalog, ["codex"], { codex: 100 }, 0), []);
  },
);
NodeTest.test("Jev cannot invent a model or unsupported effort", () => {
  const pool = candidates(catalog, ["codex"], {}, 0);
  NodeAssert.equal(selectChoice(pool, "r1").options[0].value, "high");
  NodeAssert.throws(() => selectChoice(pool, "invented"));
});
NodeTest.test("only explicit quota signals trigger fallback", () => {
  for (const s of [
    "usage limit reached",
    "rate_limit_exceeded",
    "Claude API rate limit reached. Try again later.",
    "insufficient_quota",
    "exhausted your quota",
    "Your request reached organization TPD rate limit, current: 1520000, limit: 1500000",
  ])
    NodeAssert.equal(isQuota(s), true, s);
  for (const s of [
    "test failed",
    "permission denied",
    "HTTP 500",
    "network timeout",
    "balance sheet analysis",
    "429 lines changed",
  ])
    NodeAssert.equal(isQuota(s), false, s);
});
NodeTest.test(
  "quoted tool logs, assistant text, old runs and permission denials are not quota evidence",
  () => {
    const item = {
      runId: "current",
      type: "system_notice",
      creationSource: "provider",
      createdBy: "system",
      text: "Claude usage limit reached",
    };
    NodeAssert.equal(quotaEvidence({ items: [item] }, "current"), true);
    for (const change of [
      { type: "tool_call" },
      { type: "assistant_message" },
      { runId: "old" },
      { createdBy: "agent" },
      { text: "permission denied: too many requests" },
    ])
      NodeAssert.equal(quotaEvidence({ items: [{ ...item, ...change }] }, "current"), false);
  },
);
NodeTest.test(
  "cancel_requested and terminal runs with live descendants never release the writer",
  () => {
    NodeAssert.equal(quiescent({ status: "cancel_requested" }), false);
    NodeAssert.equal(quiescent({ status: "failed", hasPendingChildRuns: true }), false);
    NodeAssert.equal(quiescent({ status: "failed", pendingApproval: {} }), false);
    NodeAssert.equal(quiescent({ status: "failed", hasPendingChildRuns: false }), true);
  },
);

NodeTest.test("typed current-run usage failures do not require a text regex", () => {
  const item = {
    runId: "current",
    type: "error",
    failure: {
      class: "usage_limit",
      code: "api_error_429",
      message: "Provider unavailable for this period",
    },
  };
  NodeAssert.equal(quotaEvidence({ items: [item] }, "current"), true);
  for (const change of [
    { runId: "old" },
    { createdBy: "agent" },
    { type: "assistant_message" },
    { failure: { class: "authentication", message: "quota exceeded" } },
  ])
    NodeAssert.equal(quotaEvidence({ items: [{ ...item, ...change }] }, "current"), false);
});

NodeTest.test(
  "recovered MCP timeline errors and a single temporary throttle never switch providers",
  () => {
    const error = {
      runId: "current",
      type: "error",
      position: 1,
      text: "Claude API rate limit reached",
    };
    NodeAssert.equal(
      quotaEvidence(
        {
          items: [
            error,
            {
              runId: "current",
              type: "assistant_message",
              position: 2,
              text: "Recovered and finished",
            },
          ],
        },
        "current",
      ),
      false,
    );
    const typed = {
      runId: "current",
      type: "error",
      failure: {
        class: "provider_error",
        code: "provider.rate-limit",
        message: "Rate limit reached",
      },
      retry: { attempt: 1 },
    };
    NodeAssert.equal(quotaEvidence({ items: [typed] }, "current"), false);
    NodeAssert.equal(
      quotaEvidence({ items: [{ ...typed, retry: { attempt: 2 } }] }, "current"),
      true,
    );
  },
);

NodeTest.test(
  "a configured model shortlist bounds OpenRouter without narrowing other providers",
  () => {
    const source = {
      providers: [
        {
          providerInstanceId: "openrouter-api",
          canRunChildTask: true,
          models: [
            {
              id: "openrouter/fixture/coder",
              options: [{ id: "variant", values: ["low", "high"] }],
            },
            { id: "openrouter/fixture/other" },
          ],
        },
        { providerInstanceId: "codex", canRunChildTask: true, models: [{ id: "native-model" }] },
      ],
    };
    const result = candidates(source, ["openrouter-api", "codex"], {}, 0, {
      "openrouter-api": ["openrouter/fixture/coder"],
    });
    NodeAssert.deepEqual(
      result.map((c) => [c.providerInstanceId, c.model, c.options]),
      [
        ["openrouter-api", "openrouter/fixture/coder", [{ id: "variant", value: "low" }]],
        ["openrouter-api", "openrouter/fixture/coder", [{ id: "variant", value: "high" }]],
        ["codex", "native-model", []],
      ],
    );
    for (const list of [[], ["missing-model"], "invalid"]) {
      NodeAssert.equal(
        candidates(source, ["openrouter-api"], {}, 0, { "openrouter-api": list }).length,
        0,
      );
    }
    NodeAssert.equal(
      candidates(source, ["openrouter-api"], { "openrouter-api": 100 }, 0, {
        "openrouter-api": ["openrouter/fixture/coder"],
      }).length,
      0,
    );
  },
);
