#!/usr/bin/env node
import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { randomUUID } from 'crypto';
import chalk from 'chalk';
import 'dotenv/config';
import { isLyzrConfigured } from '../lyzr/lyzr-adapter.js';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const MEMORY_DIR = resolve(ROOT, 'memory/runtime');

function ensureMemoryDir() {
  if (!existsSync(MEMORY_DIR)) {
    mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

function writeIntermediate(name, data) {
  ensureMemoryDir();
  writeFileSync(resolve(MEMORY_DIR, name), JSON.stringify(data, null, 2));
}

async function runScript(scriptPath, args = [], extraEnv = {}) {
  const { stdout, stderr } = await execFileAsync('node', [resolve(ROOT, scriptPath), ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (stderr) process.stderr.write(stderr);
  return stdout.trim();
}

function writeEscalateVerdict(errorMessage) {
  ensureMemoryDir();
  const verdict = {
    verdict: 'ESCALATE',
    confidence: 0,
    timestamp: new Date().toISOString(),
    anomaly_counts: { critical: 0, high: 0, medium: 0, low: 0 },
    error: errorMessage,
    pr_comment_markdown: `## LiveGate Deployment Report ⚠\n\n**Verdict: ESCALATE ⚠**\n\n### Error\n${errorMessage}\n\n---\n*LiveGate v0.1.0 | Pipeline error — manual review required*`,
  };
  writeFileSync(resolve(MEMORY_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2));
  return verdict;
}

async function autoDetectDiff() {
  try {
    // Try to get diff from last commit
    const { stdout } = await execFileAsync('git', ['diff', 'HEAD~1'], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    if (stdout.trim()) {
      const diffPath = resolve(MEMORY_DIR, 'auto-diff.patch');
      writeFileSync(diffPath, stdout);
      return diffPath;
    }
  } catch { /* not a git repo or no commits */ }

  // Try staged changes
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--cached'], {
      cwd: process.cwd(),
      timeout: 10000,
    });
    if (stdout.trim()) {
      const diffPath = resolve(MEMORY_DIR, 'auto-diff.patch');
      writeFileSync(diffPath, stdout);
      return diffPath;
    }
  } catch { /* ignore */ }

  return null;
}

function autoSaveBaseline() {
  try {
    const resultsPath = resolve(MEMORY_DIR, 'probe-results.json');
    if (!existsSync(resultsPath)) return;
    const results = JSON.parse(readFileSync(resultsPath, 'utf-8'));
    const baseline = {};
    for (const r of results.results) { baseline[r.probe_id] = r; }
    writeFileSync(resolve(MEMORY_DIR, 'baseline.json'), JSON.stringify(baseline, null, 2));
  } catch { /* ignore */ }
}

export default async function run({ gitDiffPath, logSource, logPath, stagingUrl, githubRepo, prNumber }) {
  ensureMemoryDir();

  // Auto-initialize baseline if empty
  const baselinePath = resolve(MEMORY_DIR, 'baseline.json');
  if (!existsSync(baselinePath)) {
    writeFileSync(baselinePath, '{}');
  }

  // ── Lyzr required ────────────────────────────────────────────
  if (!isLyzrConfigured()) {
    console.error(`
╔═══════════════════════════════════════════════════════════╗
║              LiveGate requires Lyzr Studio                ║
╠═══════════════════════════════════════════════════════════╣
║  LiveGate's AI analysis runs through Lyzr Studio.         ║
║  Without it, there is no diff understanding, no smart     ║
║  probe generation, and no semantic verdict reasoning.     ║
║                                                           ║
║  Setup (5 min):                                           ║
║    1. Go to https://studio.lyzr.ai                        ║
║    2. Create the LiveGate agent (see lyzr/README.md)      ║
║    3. Add to .env:                                        ║
║         LYZR_API_KEY=your_key                             ║
║         LYZR_AGENT_ID=your_agent_id                       ║
╚═══════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }

  // ── One session ID for the entire pipeline ───────────────────
  const PIPELINE_SESSION_ID = randomUUID();
  const lyzrEnv = { LYZR_PIPELINE_SESSION_ID: PIPELINE_SESSION_ID };
  console.log(chalk.gray(`  Lyzr session: ${PIPELINE_SESSION_ID}`));

  try {
    // Step 1: diff-reader
    console.log(chalk.green('▶ [1/6] Running diff-reader...'));
    const diffOutput = await runScript('skills/diff-reader/scripts/diff-reader.js', [gitDiffPath], lyzrEnv);
    const changeManifest = JSON.parse(diffOutput);
    writeIntermediate('change-manifest.json', changeManifest);
    console.log(chalk.blue(`  ✓ diff-reader complete: ${changeManifest.changed_files} file(s), ${changeManifest.probe_targets.length} target(s), risk: ${changeManifest.overall_risk}`));

    // Early exit if no routes affected
    if (!changeManifest.probe_targets || changeManifest.probe_targets.length === 0) {
      console.log(chalk.yellow('  ⚠ No affected routes found. Exiting early.'));
      const verdict = {
        verdict: 'GO',
        confidence: 1.0,
        timestamp: new Date().toISOString(),
        anomaly_counts: { critical: 0, high: 0, medium: 0, low: 0 },
        note: 'No affected routes found — no probes needed',
        pr_comment_markdown: '## LiveGate Deployment Report ✓\n\n**Verdict: GO ✓**\n\nNo affected routes detected in diff. No probes needed.\n\n---\n*LiveGate v0.1.0*',
      };
      writeIntermediate('verdict.json', verdict);
      return verdict;
    }

    // Step 2: log-miner
    console.log(chalk.green('▶ [2/6] Running log-miner...'));
    const logPatternsOutput = await runScript('skills/log-miner/scripts/log-miner.js', [
      logPath,
      JSON.stringify(changeManifest.probe_targets),
    ], lyzrEnv);
    const logPatterns = JSON.parse(logPatternsOutput);
    writeIntermediate('log-patterns.json', logPatterns);
    console.log(chalk.blue(`  ✓ log-miner complete: ${logPatterns.total_requests_analyzed} requests analyzed, ${logPatterns.patterns.length} pattern(s)`));

    // Step 3: probe-generator
    console.log(chalk.green('▶ [3/6] Running probe-generator...'));
    const changeManifestPath = resolve(MEMORY_DIR, 'change-manifest.json');
    const logPatternsPath = resolve(MEMORY_DIR, 'log-patterns.json');
    const probeSetOutput = await runScript('skills/probe-generator/scripts/probe-generator.js', [
      changeManifestPath,
      logPatternsPath,
    ], lyzrEnv);
    const probeSet = JSON.parse(probeSetOutput);
    writeIntermediate('probe-set.json', probeSet);
    console.log(chalk.blue(`  ✓ probe-generator complete: ${probeSet.total_probes} probe(s) generated`));

    // Step 4: env-prober (as probe-executor sub-agent)
    console.log(chalk.green('▶ [4/6] Running env-prober (probe-executor agent)...'));
    const probeSetPath = resolve(MEMORY_DIR, 'probe-set.json');
    const probeResultsOutput = await runScript('skills/env-prober/scripts/env-prober.js', [probeSetPath], lyzrEnv);
    const probeResults = JSON.parse(probeResultsOutput);
    console.log(chalk.blue(`  ✓ env-prober complete: ${probeResults.probes_fired} probe(s) fired`));

    // Step 5: behavior-comparator
    console.log(chalk.green('▶ [5/6] Running behavior-comparator...'));
    const anomalyOutput = await runScript('skills/behavior-comparator/scripts/behavior-comparator.js', [], lyzrEnv);
    const anomalyReport = JSON.parse(anomalyOutput);
    console.log(chalk.blue(`  ✓ behavior-comparator complete: confidence=${anomalyReport.confidence_score}, anomalies=${anomalyReport.anomalies.length}`));

    // Step 6: verdict-writer (as verdict-auditor sub-agent)
    console.log(chalk.green('▶ [6/6] Running verdict-writer (verdict-auditor agent)...'));
    // Set GitHub env vars for verdict-writer if provided
    const verdictEnv = { ...process.env, ...lyzrEnv };
    if (githubRepo) verdictEnv.GITHUB_REPO = githubRepo;
    if (prNumber) verdictEnv.PR_NUMBER = String(prNumber);

    let verdictOutput;
    try {
      const { stdout, stderr } = await execFileAsync('node', [
        resolve(ROOT, 'skills/verdict-writer/scripts/verdict-writer.js'),
      ], {
        cwd: ROOT,
        env: verdictEnv,
        timeout: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr) process.stderr.write(stderr);
      verdictOutput = stdout.trim();
    } catch (verdictErr) {
      // verdict-writer exits non-zero for NO-GO (1) and ESCALATE (2)
      if (verdictErr.stdout) {
        verdictOutput = verdictErr.stdout.trim();
      }
      if (verdictErr.stderr) process.stderr.write(verdictErr.stderr);
    }

    // Read verdict from file if stdout was empty (Lyzr call may have consumed stdout time)
    if (!verdictOutput) {
      const verdictPath = resolve(MEMORY_DIR, 'verdict.json');
      if (existsSync(verdictPath)) {
        verdictOutput = readFileSync(verdictPath, 'utf-8');
      } else {
        throw new Error('Verdict writer produced no output');
      }
    }

    const verdict = JSON.parse(verdictOutput);
    console.log(chalk.blue(`  ✓ verdict-writer complete: ${verdict.verdict}`));

    if (verdict.verdict === 'GO') {
      console.log(chalk.green(`\n✅ VERDICT: GO — Safe to deploy (confidence: ${verdict.confidence})`));
    } else if (verdict.verdict === 'ESCALATE') {
      console.log(chalk.yellow(`\n⚠️  VERDICT: ESCALATE — Manual review required (confidence: ${verdict.confidence})`));
    } else {
      console.log(chalk.red(`\n❌ VERDICT: NO-GO — Do NOT deploy (confidence: ${verdict.confidence})`));
    }

    return verdict;
  } catch (err) {
    console.log(chalk.red(`\n❌ Pipeline error: ${err.message}`));
    throw err;
  }
}

// CLI interface
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${chalk.bold('LiveGate')} — Real-environment deployment gate powered by Lyzr Studio

${chalk.bold('Usage:')}
  npx livegate                    Auto-detect diff + use .env config (recommended)
  npx livegate check              Same as above
  node runtime/index.js [options] Manual mode with explicit flags

${chalk.bold('Zero-config mode (reads from .env):')}
  STAGING_BASE_URL    Where to fire probes
  LOG_PATH            Where to find access logs
  LYZR_API_KEY        Lyzr Studio API key
  LYZR_AGENT_ID       Lyzr Studio agent ID

${chalk.bold('Manual flags (override .env):')}
  --diff <path>       Path to git diff file (default: auto-detect from git)
  --log-path <path>   Path to access logs (default: LOG_PATH from .env)
  --staging <url>     Staging URL (default: STAGING_BASE_URL from .env)
  --log-source <type> file | otel (default: LOG_SOURCE from .env or 'file')
  --repo <owner/repo> GitHub repo for PR comment
  --pr <number>       Pull request number for PR comment

${chalk.bold('Examples:')}
  npx livegate                                          # auto-detect everything
  npx livegate --diff changes.diff                      # specific diff file
  npx livegate --staging http://staging:3001             # override staging URL

${chalk.bold('What happens:')}
  1. Reads git diff (auto or from --diff)
  2. Lyzr analyzes what changed semantically
  3. Mines traffic patterns from logs
  4. Lyzr generates targeted edge-case probes
  5. Fires all probes against staging
  6. Lyzr compares behavior against stored baseline
  7. Lyzr writes GO / NO-GO / ESCALATE verdict
  8. Baseline auto-updates on GO verdict
`);
    process.exit(0);
  }

  function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  }

  // Auto-detect everything from .env if no flags provided
  const logSource = getArg('--log-source') || process.env.LOG_SOURCE || 'file';
  const logPath = getArg('--log-path') || process.env.LOG_PATH;
  const stagingUrl = getArg('--staging') || process.env.STAGING_BASE_URL;
  const githubRepo = getArg('--repo') || process.env.GITHUB_REPO;
  const prNumber = getArg('--pr') || process.env.PR_NUMBER;

  if (!stagingUrl) {
    console.error(chalk.red('Error: Set STAGING_BASE_URL in .env or pass --staging <url>'));
    process.exit(1);
  }
  if (!logPath) {
    console.error(chalk.red('Error: Set LOG_PATH in .env or pass --log-path <path>'));
    process.exit(1);
  }

  // Set STAGING_BASE_URL for env-prober
  process.env.STAGING_BASE_URL = stagingUrl;

  // Auto-detect diff if not provided
  let gitDiffPath = getArg('--diff');

  (async () => {
    if (!gitDiffPath) {
      ensureMemoryDir();
      console.log(chalk.gray('  Auto-detecting git diff...'));
      gitDiffPath = await autoDetectDiff();
      if (!gitDiffPath) {
        // Use demo diff as fallback
        const demoDiff = resolve(ROOT, 'demo/sample-diff/change.diff');
        if (existsSync(demoDiff)) {
          gitDiffPath = demoDiff;
          console.log(chalk.gray('  Using demo diff (no git changes detected)'));
        } else {
          console.error(chalk.red('Error: No git diff detected and no --diff provided'));
          process.exit(1);
        }
      } else {
        console.log(chalk.gray('  Found git diff from HEAD~1'));
      }
    }

    const verdict = await run({ gitDiffPath, logSource, logPath, stagingUrl, githubRepo, prNumber: prNumber ? parseInt(prNumber, 10) : undefined });

    // Auto-save baseline on GO, or on first-ever ESCALATE (bootstrap)
    const baselineData = JSON.parse(readFileSync(resolve(MEMORY_DIR, 'baseline.json'), 'utf-8'));
    const isFirstRun = Object.keys(baselineData).length === 0;

    if (verdict.verdict === 'GO') {
      autoSaveBaseline();
      console.log(chalk.gray('  Baseline auto-updated for next run'));
    } else if (isFirstRun && verdict.verdict === 'ESCALATE') {
      autoSaveBaseline();
      console.log(chalk.gray('  First run — baseline bootstrapped. Run again for a real comparison.'));
    }

    if (verdict.verdict === 'NO-GO') process.exit(1);
    if (verdict.verdict === 'ESCALATE') process.exit(2);
    process.exit(0);
  })().catch(err => {
    console.error(chalk.red(`Fatal: ${err.message}`));
    process.exit(1);
  });
}
