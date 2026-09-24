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
  @Get('students')
  async students() {
    const { rows } = await this.db.query<StudentRow & { parent_name: string }>(`
      select s.id, s.name, s.grade, p.id as parent_id, p.name as parent_name
        from students s join parents p on p.id = s.parent_id
       order by s.id
    `);
    return rows;
  }
}
