import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  GitBranchIcon,
  PauseIcon,
  XIcon,
} from "lucide-react";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import type { JevTeamPayload, JevTeamRow, JevTeamStep } from "./JevTeamPanel.logic";

type JevTeamPanelProps = {
  payload: JevTeamPayload;
  timestampFormat: TimestampFormat;
};

const stateLabels = {
  running: "Working",
  waiting: "Waiting",
  blocked: "Blocked",
  completed: "Done",
  failed: "Failed",
};

function Step({ step, row, updating }: { step: JevTeamStep; row: JevTeamRow; updating: boolean }) {
  const current = step.status === "in_progress";
  const working = current && row.state === "running" && updating;
  const failed = step.status === "failed";
  const Icon =
    step.status === "completed"
      ? CheckIcon
      : current
        ? CircleDotIcon
        : failed
          ? CircleAlertIcon
          : step.status === "cancelled"
            ? XIcon
            : CircleIcon;
  return (
    <li
      data-jev-step-id={step.id}
      data-step-status={step.status}
      aria-current={working ? "step" : undefined}
      className={cn(
        "grid grid-cols-[1rem_minmax(0,1fr)] items-start gap-2 rounded-md px-2 py-1 text-xs leading-relaxed",
        current ? "my-1 bg-success/10 py-2 text-foreground" : "text-muted-foreground",
        failed && "text-destructive",
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "mt-0.5 size-3.5",
          (current || step.status === "completed") && "text-success",
        )}
      />
      <div className="min-w-0 whitespace-pre-wrap wrap-anywhere">
        {current ? (
          <span className="mb-0.5 block text-2xs font-medium text-success">
            {working ? "Working on" : "Last reported step"}
          </span>
        ) : (
          <span className="sr-only">
            {step.status === "completed"
              ? "Completed: "
              : step.status === "pending"
                ? "Pending: "
                : `${step.status}: `}
          </span>
        )}
        {step.status === "pending" && <span className="me-1.5 text-2xs">Next</span>}
        <span className={current ? "font-medium" : undefined}>{step.content}</span>
        {current && row.activity && (
          <span className="mt-1 block text-muted-foreground">{row.activity}</span>
        )}
      </div>
    </li>
  );
}

function Agent({
  row,
  childrenByParent,
  depth,
  updating,
  timestampFormat,
}: {
  row: JevTeamRow;
  childrenByParent: ReadonlyMap<string | null, JevTeamRow[]>;
  depth: number;
  updating: boolean;
  timestampFormat: TimestampFormat;
}) {
  const children = childrenByParent.get(row.threadId) ?? [];
  const hasCurrentStep = row.steps.some((step) => step.status === "in_progress");
  const terminal = row.state === "completed" || row.state === "failed";
  const Icon =
    row.state === "completed"
      ? CircleCheckIcon
      : row.state === "failed" || row.state === "blocked"
        ? CircleAlertIcon
        : row.state === "waiting"
          ? PauseIcon
          : CircleDotIcon;
  return (
    <section aria-label={row.title} data-jev-thread-id={row.threadId} className="min-w-0">
      <div className="px-3 py-3 sm:px-4">
        <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1 basis-48">
            <h3 className="text-sm font-medium whitespace-pre-wrap wrap-anywhere text-foreground">
              {row.title}
            </h3>
            <p className="mt-0.5 text-xs wrap-anywhere text-muted-foreground">
              {row.provider} · {row.parentThreadId === null ? "Main agent" : "Subagent"}
            </p>
            <p className="mt-0.5 flex flex-wrap gap-x-2 text-xs wrap-anywhere text-muted-foreground">
              <span>{row.model ?? "Model not reported"}</span>
              <span>Effort: {row.effort}</span>
            </p>
          </div>
          <span
            className={cn(
              "flex items-center gap-1.5 pt-0.5 text-xs font-medium",
              row.state === "completed" || row.state === "running"
                ? "text-success"
                : row.state === "failed" || row.state === "blocked"
                  ? "text-destructive"
                  : "text-muted-foreground",
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            {row.state === "running" && !updating ? "Last seen working" : stateLabels[row.state]}
          </span>
        </header>
        {row.steps.length > 0 && (
          <ol aria-label={`${row.title} steps`} className="mt-2 space-y-0.5">
            {row.steps.map((step) => (
              <Step key={step.id} step={step} row={row} updating={updating} />
            ))}
          </ol>
        )}
        {!hasCurrentStep && row.activity && (
          <p className="mt-2 whitespace-pre-wrap wrap-anywhere text-xs text-muted-foreground">
            {row.activity}
          </p>
        )}
        {(row.result || (terminal && row.completedAt)) && (
          <div className="mt-2 space-y-1 text-xs text-muted-foreground">
            {terminal && row.completedAt && (
              <p>
                Finished at{" "}
                <time dateTime={row.completedAt}>
                  {formatShortTimestamp(row.completedAt, timestampFormat)}
                </time>
              </p>
            )}
            {row.result && <p className="whitespace-pre-wrap wrap-anywhere">{row.result}</p>}
          </div>
        )}
        {row.updatedAt && !terminal && (
          <p className="mt-2 text-2xs text-muted-foreground">
            Updated{" "}
            <time dateTime={row.updatedAt}>
              {formatShortTimestamp(row.updatedAt, timestampFormat)}
            </time>
          </p>
        )}
      </div>
      {children.length > 0 && (
        <div
          aria-label={`Subagents of ${row.title}`}
          className={cn("border-l border-border/70", depth < 3 && "ms-3 sm:ms-5")}
        >
          {children.map((child) => (
            <div key={child.threadId} className="border-t border-border/70">
              <Agent
                row={child}
                childrenByParent={childrenByParent}
                depth={depth + 1}
                updating={updating}
                timestampFormat={timestampFormat}
              />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export function JevTeamPanel({ payload, timestampFormat }: JevTeamPanelProps) {
  const childrenByParent = new Map<string | null, JevTeamRow[]>();
  const counts = { running: 0, waiting: 0, blocked: 0, completed: 0, failed: 0 };
  for (const row of payload.rows) {
    const children = childrenByParent.get(row.parentThreadId) ?? [];
    children.push(row);
    childrenByParent.set(row.parentThreadId, children);
    counts[row.state] += 1;
  }
  const paused =
    !payload.updating &&
    payload.rows.some((row) => row.state !== "completed" && row.state !== "failed");
  const summary = (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((state) => counts[state] > 0)
    .map(
      (state) =>
        `${counts[state]} ${state === "running" ? (paused ? "last seen working" : "working") : state === "completed" ? "done" : state}`,
    )
    .join(" · ");
  return (
    <section
      aria-label="Jev agents"
      className="my-2 min-w-0 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
    >
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border/70 bg-muted/20 px-3 py-2 text-xs sm:px-4">
        <GitBranchIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
        <span className="font-medium">Jev agents</span>
        <span className="text-muted-foreground">{summary}</span>
      </header>
      {(paused || payload.incomplete) && (
        <div
          role="status"
          className="flex flex-wrap gap-x-2 border-b border-border/70 px-3 py-2 text-xs text-muted-foreground sm:px-4"
        >
          {paused && <span>Updates paused</span>}
          {payload.incomplete && <span>Some activity is omitted.</span>}
        </div>
      )}
      <div className="divide-y divide-border/70">
        {(childrenByParent.get(null) ?? []).map((row) => (
          <Agent
            key={row.threadId}
            row={row}
            childrenByParent={childrenByParent}
            depth={0}
            updating={payload.updating}
            timestampFormat={timestampFormat}
          />
        ))}
      </div>
      {payload.rows.length === 0 && (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          No agent activity reported.
        </p>
      )}
    </section>
  );
}
