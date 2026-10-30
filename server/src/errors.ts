/** Errors that stop a run without being failures of the work itself. Kept dependency-free to avoid import cycles. */
export class BudgetExceededError extends Error {}

/** Hard stop: the user pressed "Stop now" (the in-flight agent call is cancelled). */
export class AbortedError extends Error {}

/** Graceful pause: thrown at a safe point between steps; nothing in flight is lost. */
export class PauseRequestedError extends AbortedError {}

export type LimitKind = "rate_limit" | "overloaded" | "network" | "credits" | "auth" | "daily_limit" | "monthly_limit";

/** The API (or one of our spend limits) can't take more work right now. Pauses everything; may resume on its own. */
export class LimitReachedError extends Error {
  constructor(
    message: string,
    public kind: LimitKind,
    public resumeAt: string | null,
  ) {
    super(message);
  }
}
