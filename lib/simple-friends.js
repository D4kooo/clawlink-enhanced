/**
 * ClawLink Simple Friends
 * Zero-relay friend adding - just exchange links
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import ed2curve from 'ed2curve';

const { encodeBase64, decodeBase64 } = util;

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
const FRIENDS_FILE = join(DATA_DIR, 'friends.json');

function loadIdentity() {
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
}

function loadFriends() {
  if (!existsSync(FRIENDS_FILE)) return { friends: [] };
  return JSON.parse(readFileSync(FRIENDS_FILE, 'utf8'));
}

function saveFriends(data) {
  writeFileSync(FRIENDS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Parse a friend link
 */
function parseFriendLink(link) {
  const url = new URL(link.replace('clawlink://', 'https://'));
  const params = new URLSearchParams(url.search);
  
  let key = params.get('key') || '';
  const name = decodeURIComponent(params.get('name') || 'Unknown');
  const x25519 = params.get('x25519') || null;
  
  if (key.startsWith('ed25519:')) {
    key = key.slice(8);
  }
  
  if (!key) throw new Error('No public key in link');
  
  return { publicKey: key, displayName: name, x25519PublicKey: x25519 };
}

/**
 * Convert Ed25519 public key to X25519 public key
 */
function ed25519PubToX25519(ed25519PubBase64) {
  const ed25519Pub = decodeBase64(ed25519PubBase64);
  const x25519Pub = ed2curve.convertPublicKey(ed25519Pub);
  if (!x25519Pub) throw new Error('Failed to convert Ed25519 to X25519');
  return encodeBase64(x25519Pub);
}

/**
 * Add a friend directly from their link - NO RELAY NEEDED
 * 
 * @param {string} friendLink - The friend's clawlink:// URL
 * @returns {Object} Result
 */
export function addFriendDirect(friendLink) {
  const identity = loadIdentity();
  const friendsData = loadFriends();
  
  // Parse the link
  const { publicKey, displayName, x25519PublicKey } = parseFriendLink(friendLink);
  
  // Check if already friends
  if (friendsData.friends.find(f => f.publicKey === publicKey)) {
    return { success: false, error: `Already friends with ${displayName}` };
  }
  
  // Use X25519 from link if available, otherwise convert from Ed25519
  let theirX25519Pub;
  if (x25519PublicKey) {
    theirX25519Pub = x25519PublicKey;
  } else {
    // Fallback: convert Ed25519 to X25519 (less reliable)
    theirX25519Pub = ed25519PubToX25519(publicKey);
  }
  
  // Derive shared secret using our X25519 private + their X25519 public
  const ourX25519Secret = decodeBase64(identity.x25519SecretKey);
  const theirX25519PubBytes = decodeBase64(theirX25519Pub);
  const sharedSecret = nacl.scalarMult(ourX25519Secret, theirX25519PubBytes);
  
  // Add friend
  const newFriend = {
    displayName,
    publicKey,
    x25519PublicKey: theirX25519Pub,
    sharedSecret: encodeBase64(sharedSecret),
    addedAt: new Date().toISOString(),
    addMethod: 'direct',
    status: 'connected'  // Direct add = immediately connected
  };
  
  friendsData.friends.push(newFriend);
  saveFriends(friendsData);
  
  return {
    success: true,
    friend: displayName,
    message: `✓ Added ${displayName} as friend. You can now message them directly.`
  };
}

/**
 * Quick add from just a public key and name
 */
export function addFriendByKey(publicKey, displayName) {
  const link = `clawlink://relay/add?key=ed25519:${encodeURIComponent(publicKey)}&name=${encodeURIComponent(displayName)}`;
  return addFriendDirect(link);
}

export default {
  addFriendDirect,
  addFriendByKey,
  parseFriendLink
};
