import type { Logger } from "../../core/logger";
import type { MessageQueueMetadata } from "../../core/messageQueue";
import type { FeatureGateStore } from "../../core/featureGates";
import type { TimersService } from "./timers.service";
import type { TimerDefinition } from "./timers.service";

export type TimerReadiness = {
  ok: boolean;
  reason: string;
};

type TimerSchedulerOptions = {
  service: TimersService;
  featureGates: FeatureGateStore;
  logger: Logger;
  enqueue: (message: string, metadata: MessageQueueMetadata) => string | undefined;
  readiness: () => TimerReadiness;
  tickMs?: number;
};

export class TimerScheduler {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: TimerSchedulerOptions) {}

  start() {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      void this.runDueTimers();
    }, this.options.tickMs ?? 15_000);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) {
      return;
    }

    clearInterval(this.timer);
    this.timer = undefined;
  }

  async runDueTimers(now = new Date()) {
    if (this.running) {
      return { ok: true, checked: 0, queued: 0, blocked: 0, skipped: 0 };
    }

    this.running = true;

    try {
      const due = this.options.service.getDueTimers(now);
      const gate = this.options.featureGates.get("timers");

      if (gate.mode !== "live") {
        return {
          ok: true,
          checked: due.length,
          queued: 0,
          blocked: 0,
          skipped: due.length,
          gate: gate.mode
        };
      }

      let queued = 0;
      let blocked = 0;

      for (const timer of due) {
        const readiness = this.options.readiness();

        if (!readiness.ok) {
          blocked += 1;
          this.options.service.markBlocked(timer.id, readiness.reason, now);
          this.options.logger.warn(
            { timerId: timer.id, timerName: timer.name, reason: readiness.reason },
            "Timer blocked by live readiness"
          );
          continue;
        }

        const outboundMessageId = this.options.enqueue(timer.message, timerMetadata(timer));

        if (!outboundMessageId) {
          blocked += 1;
          this.options.service.markBlocked(timer.id, "Timer message could not be queued.", now);
          continue;
        }

        queued += 1;
        this.options.service.markQueued(timer.id, outboundMessageId, now);
      }

      return {
        ok: true,
        checked: due.length,
        queued,
        blocked,
        skipped: 0,
        gate: gate.mode
      };
    } finally {
      this.running = false;
    }
  }
}

export const timerMetadata = (timer: TimerDefinition): MessageQueueMetadata => ({
  category: "system",
  action: `timer:${timer.id}`,
  importance: "normal"
});
