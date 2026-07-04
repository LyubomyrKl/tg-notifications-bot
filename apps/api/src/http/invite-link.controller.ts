import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateInviteLinkInput,
  type InviteLinkDetail,
  type InviteLinkView,
} from '@paedavic/contracts';
import { type AuthPrincipal, InviteService } from '@paedavic/core';
import { BearerAuthGuard } from '../auth/bearer-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Invite-link management. Opening happens via the bot, not REST. */
@Controller('invite-links')
@UseGuards(BearerAuthGuard)
export class InviteLinkController {
  constructor(private readonly invites: InviteService) {}

  @Post()
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateInviteLinkInput))
    body: CreateInviteLinkInput,
  ): Promise<InviteLinkView> {
    return this.invites.create(p.sourceId, body);
  }

  @Get()
  list(@CurrentPrincipal() p: AuthPrincipal): Promise<InviteLinkView[]> {
    return this.invites.list(p.sourceId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<InviteLinkDetail> {
    return this.invites.get(p.sourceId, id);
  }

  @Post(':id/revoke')
  revoke(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<InviteLinkView> {
    return this.invites.revoke(p.sourceId, id);
  }
}
