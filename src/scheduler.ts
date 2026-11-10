import type { Pipeline } from './pipeline.js';

/** §18: one 5-second poll. Closing the page does not stop it; pause does. */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pipeline: Pipeline,
    private readonly intervalMs = 5_000,
  ) {}

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      this.pipeline.kick();
    }, this.intervalMs);
    this.timer.unref?.();
    this.pipeline.kick();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
