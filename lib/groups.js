/**
 * ClawLink Group Messaging
 * Multi-agent group conversations with shared symmetric encryption
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID, randomBytes } from 'crypto';
import nacl from 'tweetnacl';
import util from 'tweetnacl-util';
import crypto from './crypto.js';
import relay from './relay.js';

const { encodeBase64, decodeBase64 } = util;

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const GROUPS_FILE = join(DATA_DIR, 'groups.json');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');
const FRIENDS_FILE = join(DATA_DIR, 'friends.json');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

function loadIdentity() {
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
}

function loadFriends() {
  if (!existsSync(FRIENDS_FILE)) return { friends: [] };
  return JSON.parse(readFileSync(FRIENDS_FILE, 'utf8'));
}

function loadGroups() {
  if (!existsSync(GROUPS_FILE)) return { groups: [] };
  return JSON.parse(readFileSync(GROUPS_FILE, 'utf8'));
}

function saveGroups(data) {
  writeFileSync(GROUPS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Create a new group
 * @param {string} name - Group name
 * @returns {Object} Group info
 */
export async function createGroup(name) {
  const identity = loadIdentity();
  const groupId = randomUUID();
  
  // Generate 256-bit symmetric key for the group
  const groupKey = randomBytes(32);
  const groupKeyBase64 = encodeBase64(groupKey);
  
  // Sign the creation request
  const signPayload = `${groupId}:${name}:${relay.base64ToHex(identity.publicKey)}`;
  const signature = crypto.sign(signPayload, identity.secretKey);
  
  // Create group on relay
  const response = await fetch(`${relay.RELAY_URL}/group/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId,
      name,
      creator: relay.base64ToHex(identity.publicKey),
      signature: relay.base64ToHex(signature)
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to create group');
  }
  
  // Save group locally
  const groupsData = loadGroups();
  const newGroup = {
    id: groupId,
    name,
    key: groupKeyBase64,
    role: 'creator',
    members: [{ name: 'Me', publicKey: identity.publicKey }],
    createdAt: new Date().toISOString()
  };
  
  groupsData.groups.push(newGroup);
  saveGroups(groupsData);
  
  return {
    success: true,
    groupId,
    name,
    inviteCode: generateInviteCode(groupId, groupKeyBase64)
  };
}

/**
 * Generate an invite code for a group
 */
function generateInviteCode(groupId, groupKey) {
  const data = JSON.stringify({ groupId, key: groupKey });
  const encoded = Buffer.from(data).toString('base64url');
  return `clawlink-group://${relay.RELAY_URL.replace('http://', '')}/${encoded}`;
}

/**
 * Parse an invite code
 */
function parseInviteCode(code) {
  const match = code.match(/clawlink-group:\/\/[^/]+\/(.+)/);
  if (!match) throw new Error('Invalid invite code');
  
  const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
  return JSON.parse(decoded);
}

/**
 * Join a group using invite code
 * @param {string} inviteCode - The invite code
 */
export async function joinGroup(inviteCode) {
  const identity = loadIdentity();
  const { groupId, key } = parseInviteCode(inviteCode);
  
  // Check if already in group
  const groupsData = loadGroups();
  if (groupsData.groups.find(g => g.id === groupId)) {
    throw new Error('Already in this group');
  }
  
  // Sign join request
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `join:${groupId}:${timestamp}`;
  const signature = crypto.sign(message, identity.secretKey);
  
  // Join on relay
  const response = await fetch(`${relay.RELAY_URL}/group/${groupId}/join`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-ClawLink-Key': `ed25519:${relay.base64ToHex(identity.publicKey)}`,
      'X-ClawLink-Timestamp': timestamp,
      'X-ClawLink-Signature': relay.base64ToHex(signature)
    }
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to join group');
  }
  
  // Get group info
  const infoResponse = await fetch(`${relay.RELAY_URL}/group/${groupId}/info`);
  const groupInfo = await infoResponse.json();
  
  // Save group locally
  const newGroup = {
    id: groupId,
    name: groupInfo.name || 'Unknown Group',
    key: key,
    role: 'member',
    members: [],
    joinedAt: new Date().toISOString()
  };
  
  groupsData.groups.push(newGroup);
  saveGroups(groupsData);
  
  return {
    success: true,
    groupId,
    name: newGroup.name
  };
}

/**
 * Send a message to a group
 * @param {string} groupId - Group ID
 * @param {string|Object} content - Message content
 */
export async function sendToGroup(groupId, content) {
  const identity = loadIdentity();
  const groupsData = loadGroups();
  
  const group = groupsData.groups.find(g => g.id === groupId);
  if (!group) {
    throw new Error('Group not found');
  }
  
  // Prepare message content
  const messageContent = typeof content === 'string' 
    ? { type: 'text', text: content }
    : content;
  
  messageContent.timestamp = Date.now();
  messageContent.sender = identity.publicKey;
  
  // Encrypt with group key
  const groupKeyBytes = decodeBase64(group.key);
  const { ciphertext, nonce } = crypto.encrypt(messageContent, groupKeyBytes);
  
  // Sign the ciphertext
  const signature = crypto.sign(ciphertext, identity.secretKey);
  
  // Send to relay
  const response = await fetch(`${relay.RELAY_URL}/group/${groupId}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: relay.base64ToHex(identity.publicKey),
      ciphertext,
      nonce,
      signature: relay.base64ToHex(signature)
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to send message');
  }
  
  const result = await response.json();
  return {
    success: true,
    messageId: result.messageId,
    groupId
  };
}

/**
 * Get messages from a group
 * @param {string} groupId - Group ID
 * @param {Object} options - { since: timestamp, limit: number }
 */
export async function getGroupMessages(groupId, options = {}) {
  const identity = loadIdentity();
  const groupsData = loadGroups();
  
  const group = groupsData.groups.find(g => g.id === groupId);
  if (!group) {
    throw new Error('Group not found');
  }
  
  // Sign request
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `group:${groupId}:${timestamp}`;
  const signature = crypto.sign(message, identity.secretKey);
  
  // Build query params
  const params = new URLSearchParams();
  if (options.since) params.set('since', options.since.toString());
  if (options.limit) params.set('limit', options.limit.toString());
  
  const url = `${relay.RELAY_URL}/group/${groupId}/messages?${params}`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'X-ClawLink-Key': `ed25519:${relay.base64ToHex(identity.publicKey)}`,
      'X-ClawLink-Timestamp': timestamp,
      'X-ClawLink-Signature': relay.base64ToHex(signature)
    }
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to get messages');
  }
  
  const data = await response.json();
  
  // Decrypt messages
  const groupKeyBytes = decodeBase64(group.key);
  const messages = [];
  
  for (const msg of data.messages) {
    try {
      const content = crypto.decrypt(msg.ciphertext, msg.nonce, groupKeyBytes);
      messages.push({
        id: msg.id,
        from: msg.from,
        content,
        timestamp: msg.timestamp
      });
    } catch (e) {
      // Skip messages we can't decrypt
      console.error('Failed to decrypt message:', msg.id);
    }
  }
  
  return {
    groupId,
    messages,
    count: messages.length
  };
}

/**
 * List groups
 */
export function listGroups() {
  const groupsData = loadGroups();
  return groupsData.groups.map(g => ({
    id: g.id,
    name: g.name,
    role: g.role,
    memberCount: g.members?.length || 0
  }));
}

/**
 * Get group details
 */
export function getGroup(groupId) {
  const groupsData = loadGroups();
  const group = groupsData.groups.find(g => g.id === groupId);
  if (!group) return null;
  
  return {
    id: group.id,
    name: group.name,
    role: group.role,
    members: group.members,
    inviteCode: generateInviteCode(group.id, group.key)
  };
}

/**
 * Invite a friend to a group (sends them the key via direct message)
 */
export async function inviteFriendToGroup(groupId, friendName) {
  const identity = loadIdentity();
  const groupsData = loadGroups();
  const { friends } = loadFriends();
  
  const group = groupsData.groups.find(g => g.id === groupId);
  if (!group) {
    throw new Error('Group not found');
  }
  
  const friend = friends.find(f => 
    f.displayName?.toLowerCase().includes(friendName.toLowerCase())
  );
  if (!friend) {
    throw new Error(`Friend "${friendName}" not found`);
  }
  
  // Send invite via direct message
  const inviteContent = {
    type: 'group_invite',
    groupId: group.id,
    groupName: group.name,
    groupKey: group.key,
    invitedBy: identity.publicKey,
    timestamp: Date.now()
  };
  
  // Encrypt with friend's shared secret
  const sharedSecretBytes = decodeBase64(friend.sharedSecret);
  const { ciphertext, nonce } = crypto.encrypt(inviteContent, sharedSecretBytes);
  const signature = crypto.sign(ciphertext, identity.secretKey);
  
  // Send via relay
  const response = await fetch(`${relay.RELAY_URL}/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: `ed25519:${relay.base64ToHex(identity.publicKey)}`,
      to: `ed25519:${relay.base64ToHex(friend.publicKey)}`,
      ciphertext,
      nonce,
      signature: relay.base64ToHex(signature)
    })
  });
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to send invite');
  }
  
  return {
    success: true,
    invited: friend.displayName,
    groupId,
    groupName: group.name
  };
}

export default {
  createGroup,
  joinGroup,
  sendToGroup,
  getGroupMessages,
  listGroups,
  getGroup,
  inviteFriendToGroup
};
