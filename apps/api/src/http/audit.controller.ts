import { Controller, Get, UseGuards } from '@nestjs/common';
import { type AuditEntryView } from '@paedavic/contracts';
import { AuditService, type AuthPrincipal } from '@paedavic/core';
import { SourceAuthGuard } from '../auth/source-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';

/** Read-only audit trail for the workspace (broadcasts sent, unsubscribes …). */
@Controller('audit')
@UseGuards(SourceAuthGuard)
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  list(@CurrentPrincipal() p: AuthPrincipal): Promise<AuditEntryView[]> {
    return this.audit.list(p.sourceId);
  }
}
