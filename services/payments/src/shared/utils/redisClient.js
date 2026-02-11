/**
 * Redis Client for Payments Service
 * Used for preference working state (Section 5 of Behavior Design Doc)
 */

const redis = require('redis');
const logger = require('./logger');

const REDIS_HOST = process.env.REDIS_HOST || 'redis';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

let client = null;

async function getClient() {
    if (client && client.isReady) return client;

    client = redis.createClient({
        socket: {
            host: REDIS_HOST,
            port: parseInt(REDIS_PORT)
        }
    });

    client.on('error', (err) => {
        logger.warn('Redis client error', { error: err.message });
    });

    client.on('connect', () => {
        logger.info('Redis connected', { host: REDIS_HOST, port: REDIS_PORT });
    });

    try {
        await client.connect();
        await client.ping();
        return client;
    } catch (err) {
        logger.warn('Redis connection failed, behavior system will run without cache', {
            error: err.message
        });
        client = null;
        return null;
    }
}

module.exports = { getClient };
