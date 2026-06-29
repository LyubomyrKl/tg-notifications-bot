import { Module } from '@nestjs/common';
import { PrismaModule } from '@paedavic/database';
import { TelegramModule } from '@paedavic/telegram';
import { AuthModule } from './auth/auth.module';
import { GroupModule } from './group/group.module';
import { NotificationModule } from './notification/notification.module';
import { SourceModule } from './source/source.module';
import { SubscriberModule } from './subscriber/subscriber.module';

/**
 * The platform service layer as one importable unit. Any app (api, worker)
 * imports CoreModule and gets the full set of domain services wired against
 * shared Prisma + Telegram clients. Transport (REST/bot/queue) lives in apps.
 */
@Module({
  imports: [
    PrismaModule,
    TelegramModule,
    SourceModule,
    AuthModule,
    NotificationModule,
    SubscriberModule,
    GroupModule,
  ],
  exports: [
    SourceModule,
    AuthModule,
    NotificationModule,
    SubscriberModule,
    GroupModule,
  ],
})
export class CoreModule {}
