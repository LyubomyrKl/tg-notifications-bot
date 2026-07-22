import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  type BroadcastDetail,
  type BroadcastResponses,
  type BroadcastView,
  CreateBroadcastInput,
} from '@paedavic/contracts';
import {
  type AuthPrincipal,
  BroadcastService,
  ResponseService,
} from '@paedavic/core';
import { BearerAuthGuard } from '../auth/bearer-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('broadcasts')
@UseGuards(BearerAuthGuard)
export class BroadcastController {
  constructor(
    private readonly broadcasts: BroadcastService,
    private readonly responses: ResponseService,
  ) {}

  /** Queue a send. Idempotent on sendKey; rejects unfilled placeholders (400). */
  @Post()
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateBroadcastInput))
    body: CreateBroadcastInput,
  ): Promise<BroadcastView> {
    // Audit "who": the web user id, or the transport when there's no user.
    const createdBy = p.userId ?? `via:${p.via}`;
    return this.broadcasts.create(p.sourceId, body, createdBy);
  }

  @Get()
  list(@CurrentPrincipal() p: AuthPrincipal): Promise<BroadcastView[]> {
    return this.broadcasts.list(p.sourceId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<BroadcastDetail> {
    return this.broadcasts.get(p.sourceId, id);
  }

  /** Collected poll votes / free-text answers for an interactive broadcast. */
  @Get(':id/responses')
  responsesFor(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<BroadcastResponses> {
    return this.responses.list(p.sourceId, id);
  }
}
