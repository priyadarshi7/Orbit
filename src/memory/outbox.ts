import type { MemoryStore } from "./store";

export type JobHandler = (payload: any) => Promise<void>;

export interface OutboxOptions {
  maxAttempts?: number;
  nowMs?: () => number;
  /** Called once when a job has exhausted its attempts. */
  onGiveUp?: (kind: string, payload: unknown, error: string) => void;
  log?: (msg: string) => void;
}

/**
 * Durable background jobs. Producers `enqueue` (idempotent per dedupe key);
 * the worker drains the table after the response is sent. A crash leaves jobs
 * in the table; `start()` puts interrupted ones back to pending.
 */
export class OutboxWorker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly maxAttempts: number;
  private readonly nowMs: () => number;

  constructor(
    private readonly store: MemoryStore,
    private readonly handlers: Record<string, JobHandler>,
    private readonly opts: OutboxOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.nowMs = opts.nowMs ?? Date.now;
  }

  start(): void {
    const n = this.store.recoverOutbox();
    if (n) this.opts.log?.(`outbox: recovered ${n} interrupted job(s)`);
    void this.drain();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  enqueue(kind: string, dedupeKey: string, payload: unknown, createdAt: string): void {
    this.store.enqueue(kind, dedupeKey, payload, this.nowMs(), createdAt);
    // Run after the current tick so the response is never delayed by it.
    setImmediate(() => void this.drain());
  }

  /** Process every due job; resolves when none are left due. */
  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (true) {
        const job = this.store.claimNextJob(this.nowMs());
        if (!job) break;
        const handler = this.handlers[job.kind];
        try {
          if (!handler) throw new Error(`no handler for job kind "${job.kind}"`);
          await handler(job.payload);
          this.store.completeJob(job.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (job.attempts >= this.maxAttempts) {
            this.store.failJob(job.id, msg, null);
            this.opts.log?.(`outbox: ${job.kind} #${job.id} gave up: ${msg}`);
            try {
              this.opts.onGiveUp?.(job.kind, job.payload, msg);
            } catch {
              /* never let the fallback break the loop */
            }
          } else {
            const delay = 1500 * 2 ** (job.attempts - 1);
            this.store.failJob(job.id, msg, this.nowMs() + delay);
            this.schedule(delay);
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delayMs + 20);
    this.timer.unref?.();
  }
}
