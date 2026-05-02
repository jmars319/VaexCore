import assert from "node:assert/strict";
import { MessageQueue } from "../desktop/shared/src/core/messageQueue.ts";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {}
};

await smokeTransientRetry();
await smokeNonRetryableConfigFailure();
await smokeRateLimitRetry();

console.log("message queue smoke passed");

async function smokeTransientRetry() {
  const events = [];
  let attempts = 0;
  const queue = new MessageQueue({
    logger,
    maxAttempts: 3,
    retryBaseDelayMs: 5,
    minIntervalMs: 5,
    send: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "retry", failureCategory: "network", reason: "temporary network failure", retryAfterMs: 5 }
        : { status: "sent" };
    },
    onEvent: (event) => events.push(event)
  });

  queue.enqueue("transient retry");
  const drained = await queue.drain(1000);

  assert.equal(drained, true, "transient retry queue drains");
  assert.equal(attempts, 2, "transient retry sends again");
  assert(events.some((event) => event.status === "retrying" && event.failureCategory === "network"), "network retry is classified");
  assert(events.some((event) => event.status === "sent"), "retried message is sent");
}

async function smokeNonRetryableConfigFailure() {
  const events = [];
  let attempts = 0;
  const queue = new MessageQueue({
    logger,
    maxAttempts: 4,
    minIntervalMs: 5,
    send: async () => {
      attempts += 1;
      return { status: "failed", failureCategory: "config", reason: "missing Twitch IDs" };
    },
    onEvent: (event) => events.push(event)
  });

  queue.enqueue("non retryable");
  const drained = await queue.drain(1000);

  assert.equal(drained, true, "non-retryable failure queue drains");
  assert.equal(attempts, 1, "non-retryable config failure is not retried");
  assert(!events.some((event) => event.status === "retrying"), "non-retryable config failure does not emit retrying");
  assert(events.some((event) => event.status === "failed" && event.failureCategory === "config"), "config failure is classified");
}

async function smokeRateLimitRetry() {
  const events = [];
  let attempts = 0;
  const queue = new MessageQueue({
    logger,
    maxAttempts: 3,
    retryBaseDelayMs: 5,
    minIntervalMs: 5,
    send: async () => {
      attempts += 1;
      return attempts === 1
        ? { status: "retry", failureCategory: "rate_limit", reason: "Twitch 429", retryAfterMs: 5 }
        : { status: "sent" };
    },
    onEvent: (event) => events.push(event)
  });

  queue.enqueue("rate limit retry");
  const drained = await queue.drain(1000);
  const retry = events.find((event) => event.status === "retrying");

  assert.equal(drained, true, "rate-limit retry queue drains");
  assert.equal(attempts, 2, "rate-limit retry sends again");
  assert.equal(retry?.failureCategory, "rate_limit", "rate-limit retry is classified");
  assert.equal(retry?.retryAfterMs, 5, "rate-limit retry keeps retry delay");
  assert(retry?.nextAttemptAt, "rate-limit retry reports next attempt time");
}
