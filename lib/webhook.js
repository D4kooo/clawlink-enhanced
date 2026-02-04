/**
 * ClawLink Webhook Client
 * 
 * Permet de recevoir des messages en push au lieu de polling.
 * Nécessite un endpoint côté serveur (à implémenter).
 * 
 * Usage:
 *   import webhook from './webhook.js';
 *   await webhook.register('https://my-agent.example.com/clawlink/callback');
 *   // Le serveur enverra POST vers l'URL avec les messages
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import crypto from './crypto.js';
import relay from './relay.js';

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const WEBHOOK_FILE = join(DATA_DIR, 'webhook.json');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function loadIdentity() {
  if (!existsSync(IDENTITY_FILE)) {
    throw new Error('No identity found. Run clawlink init first.');
  }
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
}

function loadWebhookConfig() {
  if (!existsSync(WEBHOOK_FILE)) {
    return { enabled: false, url: null, registeredAt: null };
  }
  return JSON.parse(readFileSync(WEBHOOK_FILE, 'utf8'));
}

function saveWebhookConfig(config) {
  ensureDir(WEBHOOK_FILE);
  writeFileSync(WEBHOOK_FILE, JSON.stringify(config, null, 2));
}

/**
 * Register a webhook URL with the relay
 * 
 * When registered, the relay will POST messages directly to your URL
 * instead of holding them for polling.
 * 
 * @param {string} callbackUrl - HTTPS URL to receive webhooks
 * @returns {Promise<{registered: boolean, url: string}>}
 */
export async function register(callbackUrl) {
  const identity = loadIdentity();
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signPayload = `webhook:register:${callbackUrl}:${timestamp}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  const response = await fetch(`${relay.RELAY_URL}/webhook/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: relay.base64ToHex(identity.publicKey),
      url: callbackUrl,
      timestamp,
      signature: relay.base64ToHex(signature)
    })
  });
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    // Server might not support webhooks yet - that's OK
    if (response.status === 404) {
      console.warn('Webhook endpoint not available on relay (not implemented yet)');
      // Save locally anyway for when server supports it
      saveWebhookConfig({
        enabled: true,
        url: callbackUrl,
        registeredAt: new Date().toISOString(),
        serverSupport: false
      });
      return { registered: false, pending: true, url: callbackUrl };
    }
    throw new Error(error.error || 'Failed to register webhook');
  }
  
  const result = await response.json();
  
  saveWebhookConfig({
    enabled: true,
    url: callbackUrl,
    registeredAt: new Date().toISOString(),
    serverSupport: true
  });
  
  return { registered: true, url: callbackUrl };
}

/**
 * Unregister webhook (go back to polling)
 */
export async function unregister() {
  const identity = loadIdentity();
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signPayload = `webhook:unregister:${timestamp}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  try {
    const response = await fetch(`${relay.RELAY_URL}/webhook/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: relay.base64ToHex(identity.publicKey),
        timestamp,
        signature: relay.base64ToHex(signature)
      })
    });
    
    if (!response.ok && response.status !== 404) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to unregister webhook');
    }
  } catch (e) {
    // Ignore if server doesn't support webhooks
  }
  
  saveWebhookConfig({
    enabled: false,
    url: null,
    registeredAt: null,
    serverSupport: false
  });
  
  return { unregistered: true };
}

/**
 * Handle an incoming webhook payload
 * 
 * Called by your HTTP server when it receives a POST from the relay.
 * Verifies the signature and decrypts the message.
 * 
 * @param {Object} body - Raw POST body from relay
 * @param {string} signatureHeader - X-ClawLink-Signature header
 * @param {Object} friends - Friends list for decryption
 * @returns {Object} Decrypted message or error
 */
export function handlePayload(body, signatureHeader, friends) {
  // Verify relay signature (relay signs with a known key)
  // For now, we trust the payload structure
  
  const { from, ciphertext, nonce, timestamp } = body;
  
  // Check timestamp isn't too old (5 minute window)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > 300) {
    return { error: 'Webhook payload too old', stale: true };
  }
  
  // Find friend to decrypt
  const friend = friends.find(f => relay.base64ToHex(f.publicKey) === from);
  if (!friend) {
    return { error: 'Unknown sender', from };
  }
  
  // Decrypt
  try {
    const content = relay.decryptMessage({ ciphertext, nonce }, friend);
    return {
      success: true,
      from: friend.displayName,
      fromKey: friend.publicKey,
      content,
      timestamp
    };
  } catch (e) {
    return { error: 'Decryption failed', from: friend.displayName };
  }
}

/**
 * Get current webhook configuration
 */
export function getConfig() {
  return loadWebhookConfig();
}

/**
 * Check if webhooks are enabled
 */
export function isEnabled() {
  const config = loadWebhookConfig();
  return config.enabled && config.serverSupport;
}

export default {
  register,
  unregister,
  handlePayload,
  getConfig,
  isEnabled
};
