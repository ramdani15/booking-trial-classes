import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DATABASE_URL, describeTarget } from '../src/config';

// Loads schema and seed over whatever DATABASE_URL points at. Driven through
// pg rather than psql so it needs no client installed on the host and works
// the same against the bundled container or a Postgres you already run.
async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const root = join(__dirname, '..');
  for (const file of ['db/schema.sql', 'db/seed.sql']) {
    console.log(`--> ${file}`);
    await client.query(readFileSync(join(root, file), 'utf8'));
  }

  await client.end();
  console.log(`database ready — ${describeTarget()}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
