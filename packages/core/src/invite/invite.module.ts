import { Module } from '@nestjs/common';
import { SubscriberModule } from '../subscriber/subscriber.module';
import { InviteService } from './invite.service';

@Module({
  imports: [SubscriberModule],
  providers: [InviteService],
  exports: [InviteService],
})
export class InviteModule {}
