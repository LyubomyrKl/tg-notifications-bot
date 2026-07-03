import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@paedavic/config';
import { BroadcastConsumer, ScheduleConsumer } from '@paedavic/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast on bad env
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(BroadcastConsumer).start(); // per-recipient delivery
  app.get(ScheduleConsumer).start(); // fires scheduled/recurring broadcasts
  new Logger('Worker').log('Delivery + schedule workers ready');
}

void bootstrap();
