import type { ChildThreadUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { seedUserInputDraftAnswers } from "@t3tools/client-runtime/state/thread-requests";
import {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "@t3tools/client-runtime/state/pending-user-input";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

export function ChildQuestion({ entry }: { entry: ChildThreadUserInput }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToUserInput, { reportFailure: false });
  const dismiss = useAtomCommand(threadEnvironment.dismissUserInput, { reportFailure: false });
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const inputId = useId();
  const { userInput } = entry;
  const answers = seedUserInputDraftAnswers(userInput.questions, drafts);
  const resolvedAnswers = buildPendingUserInputAnswers(userInput.questions, answers);
  const disabled =
    !canRespond || sending || sent !== null || userInput.responseCapability === "not_resumable";

  const submit = async (dismissRequest = false) => {
    if (disabled || inFlight.current || (!dismissRequest && !resolvedAnswers)) return;
    if (dismissRequest && !userInput.dismissible) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    const input = { threadId: entry.thread.threadId, requestId: userInput.requestId };
    const result = dismissRequest
      ? await dismiss({ environmentId: entry.thread.environmentId, input })
      : await respond({
          environmentId: entry.thread.environmentId,
          input: { ...input, answers: resolvedAnswers! },
        });
    if (result._tag === "Success") setSent(dismissRequest ? "Question dismissed" : "Answer sent");
    else if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(
        failure instanceof Error ? failure.message : "Could not send your answer. Try again.",
      );
    }
    inFlight.current = false;
    setSending(false);
  };

  return (
    <section
      aria-label={`Question from ${entry.title}`}
      className="rounded-lg border border-border bg-background p-3 text-sm"
    >
      <p className="mb-3 font-medium wrap-anywhere">{entry.title} needs your answer</p>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex flex-col gap-4">
          {userInput.questions.map((question, index) => (
            <fieldset key={question.id} disabled={disabled} className="min-w-0">
              <legend className="mb-2 whitespace-pre-wrap wrap-anywhere">
                {question.question}
              </legend>
              <div className="flex flex-col gap-1">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  const selected = isPendingUserInputOptionSelected(
                    question,
                    answers[question.id],
                    value,
                  );
                  return (
                    <Button
                      key={value}
                      variant={selected ? "secondary" : "outline"}
                      size="sm-multiline"
                      aria-pressed={selected}
                      onClick={() =>
                        setDrafts((previous) => ({
                          ...previous,
                          [question.id]: togglePendingUserInputOptionSelection(
                            question,
                            answers[question.id],
                            value,
                          ),
                        }))
                      }
                    >
                      <span className="flex size-4 shrink-0 items-center">
                        {selected ? <CheckIcon aria-hidden /> : null}
                      </span>
                      <span className="min-w-0 flex-1 text-start wrap-anywhere">
                        <span className="block">{option.label}</span>
                        {option.description ? (
                          <span className="block font-normal text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  );
                })}
              </div>
              {question.allowCustomAnswer !== false ? (
                <div className="mt-2">
                  <label
                    htmlFor={`${inputId}-${index}`}
                    className="mb-1 block text-muted-foreground"
                  >
                    Your answer: {question.header}
                  </label>
                  <Textarea
                    id={`${inputId}-${index}`}
                    value={answers[question.id]?.customAnswer ?? ""}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDrafts((previous) => ({
                        ...previous,
                        [question.id]: setPendingUserInputCustomAnswer(
                          question,
                          answers[question.id],
                          value,
                        ),
                      }));
                    }}
                  />
                </div>
              ) : null}
            </fieldset>
          ))}
        </div>
        {userInput.responseCapability === "not_resumable" ? (
          <p className="mt-2 text-warning">
            This agent disconnected. Resume its task before answering.
          </p>
        ) : null}
        {!canRespond ? (
          <p className="mt-2 text-muted-foreground">This connection has read-only access.</p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" disabled={disabled || resolvedAnswers === null}>
            {sending ? "Sending…" : "Send answers"}
          </Button>
          {userInput.dismissible ? (
            <Button variant="ghost" size="sm" disabled={disabled} onClick={() => void submit(true)}>
              Dismiss
            </Button>
          ) : null}
          {sent ? (
            <p role="status" className="text-muted-foreground">
              {sent}
            </p>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-destructive">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
