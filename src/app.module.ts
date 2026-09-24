import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ExpiryService } from './expiry.service';
import { PaymentsService } from './payments.service';
import { ClassesController } from './classes.controller';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';

@Module({
  controllers: [ClassesController, BookingController],
  providers: [DbService, ExpiryService, PaymentsService, BookingService],
  exports: [DbService],
})
export class AppModule {}
