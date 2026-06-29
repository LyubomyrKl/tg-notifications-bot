import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { SubscriberService } from './subscriber.service';

@Module({
  imports: [AuditModule],
  providers: [SubscriberService],
  exports: [SubscriberService],
})
export class SubscriberModule {}
