import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
} from '@nestjs/common';
import { BookingService } from './booking.service';

@Controller('bookings')
export class BookingController {
  constructor(private readonly bookings: BookingService) {}

  @Post()
  create(@Body() body: { student_id?: unknown; trial_class_id?: unknown }) {
    const studentId = Number(body.student_id);
    const trialClassId = Number(body.trial_class_id);
    if (!Number.isInteger(studentId) || !Number.isInteger(trialClassId)) {
      throw new BadRequestException('student_id and trial_class_id must be integers');
    }
    return this.bookings.createHold(studentId, trialClassId);
  }

  // Paying settles an existing booking rather than creating a resource, so
  // 200 rather than Nest's default 201 for a POST.
  @Post(':id/pay')
  @HttpCode(200)
  pay(
    @Param('id') id: string,
    @Body() body: { payment_token?: unknown; idempotency_key?: unknown },
  ) {
    const bookingId = Number(id);
    const token = String(body.payment_token ?? '');
    const key = String(body.idempotency_key ?? '');
    if (!Number.isInteger(bookingId)) {
      throw new BadRequestException('booking id must be an integer');
    }
    // The key is supplied by the caller and is what makes a retry safe, so an
    // absent one is a bad request rather than something to invent here.
    if (!token || !key) {
      throw new BadRequestException('payment_token and idempotency_key are required');
    }
    return this.bookings.pay(bookingId, token, key);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    const bookingId = Number(id);
    if (!Number.isInteger(bookingId)) {
      throw new BadRequestException('booking id must be an integer');
    }
    return this.bookings.describe(bookingId);
  }
}
