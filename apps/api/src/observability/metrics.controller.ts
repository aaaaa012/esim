import { Controller, Get, Header } from '@nestjs/common';
import { MetricsService } from './metrics.service.js';

@Controller('metrics')
export class MetricsController {
  constructor(private readonly service: MetricsService) {}
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape() {
    return this.service.render();
  }
}