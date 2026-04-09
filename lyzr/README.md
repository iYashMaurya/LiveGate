# LiveGate × Lyzr Studio Integration

Deploy LiveGate as a Lyzr Studio agent for managed AI agent hosting with built-in memory, tool orchestration, and monitoring.

## Quick Start

### 1. Import the Agent Definition

1. Open [Lyzr Studio](https://studio.lyzr.ai)
2. Navigate to **Agents → Create New Agent**
3. Click **Import from JSON**
4. Upload `lyzr-agent.json` from this directory
5. Lyzr will create the agent with the correct model, system prompt, and memory configuration

> **Alternative**: Copy the contents of `system-prompt.txt` and paste it into the **System Prompt** field when creating a new agent manually.

### 2. Configure Environment Variables

In Lyzr Studio, navigate to **Agent Settings → Environment Variables** and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key for Claude |
| `STAGING_BASE_URL` | Yes | Your staging environment URL |
| `GITHUB_TOKEN` | No | GitHub token for PR comment posting |
| `LOG_SOURCE` | No | `file`, `cloudwatch`, or `datadog` (default: `file`) |
| `LOG_PATH` | Yes | Path or ARN for access logs |
| `LYZR_API_KEY` | Auto | Provided by Lyzr Studio automatically |

### 3. Link with gitagent CLI

If you have `LYZR_API_KEY` set:

```bash
# Create the agent on Lyzr platform
npx gitagent lyzr create

# Verify the agent is linked
npx gitagent lyzr info

# Sync agent definition after local changes
npx gitagent lyzr sync
```

### 4. Trigger LiveGate from Lyzr

#### Via Lyzr Studio UI
1. Open your LiveGate agent in Lyzr Studio
2. In the chat interface, send a message like:
   ```
   Run deployment check on diff at /path/to/change.diff
   with logs from /var/log/nginx/access.log
   against staging at https://staging.example.com
   ```
3. LiveGate will execute the full 6-skill pipeline and return the verdict

#### Via Lyzr API
```bash
curl -X POST https://api.lyzr.ai/v1/agents/{agent_id}/chat \
  -H "Authorization: Bearer $LYZR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Run pre-deploy check",
    "metadata": {
      "diff_path": "/path/to/change.diff",
      "log_path": "/var/log/nginx/access.log",
      "staging_url": "https://staging.example.com"
    }
  }'
```

#### Via Lyzr Adapter (Programmatic)
```javascript
import { handleLyzrRequest } from './lyzr-adapter.js';

const result = await handleLyzrRequest({
  action: 'run_pipeline',
  params: {
    gitDiffPath: 'path/to/change.diff',
    logPath: '/var/log/nginx/access.log',
    stagingUrl: 'https://staging.example.com'
  }
});
```

### 5. Lyzr Studio Screenshots

> **[Screenshot: Agent Creation]**
> Import `lyzr-agent.json` in the Lyzr Studio agent creation dialog.

> **[Screenshot: Environment Variables]**
> Configure STAGING_BASE_URL and other variables in Agent Settings.

> **[Screenshot: Chat Interface]**
> LiveGate responding with a GO verdict in the Lyzr Studio chat.

> **[Screenshot: Memory Panel]**
> Lyzr's built-in memory showing stored baselines and deployment history.

## Architecture

```
Lyzr Studio
  ├── LiveGate Agent (imported from lyzr-agent.json)
  │   ├── System Prompt (from system-prompt.txt)
  │   ├── Model: Claude claude-sonnet-4-6 via Anthropic
  │   ├── Memory: Lyzr managed (50 message context)
  │   └── Tools: Connected via lyzr-adapter.js
  │
  └── lyzr-adapter.js
      ├── Wraps LiveGate runtime/index.js
      ├── Translates Lyzr tool calls → LiveGate skill calls
      └── Returns Lyzr-compatible responses
```

## Files

| File | Description |
|------|-------------|
| `lyzr-agent.json` | Lyzr Studio agent definition (exported via `npx gitagent export --format lyzr`) |
| `system-prompt.txt` | Full system prompt (exported via `npx gitagent export --format system-prompt`) |
| `lyzr-adapter.js` | Node.js adapter bridging Lyzr tool calls to LiveGate skills |
| `README.md` | This file |
