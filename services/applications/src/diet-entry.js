/**
 * Diet Domain Service Entry Point
 *
 * Runs behind the API gateway. Handles diet agent routes:
 * chat, entries, nutrition, rules, and continuous learning for the diet domain.
 */

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { query, close } = require('./shared/utils/db');
const logger = require('./shared/utils/logger');
const { injectUserIdFromHeader } = require('./shared/middleware/internalService');

// Domain routes
const dietRouter = require('./domains/diet/routes/diet');

// Shared routes used by diet domain
const continuousLearningRouter = require('./shared/routes/continuousLearning');

const app = express();
const PORT = process.env.PORT || 3012;

// ──────────────────────────────────────────────────
// Middleware
// ──────────────────────────────────────────────────
app.use(express.json({ limit: '50mb' }));

// Request ID (forwarded from gateway)
app.use((req, res, next) => {
    req.requestId = req.headers['x-request-id'] || uuidv4();
    res.setHeader('x-request-id', req.requestId);
    next();
});

// Request logging
app.use((req, res, next) => {
    const startTime = Date.now();
    res.on('finish', () => {
        logger.info('HTTP Request', {
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            statusCode: res.statusCode,
            duration_ms: Date.now() - startTime,
            service: 'diet',
        });
    });
    next();
});

// Inject user_id from gateway header
app.use(injectUserIdFromHeader);

// ──────────────────────────────────────────────────
// Health check
// ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
    let dbOk = false;
    try {
        await query('SELECT 1');
        dbOk = true;
    } catch (_) {}

    res.status(dbOk ? 200 : 503).json({
        ok: dbOk,
        service: 'diet-service',
        timestamp: new Date().toISOString(),
        checks: { database: dbOk },
    });
});

// ──────────────────────────────────────────────────
// Routes
// ──────────────────────────────────────────────────
app.use('/v0/diet', dietRouter);
app.use('/v0/continuous-learning', continuousLearningRouter);

// ──────────────────────────────────────────────────
// Error + 404 handlers
// ──────────────────────────────────────────────────
app.use((error, req, res, _next) => {
    logger.logError(error, { requestId: req.requestId, path: req.path, service: 'diet' });
    res.status(500).json({ error: 'Internal server error', requestId: req.requestId });
});

app.use((req, res) => {
    res.status(404).json({ error: 'Not found', path: req.path, service: 'diet' });
});

// ──────────────────────────────────────────────────
// Start server
// ──────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
    logger.info('Diet service starting', { port: PORT });

    // Database check + seed popular branded foods
    try {
        await query('SELECT 1');
        logger.info('Database connection verified (diet)');

        // Add unique constraint + deduplicate branded_foods
        try {
            // Remove duplicates first (keep one per brand+product)
            await query(`
                DELETE FROM branded_foods a USING branded_foods b
                WHERE a.food_id > b.food_id AND a.brand = b.brand AND a.product = b.product
            `);
            // Add unique constraint if not exists
            await query(`
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'branded_foods_brand_product_key') THEN
                        ALTER TABLE branded_foods ADD CONSTRAINT branded_foods_brand_product_key UNIQUE (brand, product);
                    END IF;
                END $$
            `);
            logger.info('Branded foods dedup + unique constraint applied');
        } catch (dedupErr) {
            logger.debug('Branded foods dedup skipped', { error: dedupErr.message });
        }

        // Seed additional popular branded foods (ON CONFLICT DO NOTHING — safe to run every boot)
        try {
            await query(`
                INSERT INTO branded_foods (brand, product, serving_size, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, category) VALUES
                ('Ghost', 'Energy Drink Cherry Limeade', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Warheads Sour Watermelon', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Orange Cream', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Swedish Fish', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Citrus', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Tropical Mango', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Ghost', 'Energy Drink Bubblicious', '16 fl oz', 5, 0, 1, 0, 0, 0, 50, 'energy_drink'),
                ('Reign', 'Total Body Fuel Orange Dreamsicle', '16 fl oz', 10, 0, 3, 0, 0, 0, 200, 'energy_drink'),
                ('Reign', 'Total Body Fuel Melon Mania', '16 fl oz', 10, 0, 3, 0, 0, 0, 200, 'energy_drink'),
                ('ZOA', 'Energy Drink Wild Orange', '16 fl oz', 15, 0, 2, 0, 0, 0, 160, 'energy_drink'),
                ('ZOA', 'Energy Drink Pineapple Coconut', '16 fl oz', 15, 0, 2, 0, 0, 0, 160, 'energy_drink'),
                ('3D', 'Energy Drink Chrome', '16 fl oz', 5, 0, 0, 0, 0, 0, 10, 'energy_drink'),
                ('Celsius', 'Sparkling Kiwi Guava', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink'),
                ('Celsius', 'Sparkling Grape Rush', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink'),
                ('Celsius', 'Sparkling Tropical Vibe', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink'),
                ('Monster', 'Ultra Rosa', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink'),
                ('Monster', 'Ultra Sunrise', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink'),
                ('Monster', 'Ultra Watermelon', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink'),
                ('Monster', 'Java Mean Bean', '15 fl oz', 200, 6, 34, 3, 0, 33, 160, 'energy_drink'),
                ('Alani Nu', 'Energy Drink Cherry Slush', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink'),
                ('Alani Nu', 'Energy Drink Hawaiian Shaved Ice', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink'),
                ('Alani Nu', 'Energy Drink Tropsicle', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink'),
                ('C4', 'Smart Energy Cotton Candy', '16 fl oz', 0, 0, 1, 0, 0, 0, 0, 'energy_drink'),
                ('Celsius', 'HEAT Inferno Cherry Lime', '16 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink'),
                ('PRIME', 'Energy Drink Blue Raspberry', '12 fl oz', 10, 0, 2, 0, 0, 0, 85, 'energy_drink'),
                ('PRIME', 'Energy Drink Tropical Punch', '12 fl oz', 10, 0, 2, 0, 0, 0, 85, 'energy_drink'),
                ('PRIME', 'Hydration Drink Ice Pop', '16.9 fl oz', 25, 0, 5, 0, 0, 2, 10, 'sports_drink'),
                ('Liquid IV', 'Hydration Multiplier Lemon Lime', '1 packet (16g)', 45, 0, 11, 0, 0, 11, 500, 'sports_drink'),
                ('Bodyarmor', 'Strawberry Banana', '16 fl oz', 70, 0, 18, 0, 0, 18, 30, 'sports_drink'),
                ('Ghost', 'Whey Protein Peanut Butter Cereal Milk', '1 scoop (36g)', 130, 25, 5, 1.5, 0, 2, 180, 'protein_shake'),
                ('Ghost', 'Whey Protein Chips Ahoy', '1 scoop (36g)', 130, 25, 5, 1.5, 0, 2, 180, 'protein_shake'),
                ('Ghost', 'Vegan Protein Peanut Butter Cereal Milk', '1 scoop (42g)', 150, 20, 9, 4, 2, 2, 290, 'protein_shake'),
                ('Fairlife', 'Core Power Elite Chocolate', '14 fl oz', 230, 42, 13, 3.5, 1, 7, 390, 'protein_shake')
                ON CONFLICT (brand, product) DO NOTHING
            `);
            logger.info('Branded foods seed check completed');
        } catch (seedErr) {
            logger.debug('Branded foods seed skipped', { error: seedErr.message });
        }
    } catch (error) {
        logger.error('Database connection failed (diet)', { error: error.message });
        process.exit(1);
    }

    logger.info('Diet service ready');
});

// Graceful shutdown
function gracefulShutdown(signal) {
    logger.warn(`${signal} received, shutting down diet service`);
    const timeout = setTimeout(() => process.exit(1), 30000);
    server.close(async () => {
        try { await close(); } catch (_) {}
        clearTimeout(timeout);
        process.exit(0);
    });
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception (diet)', { error: error.message, stack: error.stack });
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection (diet)', {
        reason: reason instanceof Error ? reason.message : String(reason),
    });
});

module.exports = app;
