/**
 * OneClick CAPI Connector — In-Process Retry Queue
 * -------------------------------------------------
 * A dependency-free, in-memory retry queue with exponential backoff + jitter
 * and bounded concurrency. Chosen deliberately over Redis/BullMQ so the relay
 * stays "deploy in 60 seconds" with ZERO external infrastructure.
 *
 * Semantics:
 *   - A task is a thunk returning a Promise. Throwing (or rejecting) signals a
 *     transient failure and triggers a retry until `maxAttempts` is reached.
 *   - Backoff: delay = min(maxDelayMs, baseDelayMs * factor^(attempt-1)),
 *     optionally multiplied by a random jitter in [0.5, 1.0] to avoid
 *     thundering-herd retries against the upstream API.
 *   - Concurrency is capped so a backlog never opens unbounded sockets.
 *
 * Caveat (by design): this queue is in-memory. If the process restarts, queued
 * retries are lost. For most EC purchase volumes the retry window is seconds,
 * so this is an acceptable trade for zero-infra simplicity. Swap in a durable
 * backend later by implementing the same enqueue() contract.
 *
 * Zero-knowledge note: the queue stores opaque task thunks only. It never sees,
 * inspects, or logs PII — the closures it runs already operate on SHA-256
 * hashes produced by normalizer.ts.
 */

/** Tunable retry-queue behaviour. */
export interface RetryQueueOptions {
  /** Total attempts including the first. Must be >= 1. Default 4. */
  maxAttempts: number;
  /** Base backoff delay in ms for the first retry. Default 500. */
  baseDelayMs: number;
  /** Hard ceiling on any single backoff delay. Default 30000. */
  maxDelayMs: number;
  /** Exponential growth factor per attempt. Default 2. */
  factor: number;
  /** When true, multiply each delay by a random factor in [0.5, 1]. Default true. */
  jitter: boolean;
  /** Max tasks executing simultaneously. Default 8. */
  concurrency: number;
}

/** Outcome reported to the optional lifecycle callbacks. */
export interface RetryTaskContext {
  /** Stable label for logs/metrics (never PII). */
  label: string;
  /** 1-based attempt number being run. */
  attempt: number;
  /** Configured maximum attempts. */
  maxAttempts: number;
}

/** Optional lifecycle hooks for observability. */
export interface RetryQueueHooks {
  /** Fired when a task ultimately succeeds. */
  onSuccess?: (ctx: RetryTaskContext) => void;
  /** Fired after each failed attempt that WILL be retried. */
  onRetry?: (ctx: RetryTaskContext, error: unknown, nextDelayMs: number) => void;
  /** Fired when a task exhausts all attempts and is given up. */
  onGiveUp?: (ctx: RetryTaskContext, error: unknown) => void;
}

/** A unit of deferred work. */
export type RetryTask<T> = () => Promise<T>;

interface InternalJob {
  readonly label: string;
  readonly run: RetryTask<unknown>;
  attempt: number;
  /** Epoch ms at which this job becomes eligible to run. */
  nextRunAt: number;
  /** Timer handle for the scheduled wake-up, if any. */
  timer: ReturnType<typeof setTimeout> | null;
}

/** Sensible production defaults. */
const DEFAULT_OPTIONS: RetryQueueOptions = {
  maxAttempts: 4,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  factor: 2,
  jitter: true,
  concurrency: 8,
};

/**
 * A small, robust, in-process retry queue.
 *
 * Usage:
 *   const q = new RetryQueue({ maxAttempts: 5 });
 *   q.enqueue("meta:order_1001", () => sendToMetaOrThrow(event));
 *   await q.onIdle(); // optional, e.g. in tests or graceful shutdown
 */
export class RetryQueue {
  private readonly options: RetryQueueOptions;
  private readonly hooks: RetryQueueHooks;

  /** Jobs eligible to run now (their backoff has elapsed). */
  private readonly ready: InternalJob[] = [];
  /** Jobs waiting on a backoff timer. */
  private readonly scheduled: Set<InternalJob> = new Set();
  /** Count of currently executing jobs. */
  private active = 0;
  /** Resolvers waiting for the queue to become fully idle. */
  private idleResolvers: Array<() => void> = [];

  public constructor(
    options: Partial<RetryQueueOptions> = {},
    hooks: RetryQueueHooks = {}
  ) {
    const merged: RetryQueueOptions = { ...DEFAULT_OPTIONS, ...options };
    if (merged.maxAttempts < 1) {
      throw new Error("RetryQueue: maxAttempts must be >= 1.");
    }
    if (merged.concurrency < 1) {
      throw new Error("RetryQueue: concurrency must be >= 1.");
    }
    if (merged.baseDelayMs < 0 || merged.maxDelayMs < 0) {
      throw new Error("RetryQueue: delays must be non-negative.");
    }
    this.options = merged;
    this.hooks = hooks;
  }

  /**
   * Adds a task to the queue. Returns immediately (fire-and-forget); use
   * {@link onIdle} to await completion of the whole queue when needed.
   *
   * @param label A PII-free identifier for logs/metrics, e.g. "meta:order_1001".
   * @param task  A thunk that performs the work and THROWS on transient failure.
   */
  public enqueue<T>(label: string, task: RetryTask<T>): void {
    const job: InternalJob = {
      label,
      run: task as RetryTask<unknown>,
      attempt: 0,
      nextRunAt: Date.now(),
      timer: null,
    };
    this.ready.push(job);
    this.pump();
  }

  /** Number of jobs not yet completed (ready + scheduled + active). */
  public size(): number {
    return this.ready.length + this.scheduled.size + this.active;
  }

  /**
   * Resolves once the queue has no ready, scheduled, or active jobs.
   * Resolves immediately if already idle. Useful for tests and graceful drain.
   */
  public onIdle(): Promise<void> {
    if (this.size() === 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }

  /**
   * Computes the backoff delay (ms) for a given 1-based attempt number.
   * Exposed for testing and transparency.
   */
  public computeDelay(attempt: number): number {
    const { baseDelayMs, factor, maxDelayMs, jitter } = this.options;
    const exponential = baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
    const capped = Math.min(maxDelayMs, exponential);
    if (!jitter) {
      return capped;
    }
    // Jitter in [0.5, 1.0] — keeps retries spread out without ever exceeding cap.
    const jitterFactor = 0.5 + Math.random() * 0.5;
    return Math.round(capped * jitterFactor);
  }

  /** Pulls ready jobs into execution slots up to the concurrency limit. */
  private pump(): void {
    while (this.active < this.options.concurrency && this.ready.length > 0) {
      const job = this.ready.shift();
      if (!job) {
        break;
      }
      this.active += 1;
      void this.execute(job);
    }
    this.maybeSignalIdle();
  }

  /** Runs a single job attempt and handles success/retry/give-up. */
  private async execute(job: InternalJob): Promise<void> {
    job.attempt += 1;
    const ctx: RetryTaskContext = {
      label: job.label,
      attempt: job.attempt,
      maxAttempts: this.options.maxAttempts,
    };

    try {
      await job.run();
      this.active -= 1;
      this.safeHook(() => this.hooks.onSuccess?.(ctx));
      this.pump();
    } catch (error) {
      this.active -= 1;
      if (job.attempt >= this.options.maxAttempts) {
        this.safeHook(() => this.hooks.onGiveUp?.(ctx, error));
        this.pump();
        return;
      }
      const delay = this.computeDelay(job.attempt);
      this.safeHook(() => this.hooks.onRetry?.(ctx, error, delay));
      this.scheduleRetry(job, delay);
      this.pump();
    }
  }

  /** Schedules a delayed re-queue for a failed job. */
  private scheduleRetry(job: InternalJob, delayMs: number): void {
    job.nextRunAt = Date.now() + delayMs;
    this.scheduled.add(job);
    const timer = setTimeout(() => {
      this.scheduled.delete(job);
      job.timer = null;
      this.ready.push(job);
      this.pump();
    }, delayMs);
    // Do not keep the event loop alive solely for a pending retry.
    if (typeof timer.unref === "function") {
      timer.unref();
    }
    job.timer = timer;
  }

  /** Resolves any idle-waiters once the queue is fully drained. */
  private maybeSignalIdle(): void {
    if (this.size() === 0 && this.idleResolvers.length > 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  /** Invokes a hook without letting a buggy hook break the queue. */
  private safeHook(fn: () => void): void {
    try {
      fn();
    } catch {
      // Observability hooks must never affect queue correctness.
    }
  }

  /**
   * Cancels all pending/scheduled work. In-flight tasks are allowed to finish.
   * Call during shutdown to stop new retries from firing.
   */
  public clear(): void {
    for (const job of this.scheduled) {
      if (job.timer) {
        clearTimeout(job.timer);
      }
    }
    this.scheduled.clear();
    this.ready.length = 0;
    this.maybeSignalIdle();
  }
}
