import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global so any module in core/api/worker can inject PrismaService without
 * re-importing. Tenant isolation is enforced in the service layer, not here.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
