import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadConfig } from '@paedavic/config';
import { WorkerModule } from './worker.module';

async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast on bad env
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log('Delivery worker ready (no queues bound yet)');
}

void bootstrap();
