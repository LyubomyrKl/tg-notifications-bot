import { Module } from '@nestjs/common';
import { QueueModule } from '@paedavic/queue';
import { BroadcastDeliveryService } from './broadcast-delivery.service';
import { BroadcastService } from './broadcast.service';

@Module({
  imports: [QueueModule],
  providers: [BroadcastService, BroadcastDeliveryService],
  exports: [BroadcastService, BroadcastDeliveryService],
})
export class BroadcastModule {}
