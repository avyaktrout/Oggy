require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const redis = require('redis');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());

// PostgreSQL connection pool
const pool = new Pool({
  host: process.env.POSTGRES_HOST || 'localhost',
  port: process.env.POSTGRES_PORT || 5432,
  user: process.env.POSTGRES_USER || 'oggy',
  password: process.env.POSTGRES_PASSWORD || 'oggy_dev_password',
  database: process.env.POSTGRES_DB || 'oggy_db',
});

// Redis client
const redisClient = redis.createClient({
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: process.env.REDIS_PORT || 6379,
  }
});

redisClient.on('error', (err) => console.error('Redis Client Error', err));
redisClient.on('connect', () => console.log('✓ Redis connected'));

// Connect to Redis
redisClient.connect().catch(console.error);

// Test database connection
pool.query('SELECT NOW()', (err, res) => {
  if (err) {
    console.error('✗ PostgreSQL connection failed:', err);
  } else {
    console.log('✓ PostgreSQL connected:', res.rows[0].now);
  }
});

// Health check endpoint
app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const redisPing = await redisClient.ping();

    res.json({
      ok: true,
      service: 'memory-service',
      version: '0.1.0',
      postgres: 'connected',
      redis: redisPing === 'PONG' ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      service: 'memory-service',
      error: error.message,
    });
  }
});

// Import routes
const cardRoutes = require('./routes/cards');
const retrievalRoutes = require('./routes/retrieval');
const utilityRoutes = require('./routes/utility');

// Mount routes
app.use('/cards', cardRoutes(pool, redisClient));
app.use('/retrieve', retrievalRoutes(pool, redisClient));
app.use('/utility', utilityRoutes(pool, redisClient));

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: {
      code: err.code || 'INTERNAL',
      message: err.message || 'Internal server error',
      details: err.details || {},
    },
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Memory Service running on port ${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});

// Export for testing
module.exports = { app, pool, redisClient };
