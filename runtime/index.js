import { execFile } from 'child_process';
import { promisify } from 'util';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import chalk from 'chalk';
import 'dotenv/config';

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

async function runScript(scriptPath, args = []) {
  const { stdout, stderr } = await execFileAsync('node', [resolve(ROOT, scriptPath), ...args], {
    cwd: ROOT,
    env: { ...process.env },
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

export default async function run({ gitDiffPath, logSource, logPath, stagingUrl, githubRepo, prNumber }) {
  ensureMemoryDir();

  try {
    // Step 1: diff-reader
    console.log(chalk.green('▶ [1/6] Running diff-reader...'));
    const diffOutput = await runScript('skills/diff-reader/scripts/diff-reader.js', [gitDiffPath]);
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
    ]);
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
    ]);
    const probeSet = JSON.parse(probeSetOutput);
    writeIntermediate('probe-set.json', probeSet);
    console.log(chalk.blue(`  ✓ probe-generator complete: ${probeSet.total_probes} probe(s) generated`));

    // Step 4: env-prober (as probe-executor sub-agent)
    console.log(chalk.green('▶ [4/6] Running env-prober (probe-executor agent)...'));
    const probeSetPath = resolve(MEMORY_DIR, 'probe-set.json');
    const probeResultsOutput = await runScript('skills/env-prober/scripts/env-prober.js', [probeSetPath]);
    const probeResults = JSON.parse(probeResultsOutput);
    console.log(chalk.blue(`  ✓ env-prober complete: ${probeResults.probes_fired} probe(s) fired`));

    // Step 5: behavior-comparator
    console.log(chalk.green('▶ [5/6] Running behavior-comparator...'));
    const anomalyOutput = await runScript('skills/behavior-comparator/scripts/behavior-comparator.js', []);
    const anomalyReport = JSON.parse(anomalyOutput);
    console.log(chalk.blue(`  ✓ behavior-comparator complete: confidence=${anomalyReport.confidence_score}, anomalies=${anomalyReport.anomalies.length}`));

    // Step 6: verdict-writer (as verdict-auditor sub-agent)
    console.log(chalk.green('▶ [6/6] Running verdict-writer (verdict-auditor agent)...'));
    // Set GitHub env vars for verdict-writer if provided
    const verdictEnv = { ...process.env };
    if (githubRepo) verdictEnv.GITHUB_REPO = githubRepo;
    if (prNumber) verdictEnv.PR_NUMBER = String(prNumber);

    let verdictOutput;
    try {
      const { stdout, stderr } = await execFileAsync('node', [
        resolve(ROOT, 'skills/verdict-writer/scripts/verdict-writer.js'),
      ], {
        cwd: ROOT,
        env: verdictEnv,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
      });
      if (stderr) process.stderr.write(stderr);
      verdictOutput = stdout.trim();
    } catch (verdictErr) {
      // verdict-writer exits non-zero for NO-GO (1) and ESCALATE (2)
      if (verdictErr.stdout) {
        verdictOutput = verdictErr.stdout.trim();
      } else {
        throw verdictErr;
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
    const verdict = writeEscalateVerdict(err.message);
    return verdict;
  }
}

// CLI interface
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
${chalk.bold('LiveGate Runtime')} — Real-environment CI/CD testing

${chalk.bold('Usage:')}
  node runtime/index.js [options]

${chalk.bold('Required:')}
  --diff <path>         Path to git diff file, or 'HEAD~1'
  --log-path <path>     Path or ARN for access logs
  --staging <url>       Base URL of staging environment

${chalk.bold('Optional:')}
  --log-source <type>   Log source: file | cloudwatch | datadog (default: file)
  --repo <owner/repo>   GitHub repo for PR comment
  --pr <number>         Pull request number for PR comment
  --help                Show this help

${chalk.bold('Examples:')}
  node runtime/index.js --diff changes.diff --log-path /var/log/nginx/access.log --staging http://staging.example.com
  node runtime/index.js --diff HEAD~1 --log-path /var/log/access.log --staging http://staging:3000 --repo owner/repo --pr 42

${chalk.bold('Environment Variables:')}
  STAGING_BASE_URL      Fallback staging URL (overridden by --staging)
  GITHUB_TOKEN          GitHub API token for PR comments
  GITHUB_REPO           Fallback GitHub repo (overridden by --repo)
  PR_NUMBER             Fallback PR number (overridden by --pr)
`);
    process.exit(0);
  }

  function getArg(flag) {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
  }

  const gitDiffPath = getArg('--diff');
  const logSource = getArg('--log-source') || 'file';
  const logPath = getArg('--log-path');
  const stagingUrl = getArg('--staging') || process.env.STAGING_BASE_URL;
  const githubRepo = getArg('--repo') || process.env.GITHUB_REPO;
  const prNumber = getArg('--pr') || process.env.PR_NUMBER;

  if (!gitDiffPath) { console.error(chalk.red('Error: --diff is required')); process.exit(1); }
  if (!logPath) { console.error(chalk.red('Error: --log-path is required')); process.exit(1); }
  if (!stagingUrl) { console.error(chalk.red('Error: --staging is required (or set STAGING_BASE_URL)')); process.exit(1); }

  // Set STAGING_BASE_URL for env-prober
  process.env.STAGING_BASE_URL = stagingUrl;

  run({ gitDiffPath, logSource, logPath, stagingUrl, githubRepo, prNumber: prNumber ? parseInt(prNumber, 10) : undefined })
    .then(verdict => {
      if (verdict.verdict === 'NO-GO') process.exit(1);
      if (verdict.verdict === 'ESCALATE') process.exit(2);
      process.exit(0);
    })
    .catch(err => {
      console.error(chalk.red(`Fatal: ${err.message}`));
      process.exit(1);
    });
}
