/**
 * Database connection utility
 * Uses same Postgres instance as memory service
 */

const { Pool } = require('pg');

const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'postgres',
    port: process.env.POSTGRES_PORT || 5432,
    database: process.env.POSTGRES_DB || 'oggy_stage0',
    user: process.env.POSTGRES_USER || 'oggy_user',
    password: process.env.POSTGRES_PASSWORD || 'oggy_password',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

// Test connection on startup
pool.on('connect', () => {
    console.log('[DB] Connected to PostgreSQL');
});

pool.on('error', (err) => {
    console.error('[DB] Unexpected error on idle client', err);
    process.exit(-1);
});

/**
 * Query wrapper with logging
 */
async function query(text, params = []) {
    const start = Date.now();
    try {
        const res = await pool.query(text, params);
        const duration = Date.now() - start;
        console.log('[DB] Executed query', { text: text.substring(0, 100), duration, rows: res.rowCount });
        return res;
    } catch (error) {
        console.error('[DB] Query error', { text, error: error.message });
        throw error;
    }
}

/**
 * Get a client for transactions
 */
async function getClient() {
    const client = await pool.connect();
    const originalQuery = client.query;
    const originalRelease = client.release;

    // Monkey patch for logging
    client.query = (...args) => {
        console.log('[DB] Transaction query', { text: args[0].substring(0, 100) });
        return originalQuery.apply(client, args);
    };

    // Track if client was released
    client.release = () => {
        client.query = originalQuery;
        client.release = originalRelease;
        return client.release();
    };

    return client;
}

/**
 * Transaction wrapper
 */
async function transaction(callback) {
    const client = await getClient();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

/**
 * Close pool (for graceful shutdown)
 */
async function close() {
    await pool.end();
    console.log('[DB] Pool closed');
}

module.exports = {
    query,
    getClient,
    transaction,
    close,
    pool
};
