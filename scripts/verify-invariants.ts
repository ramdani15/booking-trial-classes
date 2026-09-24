import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Client } from 'pg';
import { DATABASE_URL, describeTarget } from '../src/config';

// Runs scripts/verify-invariants.sql and prints the notices it raises. Same
// file psql would run; this just removes the need for a psql client and works
// against any server DATABASE_URL points at.
async function main() {
  const client = new Client({ connectionString: DATABASE_URL });

  let passed = 0;
  let failed = 0;
  client.on('notice', (n) => {
    const message = n.message ?? '';
    if (message.startsWith('ok:')) passed++;
    if (message.startsWith('FAIL')) failed++;
    console.log(`  ${message}`);
  });

  await client.connect();
  console.log(`\n  invariants, checked against ${describeTarget()} with no application code\n`);

  try {
    await client.query(readFileSync(join(__dirname, 'verify-invariants.sql'), 'utf8'));
  } catch (err) {
    console.error(`\n  FAILED: ${err instanceof Error ? err.message : err}\n`);
    await client.end();
    process.exit(1);
  }

  await client.end();
  console.log(`\n  ${failed === 0 ? `${passed} checks passed` : `${failed} check(s) FAILED`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
