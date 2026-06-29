import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';
import { BroadcastConsumer } from './broadcast.consumer';

/**
 * The delivery worker shares the exact service layer the API uses (CoreModule)
 * and adds the BullMQ consumer that drives broadcast delivery.
 */
@Module({
  imports: [CoreModule],
  providers: [BroadcastConsumer],
})
export class WorkerModule {}
