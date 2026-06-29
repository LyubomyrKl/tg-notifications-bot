import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { type SubscriberView } from '@paedavic/contracts';
import { type AuthPrincipal, SubscriberService } from '@paedavic/core';
import { SourceAuthGuard } from '../auth/source-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';

@Controller('subscribers')
@UseGuards(SourceAuthGuard)
export class SubscriberController {
  constructor(private readonly subscribers: SubscriberService) {}

  @Get()
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query('includeUnsubscribed') includeUnsubscribed?: string,
  ): Promise<SubscriberView[]> {
    return this.subscribers.list(p.sourceId, {
      includeUnsubscribed: includeUnsubscribed === 'true',
    });
  }
}
