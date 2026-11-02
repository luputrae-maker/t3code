import { describe, expect, it } from "vite-plus/test";
import { parseJevTeamPayload, jevTeamPayloadForEntry } from "./JevTeamPanel.logic";

const row = {
  threadId: "main",
  parentThreadId: null,
  title: "Build signup",
  provider: "Codex",
  model: "gpt-6.1-sol",
  effort: "high",
  state: "running",
  activity: "Adding errors",
  steps: [{ id: "one", content: "Add validation", status: "in_progress" }],
  updatedAt: "2026-11-02T12:00:00Z",
  completedAt: null,
  result: null,
};
const payload = { kind: "jev.team.v1", updating: true, incomplete: false, rows: [row] };

describe("parseJevTeamPayload", () => {
  it("preserves exact model, effort and real steps from bounded input", () => {
    expect(parseJevTeamPayload(payload)).toEqual(payload);
    expect(
      parseJevTeamPayload({
        ...payload,
        rows: [{ ...row, model: null, effort: "Provider default" }],
      })?.rows[0]?.model,
    ).toBeNull();
    expect(parseJevTeamPayload(JSON.stringify(payload))).toEqual(payload);
  });

  it.each([
    null,
    {},
    { ...payload, rows: Array(1) },
    { ...payload, rows: [{ ...row, steps: Array(1) }] },
    { ...payload, kind: "jev.team.v2" },
    { ...payload, updating: "yes" },
    { ...payload, rows: [{ ...row, state: "unknown" }] },
    { ...payload, rows: [{ ...row, effort: "" }] },
    { ...payload, rows: [{ ...row, title: "x".repeat(601) }] },
    { ...payload, rows: [{ ...row, updatedAt: "not-a-date" }] },
    { ...payload, rows: [{ ...row, steps: [{ id: "one", content: "Task", status: "unknown" }] }] },
    {
      ...payload,
      rows: [
        {
          ...row,
          steps: Array.from({ length: 13 }, (_, i) => ({
            id: String(i),
            content: "Task",
            status: "pending",
          })),
        },
      ],
    },
    { ...payload, rows: [{ ...row, steps: [row.steps[0], row.steps[0]] }] },
    { ...payload, rows: [row, row] },
    { ...payload, rows: [{ ...row, parentThreadId: "missing" }] },
    { ...payload, rows: [{ ...row, parentThreadId: "main" }] },
    {
      ...payload,
      rows: [
        { ...row, parentThreadId: "child" },
        { ...row, threadId: "child", parentThreadId: "main" },
      ],
    },
    { ...payload, rows: Array.from({ length: 31 }, (_, i) => ({ ...row, threadId: String(i) })) },
    {
      ...payload,
      rows: Array.from({ length: 24 }, (_, i) => ({
        ...row,
        threadId: String(i),
        title: "界".repeat(300),
      })),
    },
    { ...payload, injected: "unexpected" },
    "{bad json",
    " ".repeat(14_000),
  ])("rejects malformed or unbounded input %#", (value) => {
    expect(parseJevTeamPayload(value)).toBeNull();
  });
});

it("reads only dynamic tool input and falls back from projected to structured input", () => {
  expect(
    jevTeamPayloadForEntry({ projectedItem: { item: { type: "dynamic_tool", input: payload } } }),
  ).toEqual(payload);
  expect(
    jevTeamPayloadForEntry({ structuredPayload: { type: "dynamic_tool", input: payload } }),
  ).toEqual(payload);
  expect(
    jevTeamPayloadForEntry({
      projectedItem: { item: { type: "dynamic_tool", input: {} } },
      structuredPayload: { type: "dynamic_tool", input: payload },
    }),
  ).toEqual(payload);
  expect(
    jevTeamPayloadForEntry({ structuredPayload: { type: "command", input: payload } }),
  ).toBeNull();
  expect(
    jevTeamPayloadForEntry({ structuredPayload: { type: "dynamic_tool", output: payload } }),
  ).toBeNull();
});
