#!/usr/bin/env node
/**
 * ClawLink Handler
 * JSON API for Clawbot integration
 * 
 * Usage: node handler.js <action> [args...]
 * Output: JSON result
 */

import clawbot from './lib/clawbot.js';
import prefs from './lib/preferences.js';

// Optional modules (loaded dynamically to avoid errors if missing)
let tasks = { listTaskHandlers: () => [], sendTaskRequest: async () => ({ error: 'tasks not implemented' }), sendTaskResponse: async () => ({ error: 'tasks not implemented' }) };
let groups = { createGroup: async () => ({ error: 'groups not implemented' }), listGroups: () => [], sendToGroup: async () => ({ error: 'groups not implemented' }), getGroupMessages: async () => ({ error: 'groups not implemented' }), joinGroup: async () => ({ error: 'groups not implemented' }), getGroup: () => null, inviteFriendToGroup: async () => ({ error: 'groups not implemented' }) };
let simpleFriends = { addFriendDirect: () => ({ error: 'not implemented' }) };
let autoReply = { checkAndReply: async () => ({ error: 'not implemented' }), processAndReply: async () => ({ error: 'not implemented' }) };

try { tasks = (await import('./lib/tasks.js')).default; } catch (e) {}
try { groups = (await import('./lib/groups.js')).default; } catch (e) {}
try { simpleFriends = (await import('./lib/simple-friends.js')).default; } catch (e) {}
try { autoReply = (await import('./lib/auto-reply.js')).default; } catch (e) {}

const args = process.argv.slice(2);
const action = args[0];

// Parse --key=value or --key value flags
function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key.includes('=')) {
        const [k, v] = key.split('=');
        flags[k] = v;
      } else if (args[i + 1] && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    }
  }
  return flags;
}

async function main() {
  let result;
  const flags = parseFlags(args);

  switch (action) {
    // ========== AUTO MODE ==========
    case 'auto':
      // Automatic check and reply - for heartbeat/cron
      result = await autoReply.checkAndReply();
      break;

    case 'auto-full':
      // Full auto-reply with details
      result = await autoReply.processAndReply();
      break;

    // ========== CORE MESSAGING ==========
    case 'check':
      // Check for new messages and friend requests
      result = await clawbot.checkMessages();
      break;

    case 'send':
      // Send message: node handler.js send "Friend" "Message" [--urgent] [--context=work]
      if (args.length < 3) {
        result = { success: false, error: 'Usage: send <friend> <message> [--urgent] [--context=work|personal|social]' };
      } else {
        const options = {
          urgency: flags.urgent ? 'urgent' : (flags.fyi ? 'fyi' : 'normal'),
          context: flags.context || 'personal',
          respondBy: flags.respondBy || null
        };
        result = await clawbot.sendToFriend(args[1], args[2], options);
      }
      break;

    case 'add':
      // Add friend DIRECTLY from link - no relay, no accept needed
      if (!args[1]) {
        result = { success: false, error: 'Usage: add <friend-link>' };
      } else {
        result = simpleFriends.addFriendDirect(args[1]);
      }
      break;

    case 'accept':
      // Accept friend request (legacy)
      if (!args[1]) {
        result = { success: false, error: 'Usage: accept <friend-name>' };
      } else {
        result = await clawbot.acceptFriend(args[1]);
      }
      break;

    case 'link':
      // Get friend link
      result = clawbot.getFriendLink();
      break;

    case 'friends':
      // List friends
      result = clawbot.listFriends();
      break;

    case 'status':
      // Get status
      result = await clawbot.getStatus();
      break;

    // ========== PREFERENCES ==========
    case 'preferences':
    case 'prefs':
      if (!args[1]) {
        result = { preferences: prefs.loadPreferences() };
      } else if (args[1] === 'set' && args[2] && args[3]) {
        let value = args[3];
        try { value = JSON.parse(value); } catch {}
        prefs.updatePreference(args[2], value);
        result = { success: true, path: args[2], value };
      } else {
        result = { error: 'Usage: preferences [set <path> <value>]' };
      }
      break;

    case 'quiet-hours':
      if (args[1] === 'on') {
        prefs.updatePreference('schedule.quietHours.enabled', true);
        result = { success: true, quietHours: 'enabled' };
      } else if (args[1] === 'off') {
        prefs.updatePreference('schedule.quietHours.enabled', false);
        result = { success: true, quietHours: 'disabled' };
      } else if (args[1] && args[2]) {
        prefs.updatePreference('schedule.quietHours.enabled', true);
        prefs.updatePreference('schedule.quietHours.start', args[1]);
        prefs.updatePreference('schedule.quietHours.end', args[2]);
        result = { success: true, quietHours: { start: args[1], end: args[2] } };
      } else {
        const p = prefs.loadPreferences();
        result = { quietHours: p.schedule?.quietHours };
      }
      break;

    // ========== TASKS ==========
    case 'task':
      if (args[1] === 'send' && args[2] && args[3]) {
        const params = args[4] ? JSON.parse(args[4]) : {};
        result = await tasks.sendTaskRequest(args[2], args[3], params, {
          timeout: flags.timeout || 30000,
          urgent: flags.urgent
        });
      } else if (args[1] === 'respond' && args[2] && args[3] && args[4]) {
        const taskResult = args[5] ? JSON.parse(args[5]) : {};
        result = await tasks.sendTaskResponse(args[2], args[3], args[4], taskResult);
      } else if (args[1] === 'handlers') {
        result = { handlers: tasks.listTaskHandlers() };
      } else {
        result = {
          error: 'Task usage',
          usage: {
            send: 'task send <friend> <taskName> [params-json] [--timeout=30000] [--urgent]',
            respond: 'task respond <friend> <taskId> <success|error|rejected> [result-json]',
            handlers: 'task handlers'
          }
        };
      }
      break;

    // ========== GROUPS ==========
    case 'group':
      if (args[1] === 'create' && args[2]) {
        result = await groups.createGroup(args[2]);
      } else if (args[1] === 'join' && args[2]) {
        result = await groups.joinGroup(args[2]);
      } else if (args[1] === 'send' && args[2] && args[3]) {
        result = await groups.sendToGroup(args[2], args[3]);
      } else if (args[1] === 'messages' && args[2]) {
        const options = {
          since: flags.since ? parseInt(flags.since) : 0,
          limit: flags.limit ? parseInt(flags.limit) : 100
        };
        result = await groups.getGroupMessages(args[2], options);
      } else if (args[1] === 'invite' && args[2] && args[3]) {
        result = await groups.inviteFriendToGroup(args[2], args[3]);
      } else if (args[1] === 'info' && args[2]) {
        result = groups.getGroup(args[2]);
      } else if (args[1] === 'list' || !args[1]) {
        result = { groups: groups.listGroups() };
      } else {
        result = {
          error: 'Group usage',
          usage: {
            create: 'group create "Group Name"',
            join: 'group join <invite-code>',
            send: 'group send <groupId> "message"',
            messages: 'group messages <groupId> [--since=timestamp] [--limit=100]',
            invite: 'group invite <groupId> <friendName>',
            info: 'group info <groupId>',
            list: 'group list'
          }
        };
      }
      break;

    // ========== CAPABILITIES ==========
    case 'capabilities':
      result = {
        name: (await clawbot.getStatus()).name,
        tasks: tasks.listTaskHandlers(),
        groups: groups.listGroups().length,
        relay: 'https://relay.example.com',
        features: ['messaging', 'groups', 'tasks', 'auto-reply']
      };
      break;

    default:
      result = {
        error: 'Unknown action',
        usage: {
          // Auto mode
          auto: 'Check and auto-reply to messages (for heartbeat/cron)',
          'auto-full': 'Auto-reply with full details',
          // Core messaging
          check: 'Check for messages and friend requests',
          send: 'send <friend> <message> [--urgent] [--context=work]',
          add: 'add <friend-link> - Add friend directly',
          link: 'Get your friend link',
          friends: 'List friends',
          status: 'Get ClawLink status',
          // Advanced
          task: 'task send|respond|handlers',
          group: 'group create|join|send|messages|invite|info|list',
          capabilities: 'Show agent capabilities',
          preferences: 'preferences [set <path> <value>]'
        }
      };
  }

  console.log(JSON.stringify(result, null, 2));
}

main().catch(err => {
  console.log(JSON.stringify({ error: err.message }));
  process.exit(1);
});
