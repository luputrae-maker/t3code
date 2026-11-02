import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const banner =
  /^Usage Limit Reached\s+You have reached your current quota for this period\. Your limit will reset in \d+ (?:days?|hours?|minutes?|seconds?)(?:, \d+ (?:days?|hours?|minutes?|seconds?))*\.?$/;

function nativeStepTime(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes[0] !== 10 || bytes[1] > 32) return NaN;
  const end = bytes[1] + 2;
  let offset = 2;
  const varint = () => {
    let value = 0;
    for (let n = 0; n < 8 && offset < end; n++) {
      const byte = bytes[offset++];
      value += (byte & 127) * 2 ** (7 * n);
      if (!(byte & 128)) return value;
    }
    return NaN;
  };
  if (bytes[offset++] !== 8) return NaN;
  const seconds = varint();
  if (bytes[offset++] !== 16) return NaN;
  const nanos = varint();
  return offset === end && nanos < 1e9 ? seconds * 1000 + nanos / 1e6 : NaN;
}

function managed(root, segments, file = false) {
  let current = root;
  for (const [index, part] of segments.entries()) {
    current = NodePath.join(current, part);
    const info = NodeFS.lstatSync(current);
    if (
      info.isSymbolicLink() ||
      (file && index === segments.length - 1 ? !info.isFile() : !info.isDirectory())
    )
      return null;
  }
  return NodeFS.realpathSync(current) === current ? current : null;
}

// Older Antigravity emits its quota banner as a successful answer. Only its own
// terminal native error, timestamped within this non-overlapping run, verifies it.
export async function antigravityQuotaEvidence(projection, providersDirectory) {
  const run = (projection.runs ?? []).reduce((a, b) => (!a || b.ordinal > a.ordinal ? b : a), null);
  if (run?.providerInstanceId !== "antigravity" || !["completed", "failed"].includes(run.status))
    return null;
  const items = (projection.turnItems ?? []).filter((i) => i.runId === run.id);
  const answer = items.filter((i) => i.type === "assistant_message").at(-1);
  if (!answer || answer.streaming || !banner.test(answer.text?.trim() ?? "")) return null;
  const thread = (projection.providerThreads ?? []).find((t) => t.id === run.providerThreadId);
  const ref = thread?.nativeThreadRef;
  if (
    thread?.driver !== "antigravity" ||
    ref?.driver !== "antigravity" ||
    ref.strength !== "strong" ||
    !/^[a-zA-Z0-9-]{1,80}$/.test(ref.nativeId)
  )
    return null;
  const start = Date.parse(run.requestedAt),
    end = Date.parse(run.completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (
    (projection.runs ?? []).some(
      (r) =>
        r.id !== run.id &&
        r.providerThreadId === run.providerThreadId &&
        Date.parse(r.requestedAt) <= end &&
        (!r.completedAt || Date.parse(r.completedAt) >= start),
    )
  )
    return null;
  try {
    const root = NodeFS.realpathSync(providersDirectory);
    const files = [];
    for (const profile of NodeFS.readdirSync(root)) {
      if (!/^[a-f0-9]{64}$/.test(profile)) continue;
      try {
        const file = managed(
          root,
          [profile, "antigravity-acp", "conversations", ref.nativeId + ".db"],
          true,
        );
        if (file) files.push(file);
      } catch {}
    }
    if (files.length !== 1) return null;
    const file = files[0];
    // Immutable reads cannot include an active WAL; ambiguity must not cause a switch.
    if (NodeFS.existsSync(file + "-wal")) return null;
    const before = NodeFS.statSync(file);
    const url = NodeURL.pathToFileURL(file);
    url.search = "?mode=ro&immutable=1";
    const NodeSqlite = await import("node:sqlite");
    const database = new NodeSqlite.DatabaseSync(url.href, { readOnly: true });
    let step;
    try {
      step = database
        .prepare(
          "SELECT step_type AS type, substr(metadata,1,512) AS metadata, substr(step_payload,1,16384) AS payload FROM steps ORDER BY idx DESC LIMIT 1",
        )
        .get();
    } finally {
      database.close();
    }
    const after = NodeFS.lstatSync(file);
    if (
      after.isSymbolicLink() ||
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      NodeFS.existsSync(file + "-wal")
    )
      return null;
    const time = nativeStepTime(step?.metadata);
    const text = new TextDecoder().decode(step?.payload ?? new Uint8Array());
    if (
      step?.type !== 17 ||
      !(time >= start && time <= end) ||
      !/Error 429,/.test(text) ||
      !/Status: RESOURCE_EXHAUSTED\b/.test(text) ||
      !/\breason:QUOTA_EXHAUSTED\b/.test(text)
    )
      return null;
    return {
      runId: run.id,
      type: "provider_error",
      creationSource: "provider",
      createdBy: "system",
      ordinal: Math.max(...items.map((i) => i.ordinal ?? 0)) + 1,
      failure: {
        class: "usage_limit",
        code: "QUOTA_EXHAUSTED",
        message: "Antigravity reported a quota limit for this model connection.",
      },
    };
  } catch {
    return null;
  }
}
