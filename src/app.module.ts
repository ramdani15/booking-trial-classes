import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ExpiryService } from './expiry.service';
import { PaymentsService } from './payments.service';
import { ClassesController } from './classes.controller';

@Module({
  controllers: [ClassesController],
  providers: [DbService, ExpiryService, PaymentsService],
  exports: [DbService],
})
export class AppModule {}
