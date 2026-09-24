import { Module } from '@nestjs/common';
import { DbService } from './db.service';
import { ExpiryService } from './expiry.service';
import { PaymentsService } from './payments.service';
import { ClassesController } from './classes.controller';
import { BookingController } from './booking.controller';
import { BookingService } from './booking.service';
import { AdminController } from './admin.controller';

@Module({
  controllers: [ClassesController, BookingController, AdminController],
  providers: [DbService, ExpiryService, PaymentsService, BookingService],
  exports: [DbService],
})
export class AppModule {}
