import { expect, it } from "vite-plus/test";
import { render } from "../../../test/render";
import { JevTeamPanel } from "./JevTeamPanel";
import type { JevTeamPayload } from "./JevTeamPanel.logic";

it("updates the visible checklist without hiding subagents or completing unreported steps", async () => {
  const payload: JevTeamPayload = {
    kind: "jev.team.v1",
    updating: true,
    incomplete: false,
    rows: [
      {
        threadId: "main",
        parentThreadId: null,
        title: "Implement signup",
        provider: "Claude",
        model: "claude-opus-4-7",
        effort: "max",
        state: "running",
        activity: "Editing validation",
        steps: [
          { id: "review", content: "Review existing form", status: "completed" },
          { id: "validation", content: "Add clear errors", status: "in_progress" },
          { id: "verify", content: "Verify signup", status: "pending" },
        ],
        updatedAt: null,
        completedAt: null,
        result: null,
      },
      {
        threadId: "child",
        parentThreadId: "main",
        title: "Test signup errors",
        provider: "Codex",
        model: null,
        effort: "Provider default",
        state: "waiting",
        activity: "Waiting for validation",
        steps: [],
        updatedAt: null,
        completedAt: null,
        result: null,
      },
    ],
  };
  await using screen = await render(<JevTeamPanel payload={payload} timestampFormat="24-hour" />);
  await expect.element(screen.getByText("Add clear errors", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Verify signup", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("claude-opus-4-7", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Effort: max", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Model not reported", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Effort: Provider default", { exact: true })).toBeVisible();
  const main = screen.container.querySelector('[data-jev-thread-id="main"]');
  expect(main?.querySelector('[data-jev-thread-id="child"]')).not.toBeNull();
  expect(main?.querySelector('[aria-current="step"]')?.textContent).toContain("Add clear errors");

  await screen.rerender(
    <JevTeamPanel
      payload={{
        ...payload,
        updating: false,
        incomplete: true,
        rows: payload.rows.map((row) =>
          row.threadId === "main"
            ? {
                ...row,
                state: "completed",
                activity: "",
                completedAt: "2026-11-02T12:00:00Z",
                result: "Validation ready",
                steps: row.steps.map((step) =>
                  step.id === "validation" ? { ...step, status: "completed" } : step,
                ),
              }
            : row,
        ),
      }}
      timestampFormat="24-hour"
    />,
  );
  await expect.element(screen.getByText("Updates paused", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByText("Some activity is omitted.", { exact: true }))
    .toBeVisible();
  await expect.element(screen.getByText("Validation ready", { exact: true })).toBeVisible();
  const pending = screen.container.querySelector('[data-jev-step-id="verify"]');
  expect(pending?.getAttribute("data-step-status")).toBe("pending");
  expect(screen.container.querySelectorAll('[data-step-status="completed"]')).toHaveLength(2);
  await expect.element(screen.getByText("Test signup errors", { exact: true })).toBeVisible();
});
