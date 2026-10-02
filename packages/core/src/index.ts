// Service layer — the single source of truth for every Source action.
export { CoreModule } from './core.module';

export { SourceModule } from './source/source.module';
export { SourceService } from './source/source.service';

export { SubscriberModule } from './subscriber/subscriber.module';
export { SubscriberService } from './subscriber/subscriber.service';
export { GroupModule } from './group/group.module';
export { GroupService } from './group/group.service';
export { InviteModule } from './invite/invite.module';
export { InviteService } from './invite/invite.service';
export type { InviteOpenResult } from './invite/invite.service';
export { BroadcastModule } from './broadcast/broadcast.module';
export { BroadcastService } from './broadcast/broadcast.service';
export { BroadcastDeliveryService } from './broadcast/broadcast-delivery.service';
export type { DeliveryOutcome } from './broadcast/broadcast-delivery.service';
export { BroadcastConsumer, isTerminalDeliveryFailure } from './broadcast/broadcast.consumer';
export {
  buildInteractionKeyboard,
  RESPONSE_CALLBACK,
  voteCallback,
  answerCallback,
} from './broadcast/interaction-keyboard';
export { ResponseModule } from './response/response.module';
export { ResponseService } from './response/response.service';
export { ScheduleModule } from './schedule/schedule.module';
export { ScheduleService, buildCronPattern } from './schedule/schedule.service';
export { ScheduleConsumer } from './schedule/schedule.consumer';
export { RecoveryModule } from './recovery/recovery.module';
export { RecoveryService } from './recovery/recovery.service';
export { AuditModule } from './audit/audit.module';
export { AuditService, AuditAction } from './audit/audit.service';

export { NotificationModule } from './notification/notification.module';
export { NotificationService } from './notification/notification.service';
export {
  parsePlaceholders,
  renderTemplate,
  UnfilledPlaceholdersError,
} from './notification/placeholder.util';

export { AuthModule } from './auth/auth.module';
export { AuthService } from './auth/auth.service';
export { TokenService } from './auth/token.service';
export type { SessionClaims } from './auth/token.service';

export type { AuthPrincipal } from './auth/principal';

export {
  hashPassword,
  verifyPassword,
  generateApiKey,
  hashApiKey,
  generateToken,
} from './crypto/crypto.util';
