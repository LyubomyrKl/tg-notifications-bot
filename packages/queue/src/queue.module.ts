import { Global, Module } from '@nestjs/common';
import { BroadcastQueue } from './broadcast.queue';
import { ScheduleQueue } from './schedule.queue';

/** Producer module. The worker app builds its own BullMQ Worker separately. */
@Global()
@Module({
  providers: [BroadcastQueue, ScheduleQueue],
  exports: [BroadcastQueue, ScheduleQueue],
})
export class QueueModule {}
