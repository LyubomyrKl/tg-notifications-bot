import { Module } from '@nestjs/common';
import { SubscriberModule } from '../subscriber/subscriber.module';
import { GroupService } from './group.service';

@Module({
  imports: [SubscriberModule],
  providers: [GroupService],
  exports: [GroupService],
})
export class GroupModule {}
