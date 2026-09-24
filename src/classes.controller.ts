import { Controller, Get } from '@nestjs/common';
import { DbService } from './db.service';
import { StudentRow, TrialClassRow } from './rows';

@Controller()
export class ClassesController {
  constructor(private readonly db: DbService) {}

  @Get('classes')
  async list() {
    const { rows } = await this.db.query<TrialClassRow & { seats_available: string }>(`
      select id, subject, starts_at, capacity, occupied_seats,
             capacity - occupied_seats as seats_available
        from trial_classes
       order by starts_at
    `);
    return rows.map((r) => ({ ...r, seats_available: Number(r.seats_available) }));
  }

  // No authentication in scope, so the seeded families are simply listed and
  // the caller picks one.
  //
  // active_class_ids lets the UI grey out a class the child is already in
  // rather than letting them click and be refused. Convenience only: the
  // partial unique index is what actually prevents the second booking.
  @Get('students')
  async students() {
    const { rows } = await this.db.query<
      StudentRow & { parent_name: string; active_class_ids: number[] }
    >(`
      select s.id, s.name, s.grade, p.id as parent_id, p.name as parent_name,
             coalesce((
               select array_agg(b.trial_class_id)::int[]
                 from bookings b
                where b.student_id = s.id
                  and b.status in ('pending_payment', 'confirmed')
             ), '{}') as active_class_ids
        from students s join parents p on p.id = s.parent_id
       order by s.id
    `);
    return rows;
  }
}
