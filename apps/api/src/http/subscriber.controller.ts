import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  RenameSubscriberInput,
  type SubscriberView,
} from '@paedavic/contracts';
import { type AuthPrincipal, SubscriberService } from '@paedavic/core';
import { BearerAuthGuard } from '../auth/bearer-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('subscribers')
@UseGuards(BearerAuthGuard)
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

  /** Set or clear (`customName: null`) the admin-facing display name. */
  @Patch(':id/name')
  rename(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenameSubscriberInput))
    body: RenameSubscriberInput,
  ): Promise<SubscriberView> {
    return this.subscribers.rename(p.sourceId, id, body.customName);
  }

  /** REST mirror of the bot's /stop consent exit. */
  @Post(':id/unsubscribe')
  unsubscribe(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<SubscriberView> {
    return this.subscribers.unsubscribe(p.sourceId, id);
  }
}
