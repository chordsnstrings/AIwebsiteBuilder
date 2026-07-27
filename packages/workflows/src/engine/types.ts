// Durable workflow engine — public types. A deliberate subset of the Temporal
// TypeScript API so the runtime can be swapped for Temporal Cloud later with no
// change to workflow definitions.

export interface Clock {
  now(): number;
}

export class SystemClock implements Clock {
  now(): number {
    return Date.now();
  }
}

/** Virtual clock for deterministic time-skipping in tests. */
export class TestClock implements Clock {
  private t: number;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

export interface WorkflowContext {
  /** Deterministic current time (from the engine's clock), never Date.now(). */
  now(): Date;
  /** Run an activity by name; result is journaled and memoized on replay. */
  activity<In, Out>(name: string, input: In): Promise<Out>;
  /** Durable timer. Suspends the workflow until the wall clock passes it. */
  sleep(name: string, ms: number): Promise<void>;
  /** Wait for a signal by name (optionally with a timeout). Returns its payload. */
  waitForSignal<T>(name: string, timeoutMs?: number): Promise<{ received: boolean; payload?: T }>;
  /** Wait until a predicate holds, re-checked on each resume, up to a timeout. */
  condition(name: string, predicate: () => boolean, timeoutMs?: number): Promise<boolean>;
  /** Versioning guard: returns true for executions started after this patch. */
  patched(patchId: string): boolean;
  /** Deterministic side effect: journaled so replay returns the same value. */
  sideEffect<T>(name: string, fn: () => T): Promise<T>;
  /** The execution id. */
  readonly executionId: string;
}

export type WorkflowFn<In, Out> = (ctx: WorkflowContext, input: In) => Promise<Out>;

export interface WorkflowDefinition<In, Out> {
  type: string;
  run: WorkflowFn<In, Out>;
}

export type ActivityFn = (input: unknown) => Promise<unknown>;

/** Thrown internally to suspend a workflow until a timer fires or a signal arrives. */
export class Suspension {
  constructor(
    public readonly reason: "timer" | "signal" | "condition",
    public readonly detail: string,
  ) {}
}
