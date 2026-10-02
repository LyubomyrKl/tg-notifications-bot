import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { loadConfig } from '@paedavic/config';

/**
 * Guards the platform-operator bootstrap (POST /sources, POST /auth/register).
 * This is the SUPER admin — whoever runs the whole server — not a per-workspace
 * "admin" role (those arrive later with team roles). Authenticated by a single
 * shared key (env SUPERADMIN_API_KEY), since it's what creates workspaces and
 * therefore predates any workspace credential.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  // Pre-hash the expected key once. Comparing fixed-length SHA-256 digests with
  // timingSafeEqual keeps the check constant-time (no early-exit char compare,
  // and no length leak), defusing timing attacks on this long-lived secret.
  private readonly expectedDigest = createHash('sha256')
    .update(loadConfig().SUPERADMIN_API_KEY)
    .digest();

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const provided =
      req.headers['x-superadmin-key'] ??
      (req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7)
        : undefined);

    if (!provided || !this.matches(String(provided))) {
      throw new UnauthorizedException('Invalid super-admin key');
    }
    return true;
  }

  private matches(provided: string): boolean {
    const providedDigest = createHash('sha256').update(provided).digest();
    return timingSafeEqual(providedDigest, this.expectedDigest);
  }
}
