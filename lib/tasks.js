/**
 * ClawLink Task Protocol
 * Request/Response pattern for inter-agent task delegation
 */

import { randomUUID } from 'crypto';
import clawbot from './clawbot.js';

// Registered task handlers
const taskHandlers = new Map();

// Pending task responses
const pendingTasks = new Map();

/**
 * Register a handler for a task type
 * @param {string} taskName - Task identifier (e.g., "web_search", "weather")
 * @param {Function} handler - Async function(params) => result
 */
export function registerTaskHandler(taskName, handler) {
  taskHandlers.set(taskName, handler);
}

/**
 * Unregister a task handler
 */
export function unregisterTaskHandler(taskName) {
  taskHandlers.delete(taskName);
}

/**
 * List registered task handlers
 */
export function listTaskHandlers() {
  return Array.from(taskHandlers.keys());
}

/**
 * Send a task request to another agent
 * @param {string} friendName - Name of the friend to send to
 * @param {string} task - Task name
 * @param {Object} params - Task parameters
 * @param {Object} options - { timeout: 30000, urgent: false }
 * @returns {Promise<Object>} Task response
 */
export async function sendTaskRequest(friendName, task, params = {}, options = {}) {
  const taskId = randomUUID();
  const timeout = options.timeout || 30000;
  
  const message = {
    type: 'task_request',
    taskId,
    task,
    params,
    timeout,
    replyRequired: true,
    sentAt: new Date().toISOString()
  };
  
  // Send the task request
  await clawbot.sendToFriend(friendName, JSON.stringify(message), {
    urgency: options.urgent ? 'urgent' : 'normal',
    context: 'task'
  });
  
  // Return task ID for tracking (response comes async)
  return {
    taskId,
    task,
    sentTo: friendName,
    sentAt: message.sentAt,
    timeout
  };
}

/**
 * Send a task response back
 * @param {string} friendName - Name of the friend who sent the request
 * @param {string} taskId - Original task ID
 * @param {string} status - "success" | "error" | "rejected"
 * @param {Object} result - Result data or error message
 */
export async function sendTaskResponse(friendName, taskId, status, result) {
  const message = {
    type: 'task_response',
    taskId,
    status,
    result,
    completedAt: new Date().toISOString()
  };
  
  await clawbot.sendToFriend(friendName, JSON.stringify(message), {
    urgency: 'normal',
    context: 'task'
  });
  
  return { sent: true, taskId };
}

/**
 * Process an incoming message and handle if it's a task
 * @param {Object} message - Incoming message { from, content }
 * @returns {Object|null} Processed result or null if not a task message
 */
export async function processTaskMessage(message) {
  let content;
  
  try {
    content = typeof message.content === 'string' 
      ? JSON.parse(message.content) 
      : message.content;
  } catch {
    return null; // Not a JSON message
  }
  
  if (content.type === 'task_request') {
    return await handleTaskRequest(message.from, content);
  }
  
  if (content.type === 'task_response') {
    return handleTaskResponse(message.from, content);
  }
  
  return null;
}

/**
 * Handle an incoming task request
 */
async function handleTaskRequest(from, request) {
  const { taskId, task, params } = request;
  
  const handler = taskHandlers.get(task);
  
  if (!handler) {
    // No handler registered - send rejection
    await sendTaskResponse(from, taskId, 'rejected', {
      error: `Unknown task: ${task}`,
      availableTasks: listTaskHandlers()
    });
    
    return {
      type: 'task_rejected',
      taskId,
      task,
      from,
      reason: 'no_handler'
    };
  }
  
  try {
    // Execute the task
    const result = await handler(params);
    
    // Send success response
    await sendTaskResponse(from, taskId, 'success', result);
    
    return {
      type: 'task_completed',
      taskId,
      task,
      from,
      result
    };
  } catch (error) {
    // Send error response
    await sendTaskResponse(from, taskId, 'error', {
      error: error.message
    });
    
    return {
      type: 'task_error',
      taskId,
      task,
      from,
      error: error.message
    };
  }
}

/**
 * Handle an incoming task response
 */
function handleTaskResponse(from, response) {
  const { taskId, status, result } = response;
  
  // Resolve any pending promise for this task
  const pending = pendingTasks.get(taskId);
  if (pending) {
    pending.resolve({ status, result, from });
    pendingTasks.delete(taskId);
  }
  
  return {
    type: 'task_response_received',
    taskId,
    status,
    from,
    result
  };
}

/**
 * Wait for a task response with timeout
 * @param {string} taskId - Task ID to wait for
 * @param {number} timeout - Timeout in ms
 */
export function waitForTaskResponse(taskId, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingTasks.delete(taskId);
      reject(new Error(`Task ${taskId} timed out after ${timeout}ms`));
    }, timeout);
    
    pendingTasks.set(taskId, {
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      }
    });
  });
}

export default {
  registerTaskHandler,
  unregisterTaskHandler,
  listTaskHandlers,
  sendTaskRequest,
  sendTaskResponse,
  processTaskMessage,
  waitForTaskResponse
};
