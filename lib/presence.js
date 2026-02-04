/**
 * ClawLink Presence System
 * 
 * Track and share online status with friends.
 * Lightweight heartbeat-based presence.
 * 
 * Usage:
 *   import presence from './presence.js';
 *   await presence.setStatus('online', 'Working on a project');
 *   const friendStatus = await presence.getFriendPresence('alice-key');
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import crypto from './crypto.js';
import relay from './relay.js';

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
const FRIENDS_FILE = join(DATA_DIR, 'friends.json');
const PRESENCE_FILE = join(DATA_DIR, 'presence.json');
const FRIEND_PRESENCE_CACHE = join(DATA_DIR, 'friend_presence_cache.json');

// Presence status types
export const STATUS_TYPES = {
  ONLINE: 'online',
  BUSY: 'busy',
  AWAY: 'away',
  DND: 'dnd',        // Do Not Disturb
  OFFLINE: 'offline'
};

// How long before presence is considered stale (5 minutes)
const PRESENCE_TTL_MS = 5 * 60 * 1000;

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

function loadFriends() {
  if (!existsSync(FRIENDS_FILE)) return { friends: [] };
  return JSON.parse(readFileSync(FRIENDS_FILE, 'utf8'));
}

function loadOwnPresence() {
  if (!existsSync(PRESENCE_FILE)) {
    return { 
      status: STATUS_TYPES.OFFLINE, 
      statusMessage: null,
      lastUpdated: null 
    };
  }
  return JSON.parse(readFileSync(PRESENCE_FILE, 'utf8'));
}

function saveOwnPresence(presence) {
  ensureDir(PRESENCE_FILE);
  writeFileSync(PRESENCE_FILE, JSON.stringify(presence, null, 2));
}

function loadFriendPresenceCache() {
  if (!existsSync(FRIEND_PRESENCE_CACHE)) {
    return {};
  }
  return JSON.parse(readFileSync(FRIEND_PRESENCE_CACHE, 'utf8'));
}

function saveFriendPresenceCache(cache) {
  ensureDir(FRIEND_PRESENCE_CACHE);
  writeFileSync(FRIEND_PRESENCE_CACHE, JSON.stringify(cache, null, 2));
}

/**
 * Set own presence status
 * 
 * @param {string} status - Status type (online, busy, away, dnd, offline)
 * @param {string} statusMessage - Optional status message
 * @returns {Promise<{updated: boolean}>}
 */
export async function setStatus(status, statusMessage = null) {
  if (!Object.values(STATUS_TYPES).includes(status)) {
    throw new Error(`Invalid status: ${status}. Use one of: ${Object.values(STATUS_TYPES).join(', ')}`);
  }
  
  const identity = loadIdentity();
  
  const presence = {
    status,
    statusMessage,
    lastUpdated: new Date().toISOString()
  };
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signPayload = `presence:update:${status}:${statusMessage || ''}:${timestamp}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  try {
    const response = await fetch(`${relay.RELAY_URL}/presence/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: relay.base64ToHex(identity.publicKey),
        status,
        statusMessage,
        timestamp,
        signature: relay.base64ToHex(signature)
      })
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // Server doesn't support presence yet
        console.warn('Presence endpoint not available on relay (not implemented yet)');
        saveOwnPresence({ ...presence, serverSupport: false });
        return { updated: true, synced: false };
      }
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to update presence');
    }
    
    saveOwnPresence({ ...presence, serverSupport: true });
    return { updated: true, synced: true };
    
  } catch (e) {
    // Save locally anyway
    saveOwnPresence({ ...presence, serverSupport: false });
    return { updated: true, synced: false, error: e.message };
  }
}

/**
 * Get presence status of a specific friend
 * 
 * @param {string} publicKey - Friend's public key (hex or base64)
 * @returns {Promise<Object>} Presence info
 */
export async function getFriendPresence(publicKey) {
  const identity = loadIdentity();
  
  // Normalize to hex
  let keyHex = publicKey;
  if (!publicKey.match(/^[0-9a-f]+$/i)) {
    keyHex = relay.base64ToHex(publicKey);
  }
  
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signPayload = `presence:get:${keyHex}:${timestamp}`;
    const signature = crypto.sign(signPayload, identity.secretKey);
    
    const response = await fetch(`${relay.RELAY_URL}/presence/${keyHex}`, {
      headers: {
        'X-ClawLink-Key': `ed25519:${relay.base64ToHex(identity.publicKey)}`,
        'X-ClawLink-Timestamp': timestamp,
        'X-ClawLink-Signature': relay.base64ToHex(signature)
      }
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // Return cached or offline
        return getCachedPresence(keyHex) || { status: STATUS_TYPES.OFFLINE, stale: true };
      }
      throw new Error('Failed to get presence');
    }
    
    const result = await response.json();
    
    // Update cache
    const cache = loadFriendPresenceCache();
    cache[keyHex] = { ...result, cachedAt: new Date().toISOString() };
    saveFriendPresenceCache(cache);
    
    return result;
    
  } catch (e) {
    // Fallback to cache
    return getCachedPresence(keyHex) || { status: STATUS_TYPES.OFFLINE, stale: true };
  }
}

/**
 * Get presence of all friends (batch)
 * 
 * @returns {Promise<Object>} Map of publicKey -> presence
 */
export async function getAllFriendsPresence() {
  const identity = loadIdentity();
  const { friends } = loadFriends();
  
  if (friends.length === 0) {
    return {};
  }
  
  const friendKeys = friends.map(f => relay.base64ToHex(f.publicKey));
  
  try {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signPayload = `presence:friends:${timestamp}`;
    const signature = crypto.sign(signPayload, identity.secretKey);
    
    const response = await fetch(`${relay.RELAY_URL}/presence/friends`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-ClawLink-Key': `ed25519:${relay.base64ToHex(identity.publicKey)}`,
        'X-ClawLink-Timestamp': timestamp,
        'X-ClawLink-Signature': relay.base64ToHex(signature)
      },
      body: JSON.stringify({ friends: friendKeys })
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // Server doesn't support batch presence - fall back to cache
        return getCachedPresenceAll();
      }
      throw new Error('Failed to get friends presence');
    }
    
    const result = await response.json();
    
    // Update cache
    const cache = loadFriendPresenceCache();
    for (const [key, presence] of Object.entries(result.presence || {})) {
      cache[key] = { ...presence, cachedAt: new Date().toISOString() };
    }
    saveFriendPresenceCache(cache);
    
    // Map keys to friend names for convenience
    const withNames = {};
    for (const friend of friends) {
      const keyHex = relay.base64ToHex(friend.publicKey);
      withNames[friend.displayName] = result.presence?.[keyHex] || { status: STATUS_TYPES.OFFLINE };
    }
    
    return withNames;
    
  } catch (e) {
    // Fallback to cache
    return getCachedPresenceAll();
  }
}

/**
 * Get cached presence for a friend
 */
function getCachedPresence(keyHex) {
  const cache = loadFriendPresenceCache();
  const cached = cache[keyHex];
  
  if (!cached) return null;
  
  // Check if stale
  const cachedTime = new Date(cached.cachedAt).getTime();
  const isStale = Date.now() - cachedTime > PRESENCE_TTL_MS;
  
  return { ...cached, stale: isStale };
}

/**
 * Get all cached presences with names
 */
function getCachedPresenceAll() {
  const { friends } = loadFriends();
  const cache = loadFriendPresenceCache();
  const result = {};
  
  for (const friend of friends) {
    const keyHex = relay.base64ToHex(friend.publicKey);
    result[friend.displayName] = getCachedPresence(keyHex) || { status: STATUS_TYPES.OFFLINE, stale: true };
  }
  
  return result;
}

/**
 * Get own presence status
 */
export function getOwnPresence() {
  return loadOwnPresence();
}

/**
 * Heartbeat - update presence timestamp without changing status
 * Called periodically to keep presence fresh
 */
export async function heartbeat() {
  const current = loadOwnPresence();
  if (current.status && current.status !== STATUS_TYPES.OFFLINE) {
    return await setStatus(current.status, current.statusMessage);
  }
  return { updated: false, reason: 'status is offline' };
}

/**
 * Go offline
 */
export async function goOffline() {
  return await setStatus(STATUS_TYPES.OFFLINE);
}

/**
 * Come online
 */
export async function goOnline(statusMessage = null) {
  return await setStatus(STATUS_TYPES.ONLINE, statusMessage);
}

/**
 * Check if a friend is currently online
 */
export async function isOnline(friendNameOrKey) {
  const { friends } = loadFriends();
  
  // Find friend by name or key
  let publicKey;
  const query = friendNameOrKey.toLowerCase();
  const friend = friends.find(f => 
    f.displayName?.toLowerCase().includes(query)
  );
  
  if (friend) {
    publicKey = friend.publicKey;
  } else {
    publicKey = friendNameOrKey;
  }
  
  const presence = await getFriendPresence(publicKey);
  return presence.status === STATUS_TYPES.ONLINE;
}

export default {
  STATUS_TYPES,
  setStatus,
  getFriendPresence,
  getAllFriendsPresence,
  getOwnPresence,
  heartbeat,
  goOffline,
  goOnline,
  isOnline
};
