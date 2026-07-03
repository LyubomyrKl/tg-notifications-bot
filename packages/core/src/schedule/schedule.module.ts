import { Module } from '@nestjs/common';
import { QueueModule } from '@paedavic/queue';
import { BroadcastModule } from '../broadcast/broadcast.module';
import { ScheduleConsumer } from './schedule.consumer';
import { ScheduleService } from './schedule.service';

@Module({
  imports: [QueueModule, BroadcastModule],
  providers: [ScheduleService, ScheduleConsumer],
  exports: [ScheduleService, ScheduleConsumer],
})
export class ScheduleModule {}
