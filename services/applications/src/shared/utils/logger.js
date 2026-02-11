/**
 * Structured Logger
 * Provides consistent, traceable logging across the service
 */

const winston = require('winston');

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

// Custom format for console output
const consoleFormat = winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.colorize(),
    winston.format.printf(({ timestamp, level, message, service, ...meta }) => {
        let msg = `${timestamp} [${level}] [${service}] ${message}`;

        // Add metadata if present (excluding common fields)
        const metaKeys = Object.keys(meta).filter(k => !['timestamp', 'level', 'message', 'service', 'splat'].includes(k));
        if (metaKeys.length > 0) {
            const metaStr = JSON.stringify(
                metaKeys.reduce((obj, key) => ({ ...obj, [key]: meta[key] }), {})
            );
            msg += ` ${metaStr}`;
        }

        return msg;
    })
);

// JSON format for file/structured logging
const jsonFormat = winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
);

const logger = winston.createLogger({
    level: LOG_LEVEL,
    defaultMeta: { service: 'application-service' },
    transports: [
        // Console transport for development
        new winston.transports.Console({
            format: consoleFormat
        })
    ]
});

// Add request context to logs
logger.addRequestContext = (requestId, userId) => {
    return logger.child({ requestId, userId });
};

// Convenience methods for structured logging
logger.logOperation = (operation, metadata = {}) => {
    logger.info(`Operation: ${operation}`, metadata);
};

logger.logError = (error, context = {}) => {
    logger.error(error.message, {
        error: error.name,
        stack: error.stack,
        ...context
    });
};

logger.logMetric = (metric, value, unit = '') => {
    logger.info('Metric', { metric, value, unit, type: 'metric' });
};

module.exports = logger;
