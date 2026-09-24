/** Injectable clock so time-dependent behaviour (expiry, backoff) is testable. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

export class FixedClock implements Clock {
  constructor(private current: Date) {}
  now(): Date {
    return new Date(this.current.getTime());
  }
  set(at: Date): void {
    this.current = at;
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
