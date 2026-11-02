export function approvalToolCall(request) {
  const command =
    request.kind === "command" && typeof request.toolInput === "string" ? request.toolInput : null;
  const details = [
    request.prompt,
    request.toolInput ? "Requested action:\n" + JSON.stringify(request.toolInput, null, 2) : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return {
    toolCallId: "jev-approval-" + request.fingerprint.slice(0, 24),
    title: "Approval · " + request.title,
    kind: command ? "execute" : "other",
    status: "pending",
    rawInput: command ? { command } : (request.toolInput ?? { prompt: request.prompt }),
    content: [{ type: "content", content: { type: "text", text: details } }],
  };
}
export async function relayApproval({ request, askUser, readCurrent, respond }) {
  const response = await askUser(request);
  const outcome = response?.outcome;
  if (outcome?.outcome !== "selected") return { status: "dismissed" };
  const decision = { "allow-once": "accept", decline: "decline" }[outcome.optionId];
  if (!decision) return { status: "dismissed" };
  const current = await readCurrent(request);
  if (
    !current ||
    current.fingerprint !== request.fingerprint ||
    current.threadId !== request.threadId ||
    current.requestId !== request.requestId ||
    current.runId !== request.runId
  )
    return { status: "stale" };
  // The caller is the local UI broker. This function is never a model tool.
  // The only positive decision is one-time approval of the displayed request.
  await respond({ threadId: request.threadId, requestId: request.requestId, decision });
  return { status: decision === "accept" ? "approved" : "declined" };
}
