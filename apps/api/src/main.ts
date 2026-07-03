import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { loadConfig } from '@paedavic/config';
import { BroadcastConsumer } from '@paedavic/core';
import { AppModule } from './app.module';
import { DomainExceptionFilter } from './common/domain-exception.filter';

async function bootstrap(): Promise<void> {
  const cfg = loadConfig(); // fail fast on bad env before anything starts
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );
  app.enableShutdownHooks(); // graceful Prisma disconnect + bot stop
  app.useGlobalFilters(new DomainExceptionFilter());

  // Single-process mode: run the delivery worker inside the API. Disable
  // (EMBED_WORKER=false) when running a dedicated worker for horizontal scaling.
  if (cfg.EMBED_WORKER) {
    app.get(BroadcastConsumer).start();
    new Logger('Bootstrap').log('Embedded delivery worker started (EMBED_WORKER)');
  }

  await app.listen({ port: cfg.API_PORT, host: '0.0.0.0' });
  new Logger('Bootstrap').log(`API listening on :${cfg.API_PORT}`);
}

void bootstrap();
