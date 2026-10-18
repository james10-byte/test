import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [source, destination] = process.argv.slice(2);

if (!source || !destination) {
  console.error('Usage: snapshot-database.mjs <source> <destination>');
  process.exit(2);
}

if (!fs.existsSync(source)) {
  console.error('Source database not found.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.rmSync(destination, { force: true });

const database = new DatabaseSync(source);
database.exec('PRAGMA busy_timeout = 10000');
database.exec(`VACUUM INTO '${destination.replaceAll("'", "''")}'`);
database.close();
console.log(destination);
