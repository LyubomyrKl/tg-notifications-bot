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
  CreateNotificationInput,
  type NotificationView,
  PreviewNotificationInput,
  UpdateNotificationInput,
} from '@paedavic/contracts';
import { type AuthPrincipal, NotificationService } from '@paedavic/core';
import { SourceAuthGuard } from '../auth/source-auth.guard';
import { CurrentPrincipal } from '../common/current-principal.decorator';
import { ZodValidationPipe } from '../common/zod-validation.pipe';

/** Notification gallery. All routes tenant-scoped via the resolved principal. */
@Controller('notifications')
@UseGuards(SourceAuthGuard)
export class NotificationController {
  constructor(private readonly notifications: NotificationService) {}

  @Post()
  create(
    @CurrentPrincipal() p: AuthPrincipal,
    @Body(new ZodValidationPipe(CreateNotificationInput))
    body: CreateNotificationInput,
  ): Promise<NotificationView> {
    return this.notifications.create(p.sourceId, body);
  }

  @Get()
  list(
    @CurrentPrincipal() p: AuthPrincipal,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<NotificationView[]> {
    return this.notifications.list(p.sourceId, {
      includeArchived: includeArchived === 'true',
    });
  }

  @Get(':id')
  get(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<NotificationView> {
    return this.notifications.get(p.sourceId, id);
  }

  @Patch(':id')
  update(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateNotificationInput))
    body: UpdateNotificationInput,
  ): Promise<NotificationView> {
    return this.notifications.update(p.sourceId, id, body);
  }

  @Post(':id/duplicate')
  duplicate(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<NotificationView> {
    return this.notifications.duplicate(p.sourceId, id);
  }

  @Post(':id/archive')
  archive(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
  ): Promise<NotificationView> {
    return this.notifications.archive(p.sourceId, id);
  }

  /** Render preview; rejects unfilled placeholders (→ 400 via filter). */
  @Post(':id/preview')
  preview(
    @CurrentPrincipal() p: AuthPrincipal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(PreviewNotificationInput))
    body: PreviewNotificationInput,
  ): Promise<{ text: string }> {
    return this.notifications.preview(p.sourceId, id, body.placeholderValues);
  }
}
