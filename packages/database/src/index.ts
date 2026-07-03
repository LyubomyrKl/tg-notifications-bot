export { PrismaService } from './prisma.service';
export { PrismaModule } from './prisma.module';

// Re-export Prisma's generated types/enums so consumers depend on
// @paedavic/database rather than reaching into @prisma/client directly.
export { Prisma, PrismaClient } from '@prisma/client';
export type {
  User,
  Source,
  Notification,
  Subscriber,
  Group,
  GroupMember,
  InviteLink,
  InviteJoin,
  Broadcast,
  BroadcastTarget,
  BroadcastRecipient,
  AuditLog,
  ScheduledBroadcast,
} from '@prisma/client';
export {
  SubscriberStatus,
  BroadcastStatus,
  RecipientStatus,
  ScheduledStatus,
} from '@prisma/client';
