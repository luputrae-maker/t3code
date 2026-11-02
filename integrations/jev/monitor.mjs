import { relayApproval } from "./approval-relay.mjs";
import { quiescent } from "./policy.mjs";
export async function monitorTask({
  host,
  parentThreadId,
  rootThreadId,
  readStatus,
  update,
  askPermission,
  cancelled,
  relay = true,
}) {
  const handled = new Set();
  let deferred = false,
    relayError;
  while (!cancelled()) {
    const result = await readStatus();
    const snapshot = await host.snapshot(parentThreadId, rootThreadId, () => host.changed());
    await update(snapshot);
    if (deferred) return { ...result, uiDeferred: true };
    if (relayError) throw relayError;
    if (quiescent(result)) return result;
    const quota = snapshot.quota.filter((q) => q.threadId === rootThreadId);
    if (quota.length)
      return {
        ...result,
        uiQuota: true,
        uiQuotaEvidence: quota.map((q) => ({
          runId: q.runId,
          type: "provider_error",
          creationSource: "provider",
          createdBy: "system",
          text: q.message,
        })),
      };
    if (relay && snapshot.questions.length) return { ...result, uiQuestions: snapshot.questions };
    for (const request of relay ? snapshot.approvals : []) {
      if (handled.has(request.fingerprint)) continue;
      handled.add(request.fingerprint);
      relayApproval({
        request,
        askUser: askPermission,
        readCurrent: async () => {
          if (cancelled()) return null;
          const fresh = await host.snapshot(parentThreadId, rootThreadId);
          return (
            fresh.approvals.find(
              (r) => r.requestId === request.requestId && r.threadId === request.threadId,
            ) ?? null
          );
        },
        respond: (decision) =>
          host.respondToUserApproval({
            parentThreadId,
            rootThreadId,
            request,
            decision: decision.decision,
          }),
      })
        .then((outcome) => {
          if (outcome.status === "dismissed") deferred = true;
        })
        .catch(() => {
          relayError = Error("The approval could not be delivered; the task remains paused.");
        })
        .finally(() => host.changed());
    }
    await host.waitForChange(5000);
  }
  return { status: "cancelled", uiCancelled: true };
}
