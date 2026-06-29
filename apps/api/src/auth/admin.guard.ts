import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '@paedavic/config';

/**
 * Guards the provisioning bootstrap (POST /sources). A single shared admin key
 * (env ADMIN_API_KEY) — the only endpoint not scoped to an existing Source,
 * since it's what creates them.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  private readonly adminKey = loadConfig().ADMIN_API_KEY;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const provided =
      req.headers['x-admin-key'] ??
      (req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7)
        : undefined);

    if (!provided || provided !== this.adminKey) {
      throw new UnauthorizedException('Invalid admin key');
    }
    return true;
  }
}
