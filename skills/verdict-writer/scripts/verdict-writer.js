import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import axios from 'axios';
import 'dotenv/config';
import { lyzrChat } from '../../../lyzr/lyzr-adapter.js';

function determineVerdict(report) {
  const { confidence_score, summary } = report;
  if (confidence_score < 0.5 || summary.critical > 0) {
    return 'NO-GO';
  }
  if (confidence_score >= 0.5 && (summary.high > 0 || report.new_baseline_entries > 0)) {
    return 'ESCALATE';
  }
  if (confidence_score >= 0.7 && summary.critical === 0 && summary.high === 0) {
    return 'GO';
  }
  return 'ESCALATE';
}

function verdictEmoji(verdict) {
  switch (verdict) {
    case 'GO': return '✓';
    case 'NO-GO': return '✗';
    case 'ESCALATE': return '⚠';
    default: return '?';
  }
}

async function composePRCommentWithLyzr(report, verdict, changeManifest) {
  try {
    const lyzrResult = await lyzrChat({
      message: `Write a GitHub PR comment for a deployment gate verdict. Be direct, specific, and actionable. Use markdown.

VERDICT: ${verdict}
CONFIDENCE: ${report.confidence_score}
PROBES FIRED: ${report.probes_compared}
CHANGE SUMMARY: ${changeManifest?.change_description || 'Not available'}

ANOMALIES:
${JSON.stringify(report.anomalies.slice(0, 10), null, 2)}

Rules:
- Start with a clear header: ✅ GO, ❌ NO-GO, or ⚠️ ESCALATE
- For each anomaly with semantic_change, explain it in plain English (not JSON)
- For NO-GO: give the specific action the developer should take
- For ESCALATE: explain exactly what a human reviewer should check
- For GO: briefly confirm what was tested and that it passed
- End with: probes fired count, powered by Lyzr Studio
- Keep under 400 words total
- Do NOT wrap in markdown code blocks — return raw markdown only`,
      userId: 'livegate_verdict_auditor',
    });

    return lyzrResult?.text || null;
  } catch (err) {
    process.stderr.write(`[lyzr] PR comment generation failed: ${err.message}, using fallback\n`);
    return null;
  }
}

function composePRCommentFallback(report, verdict) {
  const emoji = verdictEmoji(verdict);
  const { summary, anomalies, confidence_score, probes_compared } = report;
  const totalAnomalies = summary.critical + summary.high + summary.medium + summary.low;

  // Top finding per severity
  const topFinding = (severity) => {
    const a = anomalies.find(a => a.severity === severity);
    return a ? a.detail : '—';
  };

  const affectedProbes = [...new Set(anomalies.map(a => a.probe_id))].join(', ') || 'none';

  let recommendation;
  if (verdict === 'GO') {
    recommendation = `All ${probes_compared} probes passed within acceptable thresholds. Safe to deploy.`;
  } else if (verdict === 'ESCALATE') {
    recommendation = `Review required. ${totalAnomalies} anomalie(s) detected across probes: ${affectedProbes}. Manual review recommended before proceeding.`;
  } else {
    recommendation = `Deployment blocked. ${summary.critical} critical anomalie(s) detected. Probes affected: ${affectedProbes}. Do not deploy until issues are resolved.`;
  }

  return `## LiveGate Deployment Report ${emoji}

**Verdict: ${verdict} ${emoji}**
**Confidence:** ${confidence_score} | **Probes fired:** ${probes_compared} | **Anomalies:** ${totalAnomalies}

### What was tested
Probes derived from real traffic patterns from the last 24h of logs.

### Findings

| Severity | Count | Top finding |
|----------|-------|-------------|
| CRITICAL | ${summary.critical} | ${topFinding('CRITICAL')} |
| HIGH | ${summary.high} | ${topFinding('HIGH')} |
| MEDIUM | ${summary.medium} | ${topFinding('MEDIUM')} |

### Recommendation
${recommendation}

---
*LiveGate v0.1.0 | gitagent standard | Powered by Lyzr Studio*`;
}

async function main() {
  try {
    const outputDir = 'memory/runtime';
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const reportPath = process.argv[2] || `${outputDir}/anomaly-report.json`;
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

    const verdict = determineVerdict(report);

    // Read change manifest for context (written by runtime orchestrator)
    let changeManifest = null;
    try {
      changeManifest = JSON.parse(readFileSync(`${outputDir}/change-manifest.json`, 'utf-8'));
    } catch { /* not available */ }

    const prCommentMarkdown =
      (await composePRCommentWithLyzr(report, verdict, changeManifest))
      || composePRCommentFallback(report, verdict);

    const verdictOutput = {
      verdict,
      confidence: report.confidence_score,
      timestamp: new Date().toISOString(),
      anomaly_counts: report.summary,
      pr_comment_markdown: prCommentMarkdown,
    };

    // Write verdict file
    writeFileSync(`${outputDir}/verdict.json`, JSON.stringify(verdictOutput, null, 2));

    // Write escalation file if needed
    if (verdict === 'ESCALATE' || verdict === 'NO-GO') {
      const escalation = `# Escalation Report\n\n**Verdict:** ${verdict}\n**Confidence:** ${report.confidence_score}\n\n## Anomalies\n\n${report.anomalies.map(a => `- **${a.severity}** [${a.probe_id}]: ${a.detail}`).join('\n')}\n\n## Full Anomaly Report\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;
      writeFileSync(`${outputDir}/escalation.md`, escalation);
    }

    // Post to GitHub if env vars are set
    const githubToken = process.env.GITHUB_TOKEN;
    const githubRepo = process.env.GITHUB_REPO;
    const prNumber = process.env.PR_NUMBER;

    if (githubToken && githubRepo && prNumber) {
      try {
        const response = await axios.post(
          `https://api.github.com/repos/${githubRepo}/issues/${prNumber}/comments`,
          { body: prCommentMarkdown },
          {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: 'application/vnd.github.v3+json',
            },
            timeout: 10000,
          }
        );
        verdictOutput.github_comment_id = String(response.data.id);
        verdictOutput.github_comment_url = response.data.html_url;
        // Update verdict file with GitHub comment info
        writeFileSync(`${outputDir}/verdict.json`, JSON.stringify(verdictOutput, null, 2));
        process.stderr.write(`GitHub comment posted: ${response.data.html_url}\n`);
      } catch (ghErr) {
        process.stderr.write(`Warning: Failed to post GitHub comment: ${ghErr.message}\n`);
      }
    }

    console.log(JSON.stringify(verdictOutput, null, 2));

    // Exit code based on verdict
    if (verdict === 'NO-GO') process.exit(1);
    if (verdict === 'ESCALATE') process.exit(2);
    process.exit(0);
  } catch (err) {
    console.log(JSON.stringify({ error: err.message }, null, 2));
    process.exit(1);
  }
}

main();
