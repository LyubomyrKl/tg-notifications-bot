import {
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  CreateSourceInput,
  type SourceCredentials,
  type SourceView,
} from '@paedavic/contracts';
import { type AuthPrincipal, SourceService } from '@paedavic/core';
import { AdminGuard } from '../auth/admin.guard';
import { SourceAuthGuard } from '../auth/source-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

@Controller('sources')
export class SourceController {
  constructor(private readonly sources: SourceService) {}

  /** Admin bootstrap — provisions a workspace, returns API key + start link. */
  @Post()
  @UseGuards(AdminGuard)
  provision(
    @Body(new ZodValidationPipe(CreateSourceInput)) body: CreateSourceInput,
  ): Promise<SourceCredentials> {
    return this.sources.provision(body);
  }

  /** Current workspace profile (incl. Telegram-link status + start link). */
  @Get('me')
  @UseGuards(SourceAuthGuard)
  me(@CurrentPrincipal() principal: AuthPrincipal): Promise<SourceView> {
    return this.sources.getView(principal.sourceId);
  }
}
