import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const RUNTIME_DIR = resolve(ROOT, 'memory/runtime');
const AUDIT_LOG_PATH = resolve(RUNTIME_DIR, 'audit.log');

async function main() {
  try {
    // Read JSON from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    const input = Buffer.concat(chunks).toString('utf-8').trim();

    let eventData = {};
    if (input) {
      try {
        eventData = JSON.parse(input);
      } catch {
        eventData = { raw: input };
      }
    }

    // Ensure directory exists
    if (!existsSync(RUNTIME_DIR)) {
      mkdirSync(RUNTIME_DIR, { recursive: true });
    }

    // Append audit log entry
    const entry = {
      timestamp: new Date().toISOString(),
      ...eventData,
    };
    appendFileSync(AUDIT_LOG_PATH, JSON.stringify(entry) + '\n');

    // Output allow action
    console.log(JSON.stringify({ action: 'allow' }));
  } catch (err) {
    process.stderr.write(`Audit log error: ${err.message}\n`);
    // Still allow the action even if audit logging fails
    console.log(JSON.stringify({ action: 'allow' }));
  }
}

main();
