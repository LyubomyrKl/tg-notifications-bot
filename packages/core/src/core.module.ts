import { Module } from '@nestjs/common';
import { PrismaModule } from '@paedavic/database';
import { TelegramModule } from '@paedavic/telegram';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { GroupModule } from './group/group.module';
import { InviteModule } from './invite/invite.module';
import { NotificationModule } from './notification/notification.module';
import { ScheduleModule } from './schedule/schedule.module';
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
    InviteModule,
    BroadcastModule,
    ScheduleModule,
    AuditModule,
  ],
  exports: [
    SourceModule,
    AuthModule,
    NotificationModule,
    SubscriberModule,
    GroupModule,
    InviteModule,
    BroadcastModule,
    ScheduleModule,
    AuditModule,
  ],
})
export class CoreModule {}
