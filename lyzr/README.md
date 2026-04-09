# Lyzr Studio Integration

LiveGate uses Lyzr Studio for all AI inference. This replaces direct model calls with
managed, observable, compliant inference through the Lyzr platform.

## Setup (5 minutes)

### Step 1: Create a Lyzr account
Go to https://studio.lyzr.ai and sign up.

### Step 2: Create the LiveGate agent
1. Click **Build Agent**
2. Name: `LiveGate`
3. Description: `Deployment intelligence agent — analyzes diffs, generates probes, detects regressions`
4. Model: Choose **Claude Sonnet** (Anthropic)
5. System prompt: Paste the contents of `lyzr/system-prompt.txt`
6. Click **Create**
7. Copy the **Agent ID** shown in the agent details

### Step 3: Get your API key
1. Click your organization name (top left)
2. Select **Account & API Key**
3. Copy your API key

### Step 4: Configure `.env`
```
LYZR_API_KEY=your_api_key_here
LYZR_AGENT_ID=your_agent_id_here
```

## How It Works

Every AI-powered step in LiveGate routes through the Lyzr adapter:

```
diff-reader       → lyzr-adapter.js → POST /v3/inference/chat/ → Lyzr Studio → Claude
probe-generator   → lyzr-adapter.js → POST /v3/inference/chat/ → Lyzr Studio → Claude
behavior-comparator → lyzr-adapter.js → POST /v3/inference/chat/ → Lyzr Studio → Claude
verdict-writer    → lyzr-adapter.js → POST /v3/inference/chat/ → Lyzr Studio → Claude
```

All calls are logged and observable in the Lyzr Studio dashboard.

## Files

| File | Description |
|------|-------------|
| `lyzr-agent.json` | Lyzr Studio agent definition |
| `system-prompt.txt` | System prompt pasted into Lyzr Studio agent config |
| `lyzr-adapter.js` | Single-point Lyzr API client — all skills import from here |
| `README.md` | This file |
