import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ScheduleBroadcastInput,
  type ScheduledBroadcastView,
} from '@paedavic/contracts';
import { type AuthPrincipal, ScheduleService } from '@paedavic/core';
import { SourceAuthGuard } from '../auth/source-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('scheduled-broadcasts')
@UseGuards(SourceAuthGuard)
export class ScheduledBroadcastController {
  constructor(private readonly schedule: ScheduleService) {}

  @Post()
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body(new ZodValidationPipe(ScheduleBroadcastInput))
    body: ScheduleBroadcastInput,
  ): Promise<ScheduledBroadcastView> {
    const createdBy = p.userId ?? `via:${p.via}`;
    return this.schedule.schedule(p.sourceId, body, createdBy);
  }

  @Get()
  list(@CurrentPrincipal() p: AuthPrincipal): Promise<ScheduledBroadcastView[]> {
    return this.schedule.list(p.sourceId);
  }

  @Get(':id')
  get(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<ScheduledBroadcastView> {
    return this.schedule.get(p.sourceId, id);
  }

  @Post(':id/cancel')
  cancel(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<ScheduledBroadcastView> {
    return this.schedule.cancel(p.sourceId, id);
  }
}
