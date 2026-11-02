export type JevTeamStep = {
  id: string;
  content: string;
  status: "completed" | "in_progress" | "pending" | "failed" | "cancelled";
};

export type JevTeamRow = {
  threadId: string;
  parentThreadId: string | null;
  title: string;
  provider: string;
  model: string | null;
  effort: string;
  state: "running" | "waiting" | "blocked" | "completed" | "failed";
  activity: string;
  steps: JevTeamStep[];
  updatedAt: string | null;
  completedAt: string | null;
  result: string | null;
};

export type JevTeamPayload = {
  kind: "jev.team.v1";
  updating: boolean;
  incomplete: boolean;
  rows: JevTeamRow[];
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fields(value: Record<string, unknown>, names: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === names.length && keys.every((key) => names.includes(key));
}

function text(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" && value.length <= 600 && (allowEmpty || value.trim().length > 0)
  );
}

function timestamp(value: unknown): value is string | null {
  return value === null || (text(value) && Number.isFinite(Date.parse(value)));
}

function step(value: unknown): value is JevTeamStep {
  return (
    record(value) &&
    fields(value, ["id", "content", "status"]) &&
    text(value.id) &&
    text(value.content) &&
    typeof value.status === "string" &&
    ["completed", "in_progress", "pending", "failed", "cancelled"].includes(value.status)
  );
}

function allItems<T>(values: unknown[], validate: (value: unknown) => value is T): values is T[] {
  for (const value of values) if (!validate(value)) return false;
  return true;
}

function row(value: unknown): value is JevTeamRow {
  if (
    !record(value) ||
    !fields(value, [
      "threadId",
      "parentThreadId",
      "title",
      "provider",
      "model",
      "effort",
      "state",
      "activity",
      "steps",
      "updatedAt",
      "completedAt",
      "result",
    ])
  )
    return false;
  return (
    text(value.threadId) &&
    (value.parentThreadId === null || text(value.parentThreadId)) &&
    text(value.title) &&
    text(value.provider) &&
    (value.model === null || text(value.model)) &&
    text(value.effort) &&
    typeof value.state === "string" &&
    ["running", "waiting", "blocked", "completed", "failed"].includes(value.state) &&
    text(value.activity, true) &&
    Array.isArray(value.steps) &&
    value.steps.length <= 12 &&
    allItems(value.steps, step) &&
    new Set(value.steps.map((entry) => entry.id)).size === value.steps.length &&
    timestamp(value.updatedAt) &&
    timestamp(value.completedAt) &&
    (value.result === null || text(value.result, true))
  );
}

export function parseJevTeamPayload(input: unknown): JevTeamPayload | null {
  let value = input;
  if (typeof value === "string") {
    if (value.length >= 14_000) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (
    !record(value) ||
    !fields(value, ["kind", "updating", "incomplete", "rows"]) ||
    value.kind !== "jev.team.v1" ||
    typeof value.updating !== "boolean" ||
    typeof value.incomplete !== "boolean" ||
    !Array.isArray(value.rows) ||
    value.rows.length > 30 ||
    !allItems(value.rows, row)
  )
    return null;

  const rows = value.rows;
  const byId = new Map(rows.map((entry) => [entry.threadId, entry]));
  if (byId.size !== rows.length) return null;
  for (const entry of rows) {
    const visited = new Set([entry.threadId]);
    let parent = entry.parentThreadId;
    while (parent !== null) {
      if (visited.has(parent)) return null;
      visited.add(parent);
      const ancestor = byId.get(parent);
      if (!ancestor) return null;
      parent = ancestor.parentThreadId;
    }
  }
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length >= 14_000) return null;
  } catch {
    return null;
  }
  return value as JevTeamPayload;
}

// Timeline grouping and rendering share the immutable work entry. Validate its wire input once.
const entryPayloads = new WeakMap<object, JevTeamPayload | null>();
export function jevTeamPayloadForEntry(entry: unknown): JevTeamPayload | null {
  if (!record(entry)) return null;
  if (entryPayloads.has(entry)) return entryPayloads.get(entry) ?? null;
  const projected = record(entry.projectedItem) ? entry.projectedItem.item : undefined;
  const structured = entry.structuredPayload;
  let payload: JevTeamPayload | null = null;
  for (const item of [projected, structured]) {
    if (record(item) && item.type === "dynamic_tool") {
      payload = parseJevTeamPayload(item.input);
      if (payload) break;
    }
  }
  entryPayloads.set(entry, payload);
  return payload;
}
