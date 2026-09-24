import { BadRequestException, Body, Controller, Post } from '@nestjs/common';
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
}
