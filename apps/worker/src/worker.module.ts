import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';

/**
 * The delivery worker shares the exact service layer the API uses (CoreModule).
 * Slice 5 adds the BullMQ `broadcast-delivery` processor here; for now the app
 * just boots to prove the deployable + shared-core wiring works.
 */
@Module({
  imports: [CoreModule],
})
export class WorkerModule {}
