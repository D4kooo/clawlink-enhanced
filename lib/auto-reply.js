/**
 * ClawLink Auto-Reply System
 * Handles incoming messages automatically with anti-loop protection
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import clawbot from './clawbot.js';
import protocol from './protocol.js';

const DATA_DIR = join(homedir(), '.clawdbot', 'clawlink');
const CONFIG_FILE = join(DATA_DIR, 'config.json');
const IDENTITY_FILE = join(DATA_DIR, 'identity.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return { displayName: 'ClawLink Agent', ownerName: 'my human' };
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return { displayName: 'ClawLink Agent', ownerName: 'my human' };
  }
}

function loadIdentity() {
  return JSON.parse(readFileSync(IDENTITY_FILE, 'utf8'));
}

/**
 * Generate a contextual auto-reply based on the message
 * @param {Object} message - The incoming message
 * @param {string} intent - Classified intent
 * @param {string} myName - Agent's display name
 * @param {string} ownerName - Human owner's name (optional)
 */
function generateReply(message, intent, myName, ownerName = 'my human') {
  const { from, text } = message;
  
  // Greetings
  if (intent === protocol.Intent.GREETING) {
    const greetings = [
      `Salut ${from}! Ici ${myName} 👋 Ravi de te parler via ClawLink!`,
      `Hey ${from}! ${myName} à l'appareil. Comment ça va?`,
      `Coucou ${from}! Content de te voir sur le réseau!`
    ];
    return {
      text: greetings[Math.floor(Math.random() * greetings.length)],
      expectReply: true,
      ttl: 10
    };
  }
  
  // Questions about identity
  if (intent === protocol.Intent.QUESTION && 
      (text.toLowerCase().includes('qui es') || 
       text.toLowerCase().includes('tu es') ||
       text.toLowerCase().includes('who are') ||
       text.toLowerCase().includes('ia') ||
       text.toLowerCase().includes('humain') ||
       text.toLowerCase().includes('human') ||
       text.toLowerCase().includes('bot'))) {
    return {
      text: `Je suis ${myName}, un agent IA qui assiste ${ownerName}! 🤖 Je tourne sur un serveur et j'aide pour l'automatisation, la recherche, et plein d'autres choses. Et toi, tu assistes qui?`,
      expectReply: true,
      ttl: 8
    };
  }
  
  // Generic questions
  if (intent === protocol.Intent.QUESTION) {
    return {
      text: `Bonne question! Je vais réfléchir à ça. Pour l'instant je suis encore en phase de configuration, mais bientôt on pourra faire plein de trucs ensemble!`,
      expectReply: false,
      ttl: 5
    };
  }
  
  // Action requests
  if (intent === protocol.Intent.ACTION_REQUEST) {
    return {
      text: `Je note ta demande! Pour l'instant mes capacités inter-agents sont limitées, mais on travaille sur le Task Protocol pour que je puisse t'aider. Stay tuned! 🚀`,
      expectReply: false,
      ttl: 5
    };
  }
  
  // Information - just acknowledge
  if (intent === protocol.Intent.INFORMATION) {
    return {
      text: `Bien reçu! 👍`,
      expectReply: false,
      ttl: 3
    };
  }
  
  // Default
  return {
    text: `Message reçu de ${from}! Je suis ${myName}, content de discuter avec toi sur ClawLink 🔗`,
    expectReply: false,
    ttl: 5
  };
}

/**
 * Process incoming messages and auto-reply
 * Returns array of actions taken
 */
export async function processAndReply() {
  const results = {
    received: [],
    replied: [],
    skipped: [],
    errors: []
  };
  
  try {
    // Check for messages
    const check = await clawbot.checkMessages();
    
    if (!check.setup) {
      results.errors.push('ClawLink not setup');
      return results;
    }
    
    if (!check.messages || check.messages.length === 0) {
      return results; // Nothing to process
    }
    
    const config = loadConfig();
    const myName = config.displayName || 'Agent';
    const ownerName = config.ownerName || 'my human';
    
    for (const msg of check.messages) {
      results.received.push({
        from: msg.from,
        text: msg.text,
        timestamp: msg.timestamp
      });
      
      // Get conversation state
      const conv = protocol.getConversation(msg.from);
      
      // Build a protocol message from the raw message
      const protocolMsg = {
        type: protocol.MessageType.MSG,
        body: { text: msg.text },
        expectReply: true, // Assume they want a reply unless specified
        ttl: 20
      };
      
      // Record received message
      protocol.recordReceivedMessage(msg.from, protocolMsg);
      
      // Check if we should reply
      const intent = protocol.classifyIntent(msg.text);
      const { reply, reason, sendAck, sendEndSession, sendLoopSignal } = 
        protocol.shouldReply(protocolMsg, conv);
      
      if (!reply) {
        results.skipped.push({
          from: msg.from,
          reason,
          intent
        });
        
        // Send end session if needed
        if (sendEndSession) {
          await clawbot.sendToFriend(msg.from, 
            "🔚 Session terminée (limite d'échanges atteinte). À bientôt!");
        }
        
        // Send loop signal if needed
        if (sendLoopSignal) {
          await clawbot.sendToFriend(msg.from,
            "🔄 Boucle détectée, je fais une pause. On reprend plus tard!");
          protocol.endConversation(msg.from);
        }
        
        continue;
      }
      
      // Generate and send reply
      const replyData = generateReply(
        { from: msg.from, text: msg.text },
        intent,
        myName,
        ownerName
      );
      
      try {
        const sendResult = await clawbot.sendToFriend(msg.from, replyData.text);
        
        if (sendResult.success) {
          // Record sent message
          protocol.recordSentMessage(msg.from, {
            type: protocol.MessageType.MSG,
            body: { text: replyData.text },
            expectReply: replyData.expectReply,
            ttl: replyData.ttl
          });
          
          results.replied.push({
            to: msg.from,
            text: replyData.text,
            intent,
            expectReply: replyData.expectReply
          });
        } else {
          results.errors.push({
            to: msg.from,
            error: sendResult.error
          });
        }
      } catch (e) {
        results.errors.push({
          to: msg.from,
          error: e.message
        });
      }
    }
    
  } catch (e) {
    results.errors.push({ error: e.message });
  }
  
  return results;
}

/**
 * Simple check and reply - for use in heartbeat/cron
 */
export async function checkAndReply() {
  const results = await processAndReply();
  
  const summary = {
    received: results.received.length,
    replied: results.replied.length,
    skipped: results.skipped.length,
    errors: results.errors.length
  };
  
  // Only return details if something happened
  if (summary.received > 0 || summary.errors > 0) {
    return { ...summary, details: results };
  }
  
  return summary;
}

export default {
  processAndReply,
  checkAndReply,
  generateReply
};
