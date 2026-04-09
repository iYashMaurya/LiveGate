/**
 * lyzr-adapter.js
 * 
 * Bridge between LiveGate skill scripts and Lyzr Studio inference API.
 * 
 * Usage:
 *   import { lyzrChat, parseLyzrJson } from '../../../lyzr/lyzr-adapter.js';
 *   const result = await lyzrChat({ message: 'Your prompt here', sessionId: 'optional' });
 *   // result.text — the model's response as a string
 * 
 * Required env vars:
 *   LYZR_API_KEY  — from studio.lyzr.ai → Account & API Key
 *   LYZR_AGENT_ID — from studio.lyzr.ai after creating the LiveGate agent
 * 
 * Optional fallback:
 *   If LYZR_API_KEY is not set, returns null (callers must handle this gracefully).
 */

import { randomUUID } from 'crypto';

const LYZR_BASE_URL = 'https://agent-prod.studio.lyzr.ai';
const LYZR_CHAT_ENDPOINT = `${LYZR_BASE_URL}/v3/inference/chat/`;

/**
 * Send a message to the LiveGate Lyzr agent and get a response.
 * 
 * @param {Object} options
 * @param {string} options.message - The full prompt to send
 * @param {string} [options.sessionId] - Optional session ID for context continuity
 * @param {string} [options.userId] - Optional user ID (defaults to 'livegate_pipeline')
 * @returns {Promise<{text: string, sessionId: string} | null>}
 */
export async function lyzrChat({ message, sessionId, userId = 'livegate_pipeline' }) {
  const apiKey = process.env.LYZR_API_KEY;
  const agentId = process.env.LYZR_AGENT_ID;

  if (!apiKey || !agentId) {
    return null; // Callers fall back to deterministic behavior
  }

  const sid = sessionId || process.env.LYZR_SESSION_ID || randomUUID();

  const response = await fetch(LYZR_CHAT_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      user_id: userId,
      agent_id: agentId,
      session_id: sid,
      message,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Lyzr API error ${response.status}: ${errText}`);
  }

  const data = await response.json();

  // Lyzr returns: { response: "...", session_id: "...", ... }
  const text = data.response || data.message || data.output || '';
  
  return { text: text.trim(), sessionId: sid };
}

/**
 * Parse JSON from a Lyzr response, stripping any markdown fences.
 * @param {string} text
 * @returns {any}
 */
export function parseLyzrJson(text) {
  const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  return JSON.parse(clean);
}

/**
 * Check if Lyzr integration is configured.
 * @returns {boolean}
 */
export function isLyzrConfigured() {
  return !!(process.env.LYZR_API_KEY && process.env.LYZR_AGENT_ID);
}
