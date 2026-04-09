import { readFileSync } from 'fs';
import 'dotenv/config';
import { lyzrChat, parseLyzrJson } from '../../../lyzr/lyzr-adapter.js';

const ROUTE_PATTERNS = [
  /app\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /@app\.route\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /@(router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
  /FastAPI.*@router\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi,
];

const SQL_PATTERNS = [
  /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^;]{3,}/gi,
];

const RISK_RULES = {
  critical: [/auth/i, /session/i, /payment/i, /delete/i, /password/i, /token/i],
  high: [/schema/i, /migration/i, /external.*api/i, /ALTER\s+TABLE/i, /DROP/i],
  medium: [/business/i, /response.*format/i, /filter/i, /query/i, /logic/i],
};

function classifyRisk(filePath, content) {
  for (const [level, patterns] of Object.entries(RISK_RULES)) {
    for (const p of patterns) {
      if (p.test(filePath) || p.test(content)) {
        return { level, reason: `Matched ${level} pattern: ${p.source}` };
      }
    }
  }
  return { level: 'low', reason: 'No high-risk patterns detected' };
}

function parseDiff(diffContent) {
  const files = [];
  const chunks = diffContent.split(/^diff --git /m).filter(Boolean);

  for (const chunk of chunks) {
    const fileMatch = chunk.match(/a\/(\S+)\s+b\/(\S+)/);
    if (!fileMatch) continue;

    const filePath = fileMatch[2];
    const addedLines = [];
    const removedLines = [];
    const contextLines = [];
    const hunkHeaders = [];

    for (const line of chunk.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) addedLines.push(line.slice(1));
      else if (line.startsWith('-') && !line.startsWith('---')) removedLines.push(line.slice(1));
      else if (line.startsWith(' ')) contextLines.push(line.slice(1));
      else if (line.startsWith('@@')) hunkHeaders.push(line);
    }

    const allChanged = [...addedLines, ...removedLines].join('\n');
    const allContext = [...contextLines, ...hunkHeaders].join('\n');
    const isNew = chunk.includes('new file mode');
    const isDeleted = chunk.includes('deleted file mode');

    const changeType = isNew ? 'added' : isDeleted ? 'deleted' : 'modified';

    const routes = [];
    // Scan changed lines AND context/hunk headers for route definitions
    for (const source of [allChanged, allContext]) {
      for (const pattern of ROUTE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null) {
          const groups = match.slice(1);
          const method = groups.find(g => /^(get|post|put|patch|delete)$/i.test(g));
          const path = groups.find(g => g && g.startsWith('/'));
          if (method && path) {
            routes.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }
    }

    const dbOps = [];
    for (const pattern of SQL_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(allChanged)) !== null) {
        dbOps.push(match[0].trim().substring(0, 80));
      }
    }

    const { level, reason } = classifyRisk(filePath, allChanged);

    files.push({
      file_path: filePath,
      change_type: changeType,
      affected_routes: [...new Set(routes)],
      affected_db_operations: [...new Set(dbOps)],
      risk_level: level,
      risk_reason: reason,
    });
  }

  return files;
}

async function analyzeWithLyzr(rawDiff) {
  const result = await lyzrChat({
    message: `Analyze this git diff for a deployment gate.

Return ONLY this JSON, no markdown:
{
  "change_description": "2 sentences: what changed and why it matters for deployment safety",
  "affected_routes": [
    {
      "method": "GET",
      "path": "/api/orders",
      "risk_level": "high",
      "change_summary": "Added priority filter that queries without using the orders_priority index"
    }
  ],
  "affected_db_operations": ["SELECT from orders WHERE priority = ?"],
  "overall_risk": "high",
  "probe_targets": ["GET /api/orders", "GET /api/orders/:id"]
}

Risk levels:
- critical: auth, sessions, payments, data deletion
- high: query logic, data mutations, schema changes
- medium: new parameters, validation changes
- low: logging, comments, config

Diff:
${rawDiff.slice(0, 10000)}`,
  });

  if (!result?.text) {
    throw new Error('Lyzr returned empty response for diff analysis');
  }

  return parseLyzrJson(result.text);
}

function computeOverallRisk(files) {
  const levels = ['critical', 'high', 'medium', 'low'];
  for (const level of levels) {
    if (files.some(f => f.risk_level === level)) return level;
  }
  return 'low';
}

async function main() {
  try {
    let diffContent = '';
    const inputPath = process.argv[2];

    if (inputPath) {
      diffContent = readFileSync(inputPath, 'utf-8');
    } else {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      diffContent = Buffer.concat(chunks).toString('utf-8');
    }

    if (!diffContent.trim()) {
      console.log(JSON.stringify({
        diff_summary: 'Empty diff',
        changed_files: 0,
        affected_routes: [],
        affected_db_operations: [],
        overall_risk: 'low',
        probe_targets: [],
      }, null, 2));
      return;
    }

    // Primary: Lyzr semantic analysis
    const lyzrAnalysis = await analyzeWithLyzr(diffContent);

    // Supplement: regex catches any routes Lyzr missed
    const regexFiles = parseDiff(diffContent);
    const regexRoutes = regexFiles.flatMap(f =>
      f.affected_routes.map(r => ({
        method: r.split(' ')[0],
        path: r.split(' ').slice(1).join(' '),
        risk_level: f.risk_level,
        change_summary: 'Detected by static analysis',
      }))
    );

    // Merge: Lyzr routes take precedence, regex fills gaps
    const allRoutes = [...(lyzrAnalysis.affected_routes || [])];
    for (const regexRoute of regexRoutes) {
      const alreadyFound = allRoutes.some(
        r => r.method === regexRoute.method && r.path === regexRoute.path
      );
      if (!alreadyFound) allRoutes.push({ ...regexRoute, source: 'regex_supplement' });
    }

    const output = {
      diff_summary: `${regexFiles.length} file(s) changed`,
      changed_files: regexFiles.length,
      change_description: lyzrAnalysis.change_description,
      affected_routes: allRoutes,
      affected_db_operations: lyzrAnalysis.affected_db_operations || [],
      overall_risk: lyzrAnalysis.overall_risk,
      probe_targets: [...new Set(allRoutes.map(r => `${r.method} ${r.path}`))],
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      error: err.message,
      probe_targets: [],
    }, null, 2));
    process.exit(1);
  }
}

main();
