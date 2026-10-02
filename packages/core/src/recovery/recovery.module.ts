import { Module } from '@nestjs/common';
import { QueueModule } from '@paedavic/queue';
import { BroadcastModule } from '../broadcast/broadcast.module';
import { RecoveryService } from './recovery.service';

@Module({
  imports: [QueueModule, BroadcastModule],
  providers: [RecoveryService],
  exports: [RecoveryService],
})
export class RecoveryModule {}
