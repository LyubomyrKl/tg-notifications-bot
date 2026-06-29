import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { loadConfig } from '@paedavic/config';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig(); // fail fast on bad env before anything starts
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks(); // graceful Prisma disconnect + bot stop

  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API listening on :${cfg.API_PORT}`);
}

void bootstrap();
