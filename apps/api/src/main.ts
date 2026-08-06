import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { CorrelationInterceptor } from './common/correlation.interceptor.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { LoggingInterceptor } from './common/logging.interceptor.js';
import { RateLimitGuard } from './common/rate-limit.guard.js';
import { MetricsService } from './observability/metrics.service.js';
import { PrismaService } from './infrastructure/prisma.service.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' } }));
  app.enableCors({ origin: [process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000', process.env.OPS_WEB_URL ?? 'http://localhost:3001'], credentials: true });
  app.set('trust proxy', trustProxySetting());

  const bodyLimit = process.env.BODY_LIMIT ?? '5mb';
  app.useBodyParser('json', { limit: bodyLimit });
  app.useBodyParser('urlencoded', { limit: bodyLimit, extended: true });

  // Authenticated and personal data must never be cached by shared caches/proxies.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Cache-Control', 'no-store, private');
    next();
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalGuards(new RateLimitGuard());
  app.useGlobalInterceptors(new CorrelationInterceptor(), new LoggingInterceptor(app.get(MetricsService)), new IdempotencyInterceptor(app.get(PrismaService)));

  if (process.env.SWAGGER_ENABLED === 'true') {
    const config = new DocumentBuilder().setTitle('Visa Compass eSIM API').setVersion('1.0').addBearerAuth().build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  }

  await app.listen(Number(process.env.PORT ?? 4000));
}

/**
 * Express `trust proxy` value. The app must only trust the IP hops it actually
 * sits behind (e.g. `1` for a single reverse proxy, or a comma-separated list
 * of proxy addresses). Leaving it unset disables proxy IP trust so clients
 * cannot spoof their address via `X-Forwarded-For`; set it when deploying
 * behind a reverse proxy or load balancer, otherwise rate limiting collapses
 * every client onto the proxy address.
 */
function trustProxySetting(): boolean | string | number {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

void bootstrap();
