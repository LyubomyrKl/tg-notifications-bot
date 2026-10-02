import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/**
 * Tiny in-memory fixed-window rate limiter for the unauthenticated auth routes.
 * No external dependency and no Redis round-trip — proportionate for a single
 * API process. Keyed by client IP + route so a login flood can't tie up the
 * same process that runs the bot and delivery workers (bcrypt is CPU-heavy),
 * and to slow offline-pace credential stuffing.
 *
 * Not a distributed limiter: if the API is ever scaled horizontally, swap this
 * for a Redis-backed one. (Delivery throughput already has its own BullMQ limiter.)
 */
@Injectable()
export class AuthThrottleGuard implements CanActivate {
  private readonly windowMs = 60_000;
  private readonly max = 10; // attempts per IP per route per window
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const ip: string = req.ip ?? req.socket?.remoteAddress ?? 'unknown';
    const route: string = req.routeOptions?.url ?? req.url ?? 'auth';
    const key = `${ip}:${route}`;
    const now = Date.now();

    const entry = this.hits.get(key);
    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }
    if (entry.count >= this.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: `Too many attempts — retry in ${retryAfter}s` },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    entry.count += 1;
    return true;
  }

  /** Drop expired windows so the map can't grow unbounded. Cheap + opportunistic. */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [k, v] of this.hits) if (now >= v.resetAt) this.hits.delete(k);
  }
}
