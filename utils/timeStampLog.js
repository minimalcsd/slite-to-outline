/**
 * Logs a message with timestamp
 * @param {string} message - Message to log
 */
export function timeStampLog(message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${message}`);
} 