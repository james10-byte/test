import fs from 'node:fs';
import path from 'node:path';

const output = process.argv[2] ?? path.resolve(import.meta.dirname, '../frontend/config.js');
const raw = (process.env.API_BASE ?? '').trim().replace(/\/+$/, '');

let apiBase = '';
if (raw !== '') {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    console.error('API_BASE is not a valid URL.');
    process.exit(1);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    console.error('API_BASE must use http or https.');
    process.exit(1);
  }
  apiBase = `${parsed.origin}${parsed.pathname === '/' ? '' : parsed.pathname}`;
}

fs.writeFileSync(output, `window.INCONNU_CONFIG = { apiBase: ${JSON.stringify(apiBase)} };\n`);
console.log(`Wrote ${output} with apiBase=${apiBase === '' ? '(same origin)' : apiBase}`);
