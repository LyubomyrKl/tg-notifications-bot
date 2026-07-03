import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@paedavic/config';
import { BroadcastConsumer } from '@paedavic/core';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast on bad env
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  app.get(BroadcastConsumer).start(); // this process IS the delivery worker
  new Logger('Worker').log('Delivery worker ready');
}

void bootstrap();
