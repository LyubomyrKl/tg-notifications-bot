import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';
import { AdminGuard } from './auth/admin.guard';
import { SourceAuthGuard } from './auth/source-auth.guard';
import { BotModule } from './bot/bot.module';
import { AuthController } from './http/auth.controller';
import { HealthController } from './http/health.controller';
import { NotificationController } from './http/notification.controller';
import { SourceController } from './http/source.controller';

@Module({
  imports: [CoreModule, BotModule],
  controllers: [
    HealthController,
    AuthController,
    SourceController,
    NotificationController,
  ],
  providers: [AdminGuard, SourceAuthGuard],
})
export class AppModule {}
