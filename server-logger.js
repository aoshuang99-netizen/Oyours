/**
 * 服务器日志模块
 * 提供统一的日志记录功能
 */

 createServerLogger(moduleName) {
  return {
    info: (message, ...args) => {
      console.log(`[${moduleName}] INFO: ${message}`, ...args);
    },
    warn: (message, ...args) => {
      console.warn(`[${moduleName}] WARN: ${message}`, ...args);
    },
    error: (message, ...args) => {
      console.error(`[${moduleName}] ERROR: ${message}`, ...args);
    },
    debug: (message, ...args) => {
      if (process.env.DEBUG) {
        console.debug(`[${moduleName}] DEBUG: ${message}`, ...args);
      }
    }
  };
}

module.exports = { createServerLogger };
