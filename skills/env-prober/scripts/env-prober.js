import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createHash } from 'crypto';
import axios from 'axios';
import 'dotenv/config';

const RATE_LIMIT_DELAY_MS = 100;
const TIMEOUT_MS = 10000;
const RETRY_DELAY_MS = 2000;

function buildUrl(baseUrl, path, queryParams) {
  const url = new URL(path, baseUrl);
  if (queryParams && typeof queryParams === 'object') {
    for (const [key, value] of Object.entries(queryParams)) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function sha256(data) {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

async function fireProbe(probe, baseUrl) {
  const url = buildUrl(baseUrl, probe.path, probe.query_params);
  const start = Date.now();

  try {
    const response = await axios({
      method: probe.method.toLowerCase(),
      url,
      headers: probe.headers || {},
      data: probe.body || undefined,
      timeout: TIMEOUT_MS,
      validateStatus: () => true, // Accept all status codes
    });

    const bodyStr = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data);

    return {
      probe_id: probe.id,
      status_code: response.status,
      latency_ms: Date.now() - start,
      response_body_hash: sha256(bodyStr),
      response_body_preview: bodyStr.slice(0, 600),
      content_type: response.headers['content-type'] || null,
      response_size_bytes: Buffer.byteLength(bodyStr, 'utf-8'),
      error: null,
    };
  } catch (err) {
    return {
      probe_id: probe.id,
      status_code: null,
      latency_ms: Date.now() - start,
      response_body_hash: null,
      response_body_preview: null,
      content_type: null,
      response_size_bytes: 0,
      error: err.message,
    };
  }
}

async function main() {
  try {
    const probeSetPath = process.argv[2];
    if (!probeSetPath) {
      throw new Error('Usage: env-prober.js <probe-set.json>');
    }

    const baseUrl = process.env.STAGING_BASE_URL;
    if (!baseUrl) {
      throw new Error('STAGING_BASE_URL environment variable is required');
    }

    const probeSet = JSON.parse(readFileSync(probeSetPath, 'utf-8'));
    const probes = probeSet.probes || [];

    // Ensure output directory exists
    const outputDir = 'memory/runtime';
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const results = [];

    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i];
      process.stderr.write(`[${i + 1}/${probes.length}] Firing ${probe.method} ${probe.path}...\n`);

      let result = await fireProbe(probe, baseUrl);

      // On 503: staging unavailable — write partial results and exit
      if (result.status_code === 503) {
        process.stderr.write(`ERROR: Staging returned 503 — environment unstable. Halting.\n`);
        results.push(result);
        writeResults(probeSet, baseUrl, results);
        process.exit(1);
      }

      // On network error: retry once after 2s
      if (result.error) {
        process.stderr.write(`  Retry in ${RETRY_DELAY_MS}ms due to error: ${result.error}\n`);
        await sleep(RETRY_DELAY_MS);
        result = await fireProbe(probe, baseUrl);
      }

      results.push(result);

      // Rate limiting: wait between probes
      if (i < probes.length - 1) {
        await sleep(RATE_LIMIT_DELAY_MS);
      }

      // Respect Retry-After header (handled via delay)
      if (result.status_code === 429) {
        process.stderr.write(`  Rate limited (429). Waiting 5s before next probe.\n`);
        await sleep(5000);
      }
    }

    writeResults(probeSet, baseUrl, results);

    // Write completion flag
    writeFileSync(`${outputDir}/probe-complete.flag`, '');
    process.stderr.write(`\nAll ${results.length} probes complete. Results written.\n`);

    // Output results JSON to stdout
    console.log(JSON.stringify(JSON.parse(readFileSync(`${outputDir}/probe-results.json`, 'utf-8')), null, 2));
  } catch (err) {
    console.log(JSON.stringify({ error: err.message, results: [] }, null, 2));
    process.exit(1);
  }
}

function writeResults(probeSet, baseUrl, results) {
  const output = {
    probe_set_id: probeSet.probe_set_id,
    environment: 'staging',
    base_url: baseUrl,
    executed_at: new Date().toISOString(),
    probes_fired: results.length,
    results,
  };
  writeFileSync('memory/runtime/probe-results.json', JSON.stringify(output, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main();
