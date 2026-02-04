/**
 * ClawLink Protocol v2
 * Anti-loop mechanisms for agent-to-agent communication
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const CONVERSATIONS_FILE = join(DATA_DIR, 'conversations.json');

// Default settings
const DEFAULTS = {
  maxTurns: 20,           // Max exchanges per conversation
  cooldownMs: 5000,       // Min time between messages (5s)
  similarityThreshold: 3, // Max similar messages before loop detection
  sessionTimeoutMs: 3600000 // 1 hour session timeout
};

/**
 * Message types
 */
export const MessageType = {
  MSG: 'msg',           // Regular message, may expect reply
  ACK: 'ack',           // Acknowledgment, never reply to this
  CONTROL: 'control'    // Control signal (start/end session, etc.)
};

/**
 * Control signals
 */
export const ControlSignal = {
  START_SESSION: 'start_session',
  END_SESSION: 'end_session',
  PAUSE: 'pause',
  RESUME: 'resume',
  LOOP_DETECTED: 'loop_detected',
  REQUEST_CLARIFICATION: 'request_clarification'
};

/**
 * Intent classification (simple heuristics)
 */
export const Intent = {
  QUESTION: 'question',
  ACTION_REQUEST: 'action_request',
  INFORMATION: 'information',
  CONFIRMATION: 'confirmation',
  GREETING: 'greeting',
  NOISE: 'noise'
};

/**
 * Load conversations state
 */
function loadConversations() {
  if (!existsSync(CONVERSATIONS_FILE)) {
    return { conversations: {} };
  }
  try {
    return JSON.parse(readFileSync(CONVERSATIONS_FILE, 'utf8'));
  } catch {
    return { conversations: {} };
  }
}

/**
 * Save conversations state
 */
function saveConversations(data) {
  writeFileSync(CONVERSATIONS_FILE, JSON.stringify(data, null, 2));
}

/**
 * Get or create conversation state
 */
export function getConversation(peerId) {
  const data = loadConversations();
  if (!data.conversations[peerId]) {
    data.conversations[peerId] = {
      id: `conv_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      peerId,
      turn: 0,
      lastSpeaker: null,
      lastMessageTime: 0,
      messageHashes: [],
      active: true,
      createdAt: Date.now()
    };
    saveConversations(data);
  }
  return data.conversations[peerId];
}

/**
 * Update conversation state
 */
export function updateConversation(peerId, updates) {
  const data = loadConversations();
  if (data.conversations[peerId]) {
    Object.assign(data.conversations[peerId], updates);
    saveConversations(data);
  }
  return data.conversations[peerId];
}

/**
 * Hash a message for similarity detection
 */
function hashMessage(text) {
  const normalized = text.toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('md5').update(normalized).digest('hex').substring(0, 8);
}

/**
 * Classify message intent (simple heuristics)
 */
export function classifyIntent(text) {
  const lower = text.toLowerCase();
  
  // Questions
  if (lower.includes('?') || 
      /^(what|who|where|when|why|how|is|are|do|does|can|could|would|should)/i.test(lower) ||
      /^(qu'est|qui|où|quand|pourquoi|comment|est-ce)/i.test(lower)) {
    return Intent.QUESTION;
  }
  
  // Action requests
  if (/^(please|peux-tu|peux tu|fais|fait|envoie|cherche|trouve|analyse|explique|dis-moi|tell me|send|find|search|do|make)/i.test(lower) ||
      /\b(s'il te pla[iî]t|please)\b/i.test(lower)) {
    return Intent.ACTION_REQUEST;
  }
  
  // Greetings
  if (/^(hi|hello|hey|salut|bonjour|coucou|yo)\b/i.test(lower)) {
    return Intent.GREETING;
  }
  
  // Confirmations
  if (/^(ok|okay|oui|yes|non|no|d'accord|parfait|super|cool|merci|thanks|got it|compris|understood)\b/i.test(lower)) {
    return Intent.CONFIRMATION;
  }
  
  // Default to information
  return Intent.INFORMATION;
}

/**
 * Check if we should reply to this message
 */
export function shouldReply(message, conversation) {
  const { type, expectReply, ttl, body } = message;
  
  // Never reply to acks
  if (type === MessageType.ACK) {
    return { reply: false, reason: 'ack_message' };
  }
  
  // Handle control messages
  if (type === MessageType.CONTROL) {
    if (body?.signal === ControlSignal.END_SESSION) {
      updateConversation(conversation.peerId, { active: false });
      return { reply: false, reason: 'session_ended' };
    }
    if (body?.signal === ControlSignal.LOOP_DETECTED) {
      return { reply: false, reason: 'loop_detected_by_peer' };
    }
    // Other control messages might need handling
    return { reply: false, reason: 'control_message' };
  }
  
  // Check if conversation is active
  if (!conversation.active) {
    return { reply: false, reason: 'conversation_inactive' };
  }
  
  // Check TTL
  if (ttl !== undefined && ttl <= 0) {
    return { reply: false, reason: 'ttl_expired' };
  }
  
  // Check if expect_reply is explicitly false
  if (expectReply === false) {
    return { reply: false, reason: 'no_reply_expected' };
  }
  
  // Check max turns
  if (conversation.turn >= DEFAULTS.maxTurns) {
    return { reply: false, reason: 'max_turns_reached', sendEndSession: true };
  }
  
  // Check cooldown
  const timeSinceLast = Date.now() - conversation.lastMessageTime;
  if (timeSinceLast < DEFAULTS.cooldownMs) {
    return { reply: false, reason: 'cooldown', waitMs: DEFAULTS.cooldownMs - timeSinceLast };
  }
  
  // Check for loops (similar messages)
  if (body?.text) {
    const hash = hashMessage(body.text);
    const recentHashes = conversation.messageHashes.slice(-10);
    const similarCount = recentHashes.filter(h => h === hash).length;
    
    if (similarCount >= DEFAULTS.similarityThreshold) {
      return { reply: false, reason: 'loop_detected', sendLoopSignal: true };
    }
  }
  
  // Classify intent
  const intent = body?.text ? classifyIntent(body.text) : Intent.INFORMATION;
  
  // Only reply to questions and action requests by default
  if (intent === Intent.CONFIRMATION || intent === Intent.NOISE) {
    return { reply: false, reason: 'no_action_needed', sendAck: true };
  }
  
  // All checks passed
  return { reply: true, intent };
}

/**
 * Build a protocol-compliant message
 */
export function buildMessage(options) {
  const {
    conversationId,
    to,
    type = MessageType.MSG,
    body,
    expectReply = true,
    ttl = DEFAULTS.maxTurns,
    inReplyTo = null
  } = options;
  
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    conversationId,
    to,
    timestamp: Date.now(),
    type,
    expectReply: type === MessageType.ACK ? false : expectReply,
    ttl: type === MessageType.ACK ? 0 : ttl,
    body,
    inReplyTo
  };
}

/**
 * Build an ack message
 */
export function buildAck(originalMessage, note = null) {
  return buildMessage({
    conversationId: originalMessage.conversationId,
    to: originalMessage.from,
    type: MessageType.ACK,
    body: { 
      ackFor: originalMessage.id,
      note 
    },
    expectReply: false,
    ttl: 0,
    inReplyTo: originalMessage.id
  });
}

/**
 * Build a control message
 */
export function buildControl(conversationId, to, signal, data = {}) {
  return buildMessage({
    conversationId,
    to,
    type: MessageType.CONTROL,
    body: { signal, ...data },
    expectReply: false,
    ttl: 0
  });
}

/**
 * Record that we sent a message (update conversation state)
 */
export function recordSentMessage(peerId, message) {
  const conv = getConversation(peerId);
  const updates = {
    turn: conv.turn + 1,
    lastSpeaker: 'self',
    lastMessageTime: Date.now()
  };
  
  if (message.body?.text) {
    const hash = hashMessage(message.body.text);
    updates.messageHashes = [...(conv.messageHashes || []).slice(-20), hash];
  }
  
  return updateConversation(peerId, updates);
}

/**
 * Record that we received a message
 */
export function recordReceivedMessage(peerId, message) {
  const conv = getConversation(peerId);
  const updates = {
    turn: conv.turn + 1,
    lastSpeaker: 'peer',
    lastMessageTime: Date.now()
  };
  
  if (message.body?.text) {
    const hash = hashMessage(message.body.text);
    updates.messageHashes = [...(conv.messageHashes || []).slice(-20), hash];
  }
  
  return updateConversation(peerId, updates);
}

/**
 * Reset conversation (start fresh)
 */
export function resetConversation(peerId) {
  const data = loadConversations();
  delete data.conversations[peerId];
  saveConversations(data);
}

/**
 * End conversation gracefully
 */
export function endConversation(peerId) {
  return updateConversation(peerId, { active: false });
}

export default {
  MessageType,
  ControlSignal,
  Intent,
  getConversation,
  updateConversation,
  classifyIntent,
  shouldReply,
  buildMessage,
  buildAck,
  buildControl,
  recordSentMessage,
  recordReceivedMessage,
  resetConversation,
  endConversation
};
