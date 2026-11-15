import type { PlanStep, SourceInfo } from "./events";

/** A source as it was when saved: enough to keep citation numbers stable and to verify claims against it. */
export interface SourceSnapshot extends SourceInfo {
  excerpt: string;
}

/**
 * What an in-progress turn has finished so far. Saved after each completed step (a search round, the plan,
 * each researcher), so a turn cut off by a crash can continue from the last finished step instead of
 * starting over. A model call that was mid-flight is not resumable (it is simply repeated); everything
 * before it is kept: the plan, each finished researcher's notes, and every source with its citation number.
 */
export interface Checkpoint {
  v: 1;
  route?: { path: "fast" | "deep"; reason: string };
  sources?: SourceSnapshot[];
  /** Fast path: the evidence text each search round returned, in order. */
  evidence?: string[];
  /** Deep path: the sub-questions, and the notes of each one that finished (by step id). */
  plan?: PlanStep[];
  notes?: Record<string, string>;
}

export interface CheckpointIO {
  /** What an interrupted earlier attempt of this turn had saved (present only when resuming). */
  resume?: Checkpoint;
  save(patch: Partial<Checkpoint>): void;
}

/** The turn being continued: its question is already stored, so none is added. */
export interface ResumeTarget {
  conversationId: string;
  userMessageId: string;
}
