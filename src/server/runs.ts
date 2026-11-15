import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../agent/events";
import type { Checkpoint, CheckpointIO } from "../agent/checkpoint";
import { runTurn, type AgentDeps, type TurnRequest } from "../agent/run";
import type { RunStatus } from "../memory/store";

/**
 * A chat turn as a first-class run, independent of the HTTP request that started it.
 *
 *  - The turn keeps going if the browser disconnects, so a refresh or a network blip does not waste the
 *    model and search work already done; the finished answer is saved like any other.
 *  - Every event is kept in a short in-memory log with a sequence number. A client that reconnects (same
 *    request id, `Last-Event-ID`) is replayed what it missed and then follows live.
 *  - A durable `runs` row records how the turn ended (done, failed, stopped, interrupted), so a crash or
 *    restart is visible afterwards instead of leaving a question with no answer.
 *  - Stopping is an explicit `cancel`, not a side effect of a closed connection.
 *
 * In-process by design (single node). Moving to several instances means replacing the event log with a
 * shared stream (Redis streams or similar) and `interruptRunningRuns` with a heartbeat; the routes would not change.
 */
export interface ActiveRun {
  id: string;
  userId: string;
  requestId?: string;
  events: AgentEvent[];
  finished: boolean;
  status: RunStatus;
  cancelled: boolean;
  readonly ac: AbortController;
  readonly waiters: Set<() => void>;
  readonly startedAtMs: number;
  timer?: NodeJS.Timeout;
}

export interface LoggedEvent {
  seq: number;
  event: AgentEvent;
}

export interface RunManagerOptions {
  /** Backstop for a turn that never finishes (a provider that never answers). */
  hardTimeoutMs: number;
  /** How long a finished run's events stay replayable. */
  retainMs?: number;
}

export type StartBody = Omit<TurnRequest, "signal" | "checkpoint"> & {
  requestId?: string;
  /** Continuing an interrupted run: which one, and what it had saved. */
  resumedFrom?: string;
  saved?: Checkpoint;
};

export class RunManager {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly byRequestKey = new Map<string, string>();

  constructor(
    private readonly deps: AgentDeps,
    private readonly opts: RunManagerOptions,
  ) {}

  get(userId: string, runId: string): ActiveRun | undefined {
    const r = this.runs.get(runId);
    return r && r.userId === userId ? r : undefined;
  }

  byRequest(userId: string, requestId: string): ActiveRun | undefined {
    const id = this.byRequestKey.get(`${userId}:${requestId}`);
    return id ? this.get(userId, id) : undefined;
  }

  /** Starts a turn and returns at once; it runs to completion whether or not anyone is listening. */
  start(userId: string, body: StartBody, release: () => void): ActiveRun {
    const id = randomUUID();
    const run: ActiveRun = {
      id,
      userId,
      requestId: body.requestId,
      events: [],
      finished: false,
      status: "running",
      cancelled: false,
      ac: new AbortController(),
      waiters: new Set(),
      startedAtMs: Date.now(),
    };
    // Throws on a duplicate request id (the unique index), before anything is registered or started.
    this.deps.store.forUser(userId).createRun({
      id,
      requestId: body.requestId,
      conversationId: body.resume?.conversationId ?? body.conversationId,
      startedAt: this.deps.clock.now().toISOString(),
      resumedFrom: body.resumedFrom,
    });
    this.runs.set(id, run);
    if (body.requestId) this.byRequestKey.set(`${userId}:${body.requestId}`, id);
    void this.execute(run, body, release);
    return run;
  }

  /** The Stop button. Returns false when the run is unknown, not the caller's, or already over. */
  cancel(userId: string, runId: string): boolean {
    const run = this.get(userId, runId);
    if (!run || run.finished) return false;
    run.cancelled = true;
    run.ac.abort();
    return true;
  }

  /** Replays events after `after` (use -1 for all), then follows live until the run ends or `signal` aborts. */
  async *stream(run: ActiveRun, after: number, signal?: AbortSignal): AsyncGenerator<LoggedEvent> {
    let i = Math.max(0, after + 1);
    while (true) {
      while (i < run.events.length) {
        yield { seq: i, event: run.events[i]! };
        i++;
      }
      if (run.finished || signal?.aborted) return;
      // No await between the check above and registering the waiter, so a push cannot be missed.
      await new Promise<void>((resolve) => {
        const wake = () => {
          run.waiters.delete(wake);
          signal?.removeEventListener("abort", wake);
          resolve();
        };
        run.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
      });
    }
  }

  private push(run: ActiveRun, event: AgentEvent): void {
    run.events.push(event);
    for (const wake of [...run.waiters]) wake();
  }

  private async execute(run: ActiveRun, body: StartBody, release: () => void): Promise<void> {
    const store = this.deps.store.forUser(run.userId);
    const turnDeps: AgentDeps = { ...this.deps, store };
    let done: Extract<AgentEvent, { type: "done" }> | undefined;
    let failed: string | undefined;

    // Progress is saved after each finished step, so a crash costs at most the step that was running.
    const progress: Checkpoint = { v: 1, ...(body.saved ?? {}) };
    const checkpoint: CheckpointIO = {
      resume: body.saved,
      save: (patch) => {
        Object.assign(progress, patch);
        try {
          store.saveCheckpoint(run.id, JSON.stringify(progress));
        } catch {
          /* a failed save only means a later resume starts further back */
        }
      },
    };

    run.timer = setTimeout(() => {
      run.ac.abort();
      this.finish(run, "failed", release, { error: "This answer took too long and was stopped." });
    }, this.opts.hardTimeoutMs);
    run.timer.unref?.();

    try {
      for await (const ev of runTurn(turnDeps, { ...body, signal: run.ac.signal, checkpoint })) {
        if (run.finished) continue; // a late event from a turn that was already given up on
        const out: AgentEvent = ev.type === "start" ? { ...ev, runId: run.id } : ev;
        this.push(run, out);
        if (ev.type === "start") store.setRunTarget(run.id, ev.conversationId, ev.userMessageId);
        else if (ev.type === "done") done = ev;
        else if (ev.type === "error") failed = ev.message;
      }
    } catch (e) {
      failed = e instanceof Error ? e.message : "The answer failed.";
    }

    if (run.finished) return;
    if (done) this.finish(run, run.cancelled ? "stopped" : "done", release, { assistantMessageId: done.messageId });
    else if (run.cancelled) this.finish(run, "stopped", release);
    else this.finish(run, "failed", release, { error: failed ?? "The answer ended unexpectedly." });
  }

  /** Idempotent: records the outcome, tells any listener the stream is over, frees the user's slot. */
  private finish(
    run: ActiveRun,
    status: Exclude<RunStatus, "running" | "interrupted">,
    release: () => void,
    extra: { error?: string; assistantMessageId?: string } = {},
  ): void {
    if (run.finished) return;
    if (status === "failed" && !run.events.some((e) => e.type === "error")) {
      this.push(run, { type: "error", message: extra.error ?? "The answer failed.", t: Date.now() - run.startedAtMs });
    }
    run.finished = true;
    run.status = status;
    if (run.timer) clearTimeout(run.timer);
    try {
      this.deps.store.forUser(run.userId).finishRun(run.id, status, this.deps.clock.now().toISOString(), extra);
    } catch {
      /* the database may be closing; the in-memory state is already final */
    }
    for (const wake of [...run.waiters]) wake();
    release();
    const gone = setTimeout(() => {
      this.runs.delete(run.id);
      if (run.requestId) this.byRequestKey.delete(`${run.userId}:${run.requestId}`);
    }, this.opts.retainMs ?? 10 * 60_000);
    gone.unref?.();
  }

  /** Aborts everything in flight (used on shutdown; the durable record then says "interrupted" at next start). */
  abortAll(): void {
    for (const r of this.runs.values()) if (!r.finished) r.ac.abort();
  }
}
