import { Module } from '@nestjs/common';
import { CoreModule } from '@paedavic/core';
import { AdminMenu } from './admin-menu';
import { BotRunner } from './bot.runner';

/** Hosts the grammY runtime; depends on the shared service layer (CoreModule). */
@Module({
  imports: [CoreModule],
  providers: [BotRunner, AdminMenu],
})
export class BotModule {}
