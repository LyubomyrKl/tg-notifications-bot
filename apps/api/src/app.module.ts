import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';
import { SourceAuthGuard } from './auth/source-auth.guard';
import { SuperAdminGuard } from './auth/super-admin.guard';
import { BotModule } from './bot/bot.module';
import { AuditController } from './http/audit.controller';
import { AuthController } from './http/auth.controller';
import { BroadcastController } from './http/broadcast.controller';
import { GroupController } from './http/group.controller';
import { HealthController } from './http/health.controller';
import { InviteLinkController } from './http/invite-link.controller';
import { NotificationController } from './http/notification.controller';
import { ScheduledBroadcastController } from './http/scheduled-broadcast.controller';
import { SourceController } from './http/source.controller';
import { SubscriberController } from './http/subscriber.controller';

@Module({
  imports: [CoreModule, BotModule],
  controllers: [
    HealthController,
    AuthController,
    SourceController,
    NotificationController,
    GroupController,
    SubscriberController,
    InviteLinkController,
    BroadcastController,
    ScheduledBroadcastController,
    AuditController,
  ],
  providers: [SuperAdminGuard, SourceAuthGuard],
})
export class AppModule {}
