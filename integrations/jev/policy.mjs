export function candidates(catalog, allowed, cooldowns, now = Date.now(), modelAllowlist = {}) {
  if (
    modelAllowlist === null ||
    typeof modelAllowlist !== "object" ||
    Array.isArray(modelAllowlist)
  )
    throw Error("Model allowlist must map provider instance ids to model id arrays");
  const result = [];
  for (const p of catalog.providers ?? []) {
    if (
      !allowed.includes(p.providerInstanceId) ||
      !p.canRunChildTask ||
      (cooldowns[p.providerInstanceId] ?? 0) > now
    )
      continue;
    for (const m of p.models ?? []) {
      const shortlist = modelAllowlist[p.providerInstanceId];
      if (shortlist !== undefined && (!Array.isArray(shortlist) || !shortlist.includes(m.id)))
        continue;
      const effort = (m.options ?? []).find((o) => /effort|reasoning|thinking|variant/i.test(o.id));
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
  return /usage[ _-]*limit.{0,40}(reached|exceeded|hit)|(?:rate|usage)[ _-]*limit[ _-]*(?:exceeded|reached)|insufficient_quota|quota.{0,35}(exhausted|exceeded)|exhausted.{0,25}quota|too many requests|hit your.{0,20}limit|reached your.{0,20}limit|request reached (?:organization |account )?(?:TPD|daily token)[ _-]*(?:rate )?limit/i.test(
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
  return (activity?.items ?? []).some((item) => {
    if (
      !runId ||
      item.runId !== runId ||
      !["system_notice", "error", "provider_error"].includes(item.type) ||
      (item.creationSource && !["provider", "server"].includes(item.creationSource)) ||
      (item.createdBy && item.createdBy !== "system")
    )
      return false;
    if (
      (activity?.items ?? []).some(
        (later) =>
          later.runId === runId &&
          ["assistant_message", "reasoning"].includes(later.type) &&
          (later.ordinal ?? later.position) > (item.ordinal ?? item.position),
      )
    )
      return false;
    const failure = item.failure;
    if (failure?.class && !["usage_limit", "provider_error"].includes(failure.class)) return false;
    const text = failure?.message ?? item.text ?? item.title ?? "";
    if (/permission denied|approval|test failed/i.test(text)) return false;
    if (
      failure?.class === "provider_error" &&
      ["api_error_429", "provider.rate-limit"].includes(failure.code)
    ) {
      return (
        /\bTPD\b|daily|tokens? per day|quota.*(?:exhausted|exceeded)|insufficient_quota/i.test(
          text,
        ) || (item.retry?.attempt ?? 0) >= 2
      );
    }
    return (
      failure?.class === "usage_limit" ||
      isQuota(text) ||
      (failure?.class === "provider_error" &&
        ["api_error_429", "provider.rate-limit"].includes(failure.code) &&
        (item.retry?.attempt ?? 0) >= 2)
    );
  });
}
