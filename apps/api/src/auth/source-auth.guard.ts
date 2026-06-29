import {
  CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { SourceService, TokenService } from '@paedavic/core';

/**
 * Resolves the caller into a tenant-scoped principal from a `Bearer` token:
 *  - `pk_…`  → API key  → SourceService.resolveByApiKey
 *  - else    → JWT      → TokenService.verify → resolveByUserId
 *
 * Either way `request.principal.sourceId` is set, so controllers and the
 * service layer scope identically regardless of which client called.
 */
@Injectable()
export class SourceAuthGuard implements CanActivate {
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
