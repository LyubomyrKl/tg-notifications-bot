import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { loadConfig } from '@paedavic/config';

/**
 * Guards the platform-operator bootstrap (POST /sources). This is the SUPER
 * admin — whoever runs the whole server — not a per-workspace "admin" role
 * (those arrive later with team roles). Authenticated by a single shared key
 * (env SUPERADMIN_API_KEY), since it's what creates workspaces and therefore
 * predates any workspace credential.
 */
@Injectable()
export class SuperAdminGuard implements CanActivate {
  private readonly superAdminKey = loadConfig().SUPERADMIN_API_KEY;

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest();
    const provided =
      req.headers['x-superadmin-key'] ??
      (req.headers['authorization']?.startsWith('Bearer ')
        ? req.headers['authorization'].slice(7)
        : undefined);

    if (!provided || provided !== this.superAdminKey) {
      throw new UnauthorizedException('Invalid super-admin key');
    }
    return true;
  }
}
