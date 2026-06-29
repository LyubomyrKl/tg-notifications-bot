import { Global, Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';

/** Global so both bot handlers (api) and the delivery worker share one client. */
@Global()
@Module({
  providers: [TelegramService],
  exports: [TelegramService],
})
export class TelegramModule {}
