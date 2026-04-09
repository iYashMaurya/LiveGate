import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, existsSync } from 'fs';
import 'dotenv/config';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Dynamic import of the LiveGate runtime
async function getRuntime() {
  const runtimePath = resolve(ROOT, 'runtime/index.js');
  const mod = await import(runtimePath);
  return mod.default;
}

// Skill script runners for individual skill calls
async function runSkill(skillName, args = []) {
  const { execFile } = await import('child_process');
  const { promisify } = await import('util');
  const execFileAsync = promisify(execFile);

  const scriptPath = resolve(ROOT, `skills/${skillName}/scripts/${skillName}.js`);
  if (!existsSync(scriptPath)) {
    throw new Error(`Skill script not found: ${scriptPath}`);
  }

  const { stdout, stderr } = await execFileAsync('node', [scriptPath, ...args], {
    cwd: ROOT,
    env: { ...process.env },
    timeout: 120000,
    maxBuffer: 10 * 1024 * 1024,
  });

  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

/**
 * Handle a Lyzr-style tool call and route it to the appropriate LiveGate skill.
 *
 * @param {Object} payload - Lyzr tool call payload
 * @param {string} payload.action - One of: run_pipeline, diff_reader, log_miner,
 *   probe_generator, env_prober, behavior_comparator, verdict_writer, get_verdict
 * @param {Object} payload.params - Parameters for the action
 * @returns {Object} Lyzr-compatible response
 */
export async function handleLyzrRequest(payload) {
  const { action, params = {} } = payload;

  try {
    switch (action) {
      case 'run_pipeline': {
        const run = await getRuntime();
        const verdict = await run({
          gitDiffPath: params.gitDiffPath || params.diff_path,
          logSource: params.logSource || params.log_source || 'file',
          logPath: params.logPath || params.log_path,
          stagingUrl: params.stagingUrl || params.staging_url || process.env.STAGING_BASE_URL,
          githubRepo: params.githubRepo || params.github_repo || process.env.GITHUB_REPO,
          prNumber: params.prNumber || params.pr_number,
        });
        return {
          status: 'success',
          action: 'run_pipeline',
          result: verdict,
        };
      }

      case 'diff_reader': {
        const { stdout } = await runSkill('diff-reader', [params.diff_path]);
        return {
          status: 'success',
          action: 'diff_reader',
          result: JSON.parse(stdout),
        };
      }

      case 'log_miner': {
        const probeTargets = typeof params.probe_targets === 'string'
          ? params.probe_targets
          : JSON.stringify(params.probe_targets || []);
        const { stdout } = await runSkill('log-miner', [params.log_path, probeTargets]);
        return {
          status: 'success',
          action: 'log_miner',
          result: JSON.parse(stdout),
        };
      }

      case 'probe_generator': {
        const { stdout } = await runSkill('probe-generator', [
          params.change_manifest_path,
          params.log_patterns_path,
        ]);
        return {
          status: 'success',
          action: 'probe_generator',
          result: JSON.parse(stdout),
        };
      }

      case 'env_prober': {
        const { stdout } = await runSkill('env-prober', [params.probe_set_path]);
        return {
          status: 'success',
          action: 'env_prober',
          result: JSON.parse(stdout),
        };
      }

      case 'behavior_comparator': {
        const args = [];
        if (params.probe_results_path) args.push(params.probe_results_path);
        if (params.baseline_path) args.push(params.baseline_path);
        const { stdout } = await runSkill('behavior-comparator', args);
        return {
          status: 'success',
          action: 'behavior_comparator',
          result: JSON.parse(stdout),
        };
      }

      case 'verdict_writer': {
        const args = [];
        if (params.anomaly_report_path) args.push(params.anomaly_report_path);
        const { stdout } = await runSkill('verdict-writer', args);
        return {
          status: 'success',
          action: 'verdict_writer',
          result: JSON.parse(stdout),
        };
      }

      case 'get_verdict': {
        const verdictPath = resolve(ROOT, 'memory/runtime/verdict.json');
        if (!existsSync(verdictPath)) {
          return {
            status: 'error',
            action: 'get_verdict',
            error: 'No verdict found. Run the pipeline first.',
          };
        }
        const verdict = JSON.parse(readFileSync(verdictPath, 'utf-8'));
        return {
          status: 'success',
          action: 'get_verdict',
          result: verdict,
        };
      }

      default:
        return {
          status: 'error',
          action,
          error: `Unknown action: ${action}. Available: run_pipeline, diff_reader, log_miner, probe_generator, env_prober, behavior_comparator, verdict_writer, get_verdict`,
        };
    }
  } catch (err) {
    return {
      status: 'error',
      action,
      error: err.message,
    };
  }
}

// CLI interface for testing
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMain) {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) {
    console.log(`
Lyzr Adapter for LiveGate

Usage:
  node lyzr/lyzr-adapter.js <action> [--param value ...]

Actions:
  run_pipeline      Run full LiveGate pipeline
  diff_reader       Run diff-reader skill
  log_miner         Run log-miner skill
  get_verdict       Get the last verdict

Examples:
  node lyzr/lyzr-adapter.js run_pipeline --diff_path demo/sample-diff/change.diff --log_path demo/sample-logs/access.log --staging_url http://localhost:3001
  node lyzr/lyzr-adapter.js get_verdict
`);
    process.exit(0);
  }

  const action = args[0];
  const params = {};
  for (let i = 1; i < args.length; i += 2) {
    if (args[i].startsWith('--') && args[i + 1]) {
      params[args[i].slice(2)] = args[i + 1];
    }
  }

  handleLyzrRequest({ action, params })
    .then(result => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.status === 'error' ? 1 : 0);
    })
    .catch(err => {
      console.error(err.message);
      process.exit(1);
    });
}
