import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';

/**
 * The delivery worker shares the exact service layer the API uses (CoreModule),
 * which now also provides the BullMQ consumer. main.ts starts it.
 */
@Module({
  imports: [CoreModule],
})
export class WorkerModule {}
