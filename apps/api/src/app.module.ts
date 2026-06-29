import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';
import { AdminGuard } from './auth/admin.guard';
import { SourceAuthGuard } from './auth/source-auth.guard';
import { BotModule } from './bot/bot.module';
import { AuthController } from './http/auth.controller';
import { GroupController } from './http/group.controller';
import { HealthController } from './http/health.controller';
import { InviteLinkController } from './http/invite-link.controller';
import { NotificationController } from './http/notification.controller';
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
  ],
  providers: [AdminGuard, SourceAuthGuard],
})
export class AppModule {}
