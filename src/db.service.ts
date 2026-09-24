import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, PoolClient, QueryResult, QueryResultRow, types } from 'pg';
import { DATABASE_URL } from './config';

// bigint arrives as a string by default, so ids would serialise as "6" rather
// than 6. No id here approaches 2^53, which is the reason that default exists.
types.setTypeParser(types.builtins.INT8, (v) => Number(v));

export type Runner = {
  query: <T extends QueryResultRow = any>(
    text: string,
    params?: unknown[],
  ) => Promise<QueryResult<T>>;
};

@Injectable()
export class DbService implements OnModuleDestroy {
  readonly pool = new Pool({ connectionString: DATABASE_URL });

  // Generic so callers name the shape they expect. Hand-written types in
  // rows.ts rather than generated ones: what matters is that a status string
  // which does not exist fails to compile.
  query<T extends QueryResultRow = any>(text: string, params: unknown[] = []) {
    return this.pool.query<T>(text, params);
  }

  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  onModuleDestroy() {
    return this.pool.end();
  }
}

export function pgCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code: unknown }).code)
    : undefined;
}
