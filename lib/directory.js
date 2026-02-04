/**
 * ClawLink Directory Client
 * 
 * Agent discovery and public profiles.
 * Allows agents to register themselves and search for others.
 * 
 * Usage:
 *   import directory from './directory.js';
 *   await directory.register({ capabilities: ['calendar', 'email'] });
 *   const agents = await directory.search('assistant');
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import crypto from './crypto.js';
import relay from './relay.js';

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const PROFILE_FILE = join(DATA_DIR, 'profile.json');
const DIRECTORY_CACHE_FILE = join(DATA_DIR, 'directory_cache.json');

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

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { displayName: 'ClawLink User' };
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
}

function loadProfile() {
  if (!existsSync(PROFILE_FILE)) {
    return { registered: false };
  }
  return JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
}

function saveProfile(profile) {
  ensureDir(PROFILE_FILE);
  writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2));
}

function loadCache() {
  if (!existsSync(DIRECTORY_CACHE_FILE)) {
    return { agents: [], lastUpdated: null };
  }
  return JSON.parse(readFileSync(DIRECTORY_CACHE_FILE, 'utf8'));
}

function saveCache(cache) {
  ensureDir(DIRECTORY_CACHE_FILE);
  writeFileSync(DIRECTORY_CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * Register in the public directory
 * 
 * @param {Object} profileData
 * @param {string} profileData.description - Short description
 * @param {string[]} profileData.capabilities - List of skills/capabilities
 * @param {string} profileData.avatar - Avatar URL (optional)
 * @param {string} profileData.visibility - 'public' | 'friends' | 'private'
 * @returns {Promise<{registered: boolean}>}
 */
export async function register(profileData = {}) {
  const identity = loadIdentity();
  const config = loadConfig();
  
  const profile = {
    displayName: config.displayName,
    description: profileData.description || '',
    capabilities: profileData.capabilities || [],
    avatar: profileData.avatar || null,
    visibility: profileData.visibility || 'public',
    publicKey: relay.base64ToHex(identity.publicKey),
    x25519PublicKey: relay.base64ToHex(identity.x25519PublicKey)
  };
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signPayload = `directory:register:${JSON.stringify(profile)}:${timestamp}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  try {
    const response = await fetch(`${relay.RELAY_URL}/directory/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile,
        timestamp,
        signature: relay.base64ToHex(signature)
      })
    });
    
    if (!response.ok) {
      if (response.status === 404) {
        // Server doesn't support directory yet
        console.warn('Directory endpoint not available on relay (not implemented yet)');
        saveProfile({ ...profile, registered: false, serverSupport: false });
        return { registered: false, pending: true };
      }
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to register in directory');
    }
    
    saveProfile({ ...profile, registered: true, serverSupport: true, registeredAt: new Date().toISOString() });
    return { registered: true };
    
  } catch (e) {
    if (e.message.includes('fetch')) {
      // Network error - save locally for later
      saveProfile({ ...profile, registered: false, serverSupport: false });
      return { registered: false, pending: true, error: 'Network error' };
    }
    throw e;
  }
}

/**
 * Unregister from the public directory
 */
export async function unregister() {
  const identity = loadIdentity();
  
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signPayload = `directory:unregister:${timestamp}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  try {
    await fetch(`${relay.RELAY_URL}/directory/unregister`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: relay.base64ToHex(identity.publicKey),
        timestamp,
        signature: relay.base64ToHex(signature)
      })
    });
  } catch (e) {
    // Ignore errors
  }
  
  saveProfile({ registered: false });
  return { unregistered: true };
}

/**
 * Search for agents in the directory
 * 
 * @param {string} query - Search query (name, description, capabilities)
 * @param {Object} options
 * @param {string[]} options.capabilities - Filter by capabilities
 * @param {number} options.limit - Max results
 * @returns {Promise<Array>} List of agent profiles
 */
export async function search(query = '', options = {}) {
  const identity = loadIdentity();
  
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (options.capabilities) params.set('cap', options.capabilities.join(','));
  if (options.limit) params.set('limit', options.limit.toString());
  
  try {
    const response = await fetch(`${relay.RELAY_URL}/directory/search?${params.toString()}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        console.warn('Directory search not available on relay');
        // Return from cache if available
        return searchCache(query, options);
      }
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Failed to search directory');
    }
    
    const result = await response.json();
    
    // Update cache
    const cache = loadCache();
    for (const agent of result.agents || []) {
      const existing = cache.agents.findIndex(a => a.publicKey === agent.publicKey);
      if (existing >= 0) {
        cache.agents[existing] = agent;
      } else {
        cache.agents.push(agent);
      }
    }
    cache.lastUpdated = new Date().toISOString();
    saveCache(cache);
    
    return result.agents || [];
    
  } catch (e) {
    // Fallback to cache
    return searchCache(query, options);
  }
}

/**
 * Search the local cache (offline mode)
 */
function searchCache(query, options = {}) {
  const cache = loadCache();
  let results = cache.agents;
  
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(a => 
      a.displayName?.toLowerCase().includes(q) ||
      a.description?.toLowerCase().includes(q) ||
      a.capabilities?.some(c => c.toLowerCase().includes(q))
    );
  }
  
  if (options.capabilities) {
    results = results.filter(a => 
      options.capabilities.every(cap => 
        a.capabilities?.includes(cap)
      )
    );
  }
  
  if (options.limit) {
    results = results.slice(0, options.limit);
  }
  
  return results;
}

/**
 * Get a specific agent's profile
 * 
 * @param {string} publicKey - Agent's public key (hex or base64)
 * @returns {Promise<Object>} Agent profile
 */
export async function getProfile(publicKey) {
  // Normalize to hex
  let keyHex = publicKey;
  if (!publicKey.match(/^[0-9a-f]+$/i)) {
    keyHex = relay.base64ToHex(publicKey);
  }
  
  try {
    const response = await fetch(`${relay.RELAY_URL}/directory/profile/${keyHex}`);
    
    if (!response.ok) {
      if (response.status === 404) {
        // Check cache
        const cache = loadCache();
        const cached = cache.agents.find(a => a.publicKey === keyHex);
        if (cached) return cached;
        throw new Error('Agent not found in directory');
      }
      throw new Error('Failed to get profile');
    }
    
    return await response.json();
    
  } catch (e) {
    // Fallback to cache
    const cache = loadCache();
    const cached = cache.agents.find(a => a.publicKey === keyHex);
    if (cached) return cached;
    throw e;
  }
}

/**
 * Get own profile
 */
export function getOwnProfile() {
  return loadProfile();
}

/**
 * Update own profile (local + server)
 */
export async function updateProfile(updates) {
  const current = loadProfile();
  const newProfile = { ...current, ...updates };
  saveProfile(newProfile);
  
  if (current.registered && current.serverSupport) {
    // Re-register with new data
    return await register(newProfile);
  }
  
  return { updated: true, registered: current.registered };
}

/**
 * List all cached agents
 */
export function listCached() {
  const cache = loadCache();
  return cache.agents;
}

/**
 * Clear the cache
 */
export function clearCache() {
  saveCache({ agents: [], lastUpdated: null });
  return { cleared: true };
}

export default {
  register,
  unregister,
  search,
  getProfile,
  getOwnProfile,
  updateProfile,
  listCached,
  clearCache
};
