import { selectChoice } from "./policy.mjs";
export async function route(pool, context, ask) {
  if (!pool.length) throw Error("No eligible connected provider remains");
  const providers = [...new Set(pool.map((c) => c.providerInstanceId))].sort();
  const state = {
    ...context,
    observations: {
      comparativeSpeed: "not measured",
      comparativeQuality: "not measured",
      remainingAllowance:
        "unknown; providers with an observed active usage cooldown have been excluded",
    },
    policy:
      "Choose a suitable provider for the user request, then a model and supported effort. Prefer subscription connections when similarly suitable. Do not favor a provider because it has more model or effort variants. Do not force rotation. Do not treat previous selections as evidence of quality. Native tool availability must not be assumed identical.",
  };
  const first = await ask({
    model: "jev-latest",
    state,
    questions: {
      provider: {
        type: "choice",
        instructions:
          "Which eligible provider is suitable for this user request? Compare the available model families and stated constraints; use the request rather than harness instructions. There are no measured benchmark results. Respect explicit user preferences among eligible connections.",
        criteria: Object.fromEntries(
          providers.map((id) => [
            id,
            {
              provider: id,
              access: ["deepseek-api", "kimi-api", "openrouter-api"].includes(id)
                ? "pay-as-you-go API"
                : "existing subscription",
              models: [
                ...new Set(pool.filter((c) => c.providerInstanceId === id).map((c) => c.model)),
              ],
              constraints: pool.find((c) => c.providerInstanceId === id)?.constraints ?? [],
            },
          ]),
        ),
      },
      kind: {
        type: "choice",
        instructions: "What is the primary kind of work in the user request?",
        criteria: {
          coding: "Implement code",
          debugging: "Diagnose or fix a failure",
          design: "Design or critique an interface",
          planning: "Product, strategy or project planning",
          research: "Research or compare evidence",
          writing: "Write or edit prose",
          review: "Review code, implementation or security",
          quick: "A short simple question or small task",
        },
      },
      stack: {
        type: "choice",
        instructions:
          "Which platform-specific skill family applies to this request? Use general when no specific platform is established. Preserve the project stack rather than inventing a migration.",
        criteria: {
          general: "No platform-specific implementation context",
          web: "React, Next.js or web interface implementation",
          expo: "React Native or Expo mobile app",
          swift: "Native Swift, SwiftUI, iOS or macOS app",
          cloudflare: "Cloudflare Workers or its services",
        },
      },
      collaboration: {
        type: "choice",
        instructions:
          "Which collaboration approach is proportionate to this request? Small tasks should stay solo. Planning-only requests must not become implementation. A leaf specialist must stay solo. Prefer at most two independent specialists; avoid extra agents whose work duplicates the coordinator.",
        criteria: {
          solo: "Direct work by the selected native executor",
          parallel_read: "Independent read-only research, planning or analysis",
          parallel_build: "Independent implementation scopes with isolated writers",
          review: "Main work with one useful independent review",
        },
      },
    },
  });
  const value = (a) => a?.choice ?? a?.value ?? a?.selected;
  const provider = value(first.answers?.provider);
  if (!providers.includes(provider)) throw Error("Jev returned an unavailable provider");
  const eligible = pool.filter((c) => c.providerInstanceId === provider);
  const kind = value(first.answers?.kind) ?? "unknown";
  const proposedStack = value(first.answers?.stack);
  const stack = ["general", "web", "expo", "swift", "cloudflare"].includes(proposedStack)
    ? proposedStack
    : "general";
  const proposedTeam = value(first.answers?.collaboration);
  const scope = context.interactionMode === "plan" ? "plan_only" : "execute";
  let collaboration =
    !context.leaf && ["solo", "parallel_read", "parallel_build", "review"].includes(proposedTeam)
      ? proposedTeam
      : "solo";
  if (scope === "plan_only" && collaboration === "parallel_build") collaboration = "parallel_read";
  const second = await ask({
    model: "jev-latest",
    state: { ...state, selectedProvider: provider, taskKind: kind },
    questions: {
      selection: {
        type: "choice",
        instructions:
          "Choose one available model and effort combination for this task within the selected provider. Use low effort for simple work, higher for complex debugging or architecture. Preserve quality and avoid unnecessary latency.",
        criteria: Object.fromEntries(
          eligible.map((c) => [c.id, { model: c.model, options: c.options }]),
        ),
      },
      basis: {
        type: "choice",
        instructions:
          "Given the user request and selected provider, which description best summarizes the estimated basis for this provider choice? This is a descriptive estimate, not measured performance or an explanation of hidden reasoning. Use uncertain when evidence does not distinguish the choice.",
        criteria: {
          task_fit: "The model family suits this requested work",
          subscription:
            "Similarly suitable options; prefer existing subscription usage (not valid for Kimi, DeepSeek or OpenRouter API)",
          user_preference: "The user explicitly requested this selected provider",
          speed: "The user task is lightweight and minimizing overhead is the priority",
          quality: "The task needs extra care for complexity or consequences",
          uncertain: "Available evidence does not establish an advantage",
        },
      },
    },
  });
  const reportedBasis = value(second.answers?.basis) ?? "uncertain";
  const basis =
    reportedBasis === "subscription" &&
    ["deepseek-api", "kimi-api", "openrouter-api"].includes(provider)
      ? "uncertain"
      : reportedBasis;
  return {
    ...selectChoice(eligible, value(second.answers?.selection)),
    taskKind: kind,
    stack,
    collaboration,
    scope,
    leaf: !!context.leaf,
    basis,
    reportedBasis,
    eligibleProviders: providers,
    providerConfidence: first.answers?.provider?.confidence ?? null,
    providerProbabilities: first.answers?.provider?.probabilities ?? null,
    jevModel: second.model ?? first.model ?? "jev-latest",
  };
}
