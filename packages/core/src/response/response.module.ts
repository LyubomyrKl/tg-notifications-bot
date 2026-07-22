import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ResponseService } from './response.service';

@Module({
  imports: [AuditModule],
  providers: [ResponseService],
  exports: [ResponseService],
})
export class ResponseModule {}
