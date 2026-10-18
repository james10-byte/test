import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [file] = process.argv.slice(2);

if (!file || !fs.existsSync(file)) {
  console.error('Database file not found.');
  process.exit(2);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'db-check-'));
const copy = path.join(directory, 'copy.sqlite');
fs.copyFileSync(file, copy);

let exitCode = 0;
try {
  const database = new DatabaseSync(copy);
  const integrity = database.prepare('PRAGMA integrity_check').get();
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  if (Object.values(integrity)[0] !== 'ok') throw new Error('Integrity check failed.');
  for (const required of ['builds', 'build_logs']) {
    if (!tables.includes(required)) throw new Error(`Missing table ${required}.`);
  }
  const { count } = database.prepare('SELECT COUNT(*) AS count FROM builds').get();
  console.log(`ok builds=${count}`);
  database.close();
} catch (error) {
  console.error(error.message);
  exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
process.exit(exitCode);
