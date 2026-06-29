import { Module } from '@nestjs/common';
import { SubscriberService } from './subscriber.service';

@Module({
  providers: [SubscriberService],
  exports: [SubscriberService],
})
export class SubscriberModule {}
