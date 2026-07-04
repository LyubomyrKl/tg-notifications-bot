import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SourceService, TokenService } from '@paedavic/core';

/**
 * The REST API's authentication guard. It accepts EITHER credential the API
 * supports, both sent as `Authorization: Bearer <token>`, and resolves the
 * caller to a tenant-scoped principal:
 *   - `pk_…`  → programmatic API key → SourceService.resolveByApiKey
 *   - else    → web-login JWT        → TokenService.verify → resolveByUserId
 *
 * Either way `request.principal.sourceId` is set, so controllers + the service
 * layer scope identically no matter which credential was used. (The Telegram
 * bot authenticates separately, by chat id — it never passes through here.)
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly sources: SourceService,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing bearer token');
    }
    const token = header.slice(7);

    const principal = token.startsWith('pk_')
      ? await this.sources.resolveByApiKey(token)
      : await this.sources.resolveByUserId(this.tokens.verify(token).sub);

    if (!principal) {
      throw new UnauthorizedException('No active workspace for this credential');
    }

    req.principal = principal;
    return true;
  }
}
