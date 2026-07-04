import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { AuthPrincipal } from '@paedavic/core';

/** Injects the tenant-scoped principal that the BearerAuthGuard resolved. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthPrincipal => {
    const req = ctx.switchToHttp().getRequest();
    return req.principal;
  },
);
