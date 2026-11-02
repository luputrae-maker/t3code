import type { ChildThreadApproval } from "@t3tools/client-runtime/state/thread-requests";
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  respond: vi.fn(),
  approvalsAtom: null as unknown,
  questionsAtom: null as unknown,
  canRespond: true,
}));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canRespond }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.respond }));
vi.mock("../../state/threads", () => ({
  childThreadApprovalsAtom: () => state.approvalsAtom,
  childThreadUserInputsAtom: () => state.questionsAtom,
  threadEnvironment: { respondToApproval: {}, respondToUserInput: {}, dismissUserInput: {} },
}));

import { ChildThreadRequests } from "./ChildThreadRequests";

function setup() {
  state.respond.mockReset();
  state.canRespond = true;
  state.questionsAtom = Atom.make([]);
  state.respond
    .mockResolvedValueOnce(AsyncResult.failure(Cause.fail(new Error("Child environment offline"))))
    .mockResolvedValueOnce(AsyncResult.success(undefined));
  const thread = {
    environmentId: EnvironmentId.make("child-env"),
    threadId: ThreadId.make("child"),
  };
  state.approvalsAtom = Atom.make<ReadonlyArray<ChildThreadApproval>>([
    {
      thread,
      title: "Compile task",
      approval: {
        requestId: RuntimeRequestId.make("approval"),
        requestKind: "command",
        detail: "Run compiler",
        createdAt: "2026-11-01T00:00:00.000Z",
        responseCapability: "live",
      },
    },
  ]);
  return thread;
}

it("shows a failed decision and clears the error when the user retries", async () => {
  const thread = setup();
  await using screen = await render(<ChildThreadRequests threadRef={thread} />);
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("answers a child question in the parent and keeps the draft after a failed submission", async () => {
  const thread = setup();
  state.approvalsAtom = Atom.make([]);
  state.questionsAtom = Atom.make([
    {
      thread,
      title: "Design review",
      userInput: {
        requestId: RuntimeRequestId.make("question"),
        createdAt: "2026-11-02T00:00:00.000Z",
        responseCapability: "live",
        dismissible: false,
        questions: [
          {
            id: "audience",
            header: "Audience",
            question: "Who is this for?",
            multiSelect: false,
            options: [
              { label: "Founders", value: "founders", description: "People building a business" },
            ],
          },
        ],
      },
    },
  ]);
  await using screen = await render(<ChildThreadRequests threadRef={thread} />);
  await expect.element(screen.getByText("Who is this for?", { exact: true })).toBeVisible();
  await screen.getByRole("textbox", { name: "Your answer: Audience" }).fill("Solo founders");
  await screen.getByRole("button", { name: "Send answers" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Child environment offline");
  await expect
    .element(screen.getByRole("textbox", { name: "Your answer: Audience" }))
    .toHaveValue("Solo founders");
  await screen.getByRole("button", { name: "Send answers" }).click();
  await expect.element(screen.getByRole("status")).toHaveTextContent("Answer sent");
  expect(state.respond).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      threadId: thread.threadId,
      requestId: "question",
      answers: { audience: "Solo founders" },
    },
  });
});

it("keeps simultaneous agents separate and supports multi-select and message answers", async () => {
  const thread = setup();
  state.approvalsAtom = Atom.make([]);
  state.respond.mockReset();
  state.respond.mockResolvedValue(AsyncResult.success(undefined));
  state.questionsAtom = Atom.make([
    {
      thread,
      title: "Research",
      userInput: {
        requestId: RuntimeRequestId.make("research-question"),
        createdAt: "2026-11-02T00:00:00Z",
        responseCapability: "message",
        responseMode: "message",
        dismissible: true,
        questions: [
          {
            id: "markets",
            header: "Markets",
            question: "Which markets?",
            multiSelect: true,
            allowCustomAnswer: false,
            options: [
              { label: "B2B", value: " b2b " },
              { label: "B2C", value: "b2c" },
            ],
          },
        ],
      },
    },
    {
      thread: { ...thread, threadId: ThreadId.make("builder") },
      title: "Build",
      userInput: {
        requestId: RuntimeRequestId.make("build-question"),
        createdAt: "2026-11-02T00:00:00Z",
        responseCapability: "live",
        dismissible: false,
        questions: [
          {
            id: "stack",
            header: "Stack",
            question: "Which stack?",
            multiSelect: false,
            options: [{ label: "React", value: "react" }],
          },
        ],
      },
    },
  ]);
  await using screen = await render(<ChildThreadRequests threadRef={thread} />);
  const research = screen.getByRole("region", { name: "Question from Research" });
  const build = screen.getByRole("region", { name: "Question from Build" });
  await expect.element(research.getByRole("textbox")).not.toBeInTheDocument();
  await expect.element(research.getByRole("button", { name: "Send answers" })).toBeDisabled();
  await research.getByRole("button", { name: "B2B", exact: true }).click();
  await research.getByRole("button", { name: "B2C", exact: true }).click();
  await research.getByRole("button", { name: "Send answers" }).click();
  expect(state.respond).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: {
      threadId: thread.threadId,
      requestId: "research-question",
      answers: { markets: [" b2b ", "b2c"] },
    },
  });
  await build.getByRole("button", { name: "React", exact: true }).click();
  await build.getByRole("button", { name: "Send answers" }).click();
  expect(state.respond).toHaveBeenLastCalledWith({
    environmentId: thread.environmentId,
    input: { threadId: "builder", requestId: "build-question", answers: { stack: "react" } },
  });
});

it("shows questions to read-only clients without allowing a response", async () => {
  const thread = setup();
  state.canRespond = false;
  state.approvalsAtom = Atom.make([]);
  state.questionsAtom = Atom.make([
    {
      thread,
      title: "Design",
      userInput: {
        requestId: RuntimeRequestId.make("readonly-question"),
        createdAt: "2026-11-02T00:00:00Z",
        responseCapability: "live",
        dismissible: false,
        questions: [
          {
            id: "color",
            header: "Color",
            question: "Which color?",
            multiSelect: false,
            options: [],
          },
        ],
      },
    },
  ]);
  await using screen = await render(<ChildThreadRequests threadRef={thread} />);
  await expect.element(screen.getByText("Which color?", { exact: true })).toBeVisible();
  await expect.element(screen.getByRole("textbox")).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Send answers" })).toBeDisabled();
  expect(state.respond).not.toHaveBeenCalled();
});
