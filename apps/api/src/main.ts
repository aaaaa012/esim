import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { CorrelationInterceptor } from './common/correlation.interceptor.js';
import { IdempotencyInterceptor } from './common/idempotency.interceptor.js';
import { PrismaService } from './infrastructure/prisma.service.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.use(helmet());
  app.enableCors({ origin: [process.env.CUSTOMER_WEB_URL ?? 'http://localhost:3000', process.env.OPS_WEB_URL ?? 'http://localhost:3001'], credentials: true });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new ApiExceptionFilter());
  app.useGlobalInterceptors(new CorrelationInterceptor(), new IdempotencyInterceptor(app.get(PrismaService)));
  const config = new DocumentBuilder().setTitle('Visa Compass eSIM API').setVersion('1.0').addBearerAuth().build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));
  await app.listen(Number(process.env.PORT ?? 4000));
}
void bootstrap();
