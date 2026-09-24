import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { DbService } from './db.service';
import { TrialClassRow } from './rows';

@Controller('admin')
export class AdminController {
  constructor(private readonly db: DbService) {}

  @Get('classes/:id/roster')
  async roster(@Param('id') id: string) {
    const classId = Number(id);

    const klass = await this.db.query<TrialClassRow>(
      `select id, subject, starts_at, capacity, occupied_seats
         from trial_classes where id = $1`,
      [classId],
    );
    if (!klass.rows[0]) throw new NotFoundException('No such class.');

    // Confirmed only. A hold, a declined payment or a refunded booking never
    // appears here, which is the whole point of the status column.
    const students = await this.db.query(
      `select s.name, s.grade, b.updated_at as confirmed_at, pa.provider_ref
         from bookings b
         join students s on s.id = b.student_id
         left join lateral (
           select provider_ref from payment_attempts
            where booking_id = b.id and status = 'succeeded'
            order by id desc limit 1
         ) pa on true
        where b.trial_class_id = $1 and b.status = 'confirmed'
        order by b.updated_at`,
      [classId],
    );

    // What an operator actually needs: not just who is in, but what the seat
    // machinery has been doing. refunds_failed should always be zero — each one
    // is a parent charged for a class they are not in.
    const counts = await this.db.query(
      `select
         (select count(*)::int from bookings
           where trial_class_id = $1 and status = 'pending_payment'
             and expires_at > now())                                as holds_live,
         (select count(*)::int from bookings
           where trial_class_id = $1
             and status in ('expired', 'payment_failed'))           as holds_lapsed,
         (select count(*)::int from payment_attempts pa
            join bookings b on b.id = pa.booking_id
           where b.trial_class_id = $1 and pa.status = 'refunded')   as refunds,
         (select count(*)::int from payment_attempts pa
            join bookings b on b.id = pa.booking_id
           where b.trial_class_id = $1
             and pa.status = 'refund_failed')                       as refunds_failed`,
      [classId],
    );

    return { class: klass.rows[0], students: students.rows, ...counts.rows[0] };
  }
}
