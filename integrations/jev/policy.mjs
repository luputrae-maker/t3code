export function candidates(catalog, allowed, cooldowns, now = Date.now()) {
  const result = [];
  for (const p of catalog.providers ?? []) {
    if (
      !allowed.includes(p.providerInstanceId) ||
      !p.canRunChildTask ||
      (cooldowns[p.providerInstanceId] ?? 0) > now
    )
      continue;
    for (const m of p.models ?? []) {
      const effort = (m.options ?? []).find((o) => /effort|reasoning|thinking/i.test(o.id));
      const values = effort?.values?.filter((v) => typeof v === "string") ?? [];
      for (const value of values.length ? values : [null])
        result.push({
          id: `r${result.length}`,
          providerInstanceId: p.providerInstanceId,
          model: m.id,
          modelLabel: m.label ?? m.id,
          constraints: p.constraints ?? [],
          options: value === null ? [] : [{ id: effort.id, value }],
        });
    }
  }
  return result;
}
export function selectChoice(pool, id) {
  const c = pool.find((c) => c.id === id);
  if (!c) throw Error("Jev returned an unavailable selection");
  return c;
}
export function isQuota(text) {
  return /usage[ _-]*limit.{0,40}(reached|exceeded|hit)|(?:rate|usage)[ _-]*limit[ _-]*exceeded|insufficient_quota|quota.{0,35}(exhausted|exceeded)|exhausted.{0,25}quota|too many requests|hit your.{0,20}limit|reached your.{0,20}limit|request reached (?:organization |account )?(?:TPD|daily token)[ _-]*(?:rate )?limit/i.test(
    text ?? "",
  );
}
export function quiescent(result) {
  return (
    ["completed", "failed", "cancelled", "interrupted"].includes(result.status) &&
    !result.hasPendingChildRuns &&
    !result.pendingApproval &&
    !result.hasPendingQuestion
  );
}
export function quotaEvidence(activity, runId) {
  return (activity?.items ?? []).some(
    (item) =>
      item.runId === runId &&
      ["system_notice", "error", "provider_error"].includes(item.type) &&
      (!item.creationSource || ["provider", "server"].includes(item.creationSource)) &&
      (!item.createdBy || item.createdBy === "system") &&
      !/permission denied|approval|test failed/i.test(item.text ?? "") &&
      isQuota(item.text ?? item.title),
  );
}
