import { Module } from '@nestjs/common';
import { QueueModule } from '@paedavic/queue';
import { AuditModule } from '../audit/audit.module';
import { BroadcastConsumer } from './broadcast.consumer';
import { BroadcastDeliveryService } from './broadcast-delivery.service';
import { BroadcastService } from './broadcast.service';

@Module({
  imports: [QueueModule, AuditModule],
  providers: [BroadcastService, BroadcastDeliveryService, BroadcastConsumer],
  exports: [BroadcastService, BroadcastDeliveryService, BroadcastConsumer],
})
export class BroadcastModule {}
