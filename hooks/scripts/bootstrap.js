import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const RUNTIME_DIR = resolve(ROOT, 'memory/runtime');

try {
  // Create memory/runtime/ if not exists
  if (!existsSync(RUNTIME_DIR)) {
    mkdirSync(RUNTIME_DIR, { recursive: true });
  }

  // Create baseline.json if not exists
  const baselinePath = resolve(RUNTIME_DIR, 'baseline.json');
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, '{}');
  }

  // Create deployments.md if not exists
  const deploymentsPath = resolve(RUNTIME_DIR, 'deployments.md');
  if (!existsSync(deploymentsPath)) {
    writeFileSync(deploymentsPath, '# Deployment History\n');
  }

  process.stderr.write('LiveGate initialized\n');
} catch (err) {
  process.stderr.write(`Bootstrap error: ${err.message}\n`);
  process.exit(1);
}
