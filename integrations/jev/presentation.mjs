const names = {
  claudeAgent: "Claude",
  codex: "Codex",
  grok: "Grok",
  antigravity: "Antigravity",
  "deepseek-api": "DeepSeek",
  "kimi-api": "Kimi",
  "openrouter-api": "OpenRouter",
};
export const providerName = (id) => names[id] ?? id;
export function userRequest(text) {
  const request =
    /^\s*<t3_code_instructions>[\s\S]*?<\/t3_code_instructions>\s*<user_request>([\s\S]*)<\/user_request>([\s\S]*)$/i.exec(
      text,
    );
  // Some native runners append metadata after the envelope. Only accept known
  // metadata there; quoted tags inside the user's request stay in the request.
  if (
    request &&
    !request[2].replace(/<(runtime_info|pull_request_linking)\b[^>]*>[\s\S]*?<\/\1>/gi, "").trim()
  )
    return request[1].trim();
  return (
    text
      .replace(
        /<(t3_code_instructions|runtime_info|pull_request_linking)\b[^>]*>[\s\S]*?<\/\1>/gi,
        "",
      )
      .trim() || text
  );
}
export const stripRolePrefix = (text) =>
  text
    .trimStart()
    .replace(
      /^Act as the (?:implementation|research|review|design|test|general) sub-agent for this task\.\s*/i,
      "",
    );
export const taskTitle = (text) =>
  "Jev: " +
  stripRolePrefix(userRequest(text))
    .replace(/^\[jev-subtask:v1\]\s*/, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
function modelName(target) {
  const label = target.modelLabel ?? target.model ?? "";
  const raw =
    target.providerInstanceId === "openrouter-api" ? label.replace(/^openrouter\//i, "") : label;
  const claude = /^claude-(opus|sonnet|haiku|fable)-([\d.-]+)$/i.exec(raw);
  if (claude)
    return (
      "Claude " +
      claude[1][0].toUpperCase() +
      claude[1].slice(1) +
      " " +
      claude[2].replaceAll("-", ".")
    );
  return raw;
}
export function routeMessage(target) {
  const effort = (target.options ?? []).map((o) => o.value).join(", ");
  const effortLabel = effort
    ? effort[0].toUpperCase() + effort.slice(1) + " effort"
    : "Provider default effort";
  const provider = providerName(target.providerInstanceId),
    model = modelName(target);
  const name = model.toLowerCase().includes(provider.toLowerCase())
    ? model
    : provider + " · " + model;
  const kind = {
    planning: target.scope === "plan_only" ? "Planning only" : "Plan",
    coding: "Build",
    design: "Design",
    debugging: "Debug",
    review: "Review",
    research: "Research",
    writing: "Writing",
  }[target.taskKind];
  const stack = { web: "Web", expo: "Expo mobile", swift: "Swift", cloudflare: "Cloudflare" }[
    target.stack
  ];
  const team = {
    solo: "Direct work",
    parallel_read: "Research/planning specialists",
    parallel_build: "Coding specialists",
    review: "Independent review",
  }[target.collaboration];
  const approach = kind
    ? `**Planned approach:** ${[kind, stack, team].filter(Boolean).join(" · ")}\n\n`
    : "";
  return `**Agent:** ${name} · ${effortLabel}\n\n${approach}`;
}
export function workMessage(result, link) {
  const state = result.pendingApproval
    ? "Waiting for your approval"
    : result.hasPendingQuestion
      ? "Waiting for your answer"
      : result.status === "queued"
        ? "Queued"
        : result.status === "completed"
          ? "Finished"
          : "Working";
  // Preserve T3's exact destination; label its autolinks so raw ids never show.
  const supplied = result.link ?? link;
  const autolink = /^<(t3-thread:\/\/v[12]\/[^\s<>]+)>$/.exec(supplied ?? "");
  const readable = autolink ? `[Open live work](${autolink[1]})` : supplied;
  return `**Status:** ${state}.\n\n${readable ?? "Use the Open button on the task below to see its progress."}\n\n`;
}
