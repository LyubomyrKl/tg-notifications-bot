import { Global, Module } from '@nestjs/common';
import { BroadcastQueue } from './broadcast.queue';

/** Producer module. The worker app builds its own BullMQ Worker separately. */
@Global()
@Module({
  providers: [BroadcastQueue],
  exports: [BroadcastQueue],
})
export class QueueModule {}
