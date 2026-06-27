/**
 * Tests for the in-process retry queue: success, retry-then-succeed, give-up,
 * backoff math, concurrency limiting, and idle signalling.
 *
 * Delays are kept tiny so the suite runs fast with real timers.
 */

import { RetryQueue } from "../retry-queue";

describe("RetryQueue", () => {
  it("runs a task once when it succeeds immediately", async () => {
    const q = new RetryQueue({ baseDelayMs: 1 });
    const task = jest.fn().mockResolvedValue(undefined);

    q.enqueue("ok", task);
    await q.onIdle();

    expect(task).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
  });

  it("retries a failing task and stops once it succeeds", async () => {
    const q = new RetryQueue({ maxAttempts: 5, baseDelayMs: 1, jitter: false });
    let calls = 0;
    const task = jest.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new Error("transient");
      }
    });

    const onSuccess = jest.fn();
    const qWithHook = new RetryQueue(
      { maxAttempts: 5, baseDelayMs: 1, jitter: false },
      { onSuccess }
    );
    qWithHook.enqueue("retry-then-ok", task);
    await qWithHook.onIdle();

    expect(task).toHaveBeenCalledTimes(3);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onSuccess.mock.calls[0]?.[0]).toMatchObject({ attempt: 3 });
  });

  it("gives up after maxAttempts and fires onGiveUp", async () => {
    const onGiveUp = jest.fn();
    const onRetry = jest.fn();
    const q = new RetryQueue(
      { maxAttempts: 3, baseDelayMs: 1, jitter: false },
      { onGiveUp, onRetry }
    );
    const task = jest.fn().mockRejectedValue(new Error("always fails"));

    q.enqueue("doomed", task);
    await q.onIdle();

    expect(task).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2); // retries between the 3 attempts
    expect(onGiveUp).toHaveBeenCalledTimes(1);
    expect(onGiveUp.mock.calls[0]?.[0]).toMatchObject({ attempt: 3, maxAttempts: 3 });
  });

  it("computes exponential backoff without jitter", () => {
    const q = new RetryQueue({
      baseDelayMs: 100,
      factor: 2,
      maxDelayMs: 10_000,
      jitter: false,
    });
    expect(q.computeDelay(1)).toBe(100);
    expect(q.computeDelay(2)).toBe(200);
    expect(q.computeDelay(3)).toBe(400);
    expect(q.computeDelay(4)).toBe(800);
  });

  it("caps backoff at maxDelayMs", () => {
    const q = new RetryQueue({
      baseDelayMs: 1000,
      factor: 10,
      maxDelayMs: 5000,
      jitter: false,
    });
    expect(q.computeDelay(5)).toBe(5000);
  });

  it("keeps jittered delays within (0, cap]", () => {
    const q = new RetryQueue({
      baseDelayMs: 1000,
      factor: 2,
      maxDelayMs: 8000,
      jitter: true,
    });
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const delay = q.computeDelay(attempt);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(8000);
    }
  });

  it("never exceeds the configured concurrency", async () => {
    const concurrency = 2;
    const q = new RetryQueue({ concurrency, baseDelayMs: 1 });
    let active = 0;
    let peak = 0;

    const makeTask = () =>
      jest.fn(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
      });

    for (let i = 0; i < 6; i += 1) {
      q.enqueue(`job-${i}`, makeTask());
    }
    await q.onIdle();

    expect(peak).toBeLessThanOrEqual(concurrency);
    expect(q.size()).toBe(0);
  });

  it("onIdle resolves immediately when the queue is empty", async () => {
    const q = new RetryQueue();
    await expect(q.onIdle()).resolves.toBeUndefined();
  });

  it("clear() cancels pending retries", async () => {
    const q = new RetryQueue({ maxAttempts: 5, baseDelayMs: 50, jitter: false });
    const task = jest.fn().mockRejectedValue(new Error("fail"));

    q.enqueue("to-cancel", task);
    // Let the first attempt run and schedule a retry, then cancel it.
    await new Promise((resolve) => setTimeout(resolve, 5));
    q.clear();
    await q.onIdle();

    // Only the initial attempt ran; the scheduled retry was cancelled.
    expect(task).toHaveBeenCalledTimes(1);
    expect(q.size()).toBe(0);
  });

  it("rejects invalid options", () => {
    expect(() => new RetryQueue({ maxAttempts: 0 })).toThrow();
    expect(() => new RetryQueue({ concurrency: 0 })).toThrow();
  });
});
