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

        // Add caffeine_mg column to v3_diet_items and branded_foods if not exists
        try {
            await query(`
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'v3_diet_items' AND column_name = 'caffeine_mg') THEN
                        ALTER TABLE v3_diet_items ADD COLUMN caffeine_mg REAL DEFAULT 0;
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'branded_foods' AND column_name = 'caffeine_mg') THEN
                        ALTER TABLE branded_foods ADD COLUMN caffeine_mg REAL DEFAULT 0;
                    END IF;
                END $$
            `);
            logger.info('caffeine_mg column ensured on v3_diet_items and branded_foods');
        } catch (colErr) {
            logger.debug('caffeine_mg column add skipped', { error: colErr.message });
        }

        // Seed additional popular branded foods (ON CONFLICT DO UPDATE — safe to run every boot)
        try {
            await query(`
                INSERT INTO branded_foods (brand, product, serving_size, calories, protein_g, carbs_g, fat_g, fiber_g, sugar_g, sodium_mg, category, caffeine_mg) VALUES
                ('Ghost', 'Energy Drink Cherry Limeade', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Warheads Sour Watermelon', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Orange Cream', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Swedish Fish', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Citrus', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Tropical Mango', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Ghost', 'Energy Drink Bubblicious', '16 fl oz', 10, 0, 2, 0, 0, 0, 50, 'energy_drink', 200),
                ('Reign', 'Total Body Fuel Orange Dreamsicle', '16 fl oz', 10, 0, 3, 0, 0, 0, 200, 'energy_drink', 300),
                ('Reign', 'Total Body Fuel Melon Mania', '16 fl oz', 10, 0, 3, 0, 0, 0, 200, 'energy_drink', 300),
                ('ZOA', 'Energy Drink Wild Orange', '16 fl oz', 15, 0, 2, 0, 0, 0, 160, 'energy_drink', 160),
                ('ZOA', 'Energy Drink Pineapple Coconut', '16 fl oz', 15, 0, 2, 0, 0, 0, 160, 'energy_drink', 160),
                ('3D', 'Energy Drink Chrome', '16 fl oz', 5, 0, 0, 0, 0, 0, 10, 'energy_drink', 200),
                ('Celsius', 'Sparkling Kiwi Guava', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink', 200),
                ('Celsius', 'Sparkling Grape Rush', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink', 200),
                ('Celsius', 'Sparkling Tropical Vibe', '12 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink', 200),
                ('Monster', 'Ultra Rosa', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink', 150),
                ('Monster', 'Ultra Sunrise', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink', 150),
                ('Monster', 'Ultra Watermelon', '16 fl oz', 10, 0, 3, 0, 0, 0, 150, 'energy_drink', 150),
                ('Monster', 'Java Mean Bean', '15 fl oz', 200, 6, 34, 3, 0, 33, 160, 'energy_drink', 188),
                ('Alani Nu', 'Energy Drink Cherry Slush', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink', 200),
                ('Alani Nu', 'Energy Drink Hawaiian Shaved Ice', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink', 200),
                ('Alani Nu', 'Energy Drink Tropsicle', '12 fl oz', 10, 0, 1, 0, 0, 0, 70, 'energy_drink', 200),
                ('C4', 'Smart Energy Cotton Candy', '16 fl oz', 0, 0, 1, 0, 0, 0, 0, 'energy_drink', 200),
                ('Celsius', 'HEAT Inferno Cherry Lime', '16 fl oz', 10, 0, 2, 0, 0, 0, 0, 'energy_drink', 300),
                ('PRIME', 'Energy Drink Blue Raspberry', '12 fl oz', 10, 0, 2, 0, 0, 0, 85, 'energy_drink', 200),
                ('PRIME', 'Energy Drink Tropical Punch', '12 fl oz', 10, 0, 2, 0, 0, 0, 85, 'energy_drink', 200),
                ('PRIME', 'Hydration Drink Ice Pop', '16.9 fl oz', 25, 0, 5, 0, 0, 2, 10, 'sports_drink', 0),
                ('Liquid IV', 'Hydration Multiplier Lemon Lime', '1 packet (16g)', 45, 0, 11, 0, 0, 11, 500, 'sports_drink', 0),
                ('Bodyarmor', 'Strawberry Banana', '16 fl oz', 70, 0, 18, 0, 0, 18, 30, 'sports_drink', 0),
                ('Ghost', 'Whey Protein Peanut Butter Cereal Milk', '1 scoop (36g)', 130, 25, 5, 1.5, 0, 2, 180, 'protein_shake', 0),
                ('Ghost', 'Whey Protein Chips Ahoy', '1 scoop (36g)', 130, 25, 5, 1.5, 0, 2, 180, 'protein_shake', 0),
                ('Ghost', 'Vegan Protein Peanut Butter Cereal Milk', '1 scoop (42g)', 150, 20, 9, 4, 2, 2, 290, 'protein_shake', 0),
                ('Fairlife', 'Core Power Elite Chocolate', '14 fl oz', 230, 42, 13, 3.5, 1, 7, 390, 'protein_shake', 0),
                ('Samyang', 'Buldak Carbonara Hot Chicken Ramen', '1 pack (130g)', 550, 9, 80, 20, 2, 5, 1800, 'instant_noodle', 0),
                ('Samyang', 'Buldak Hot Chicken Ramen Original', '1 pack (140g)', 530, 10, 78, 18, 2, 3, 1920, 'instant_noodle', 0),
                ('Samyang', 'Buldak 2x Spicy Hot Chicken Ramen', '1 pack (140g)', 545, 10, 80, 19, 2, 4, 1890, 'instant_noodle', 0),
                ('Samyang', 'Buldak Cheese Hot Chicken Ramen', '1 pack (140g)', 540, 10, 79, 19, 2, 4, 1710, 'instant_noodle', 0),
                ('Samyang', 'Buldak Jjajang Hot Chicken Ramen', '1 pack (140g)', 550, 10, 81, 20, 2, 5, 1700, 'instant_noodle', 0),
                ('Samyang', 'Buldak Curry Hot Chicken Ramen', '1 pack (140g)', 530, 10, 77, 19, 2, 5, 1680, 'instant_noodle', 0),
                ('Nongshim', 'Shin Ramyun', '1 pack (120g)', 510, 10, 75, 18, 2, 3, 1790, 'instant_noodle', 0),
                ('Nongshim', 'Shin Ramyun Black', '1 pack (130g)', 560, 11, 78, 21, 2, 4, 1880, 'instant_noodle', 0),
                ('Maruchan', 'Instant Lunch Chicken', '1 cup (64g)', 290, 7, 37, 12, 1, 2, 1200, 'instant_noodle', 0),
                ('Nissin', 'Cup Noodles Chicken', '1 cup (64g)', 290, 7, 36, 13, 2, 2, 1160, 'instant_noodle', 0),
                ('Nissin', 'Top Ramen Chicken', '1 pack (85g)', 380, 8, 52, 14, 2, 1, 1440, 'instant_noodle', 0),
                ('Indomie', 'Mi Goreng Instant Noodles', '1 pack (85g)', 390, 8, 52, 16, 1, 3, 910, 'instant_noodle', 0)
                ON CONFLICT (brand, product) DO UPDATE SET
                    serving_size = EXCLUDED.serving_size, calories = EXCLUDED.calories,
                    protein_g = EXCLUDED.protein_g, carbs_g = EXCLUDED.carbs_g,
                    fat_g = EXCLUDED.fat_g, fiber_g = EXCLUDED.fiber_g,
                    sugar_g = EXCLUDED.sugar_g, sodium_mg = EXCLUDED.sodium_mg,
                    caffeine_mg = EXCLUDED.caffeine_mg
            `);
            logger.info('Branded foods seed check completed');
        } catch (seedErr) {
            logger.debug('Branded foods seed skipped', { error: seedErr.message });
        }

        // Run diet features migration (saved meals, barcode column, goal index)
        try {
            await query(`
                CREATE TABLE IF NOT EXISTS v3_saved_meals (
                    meal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                    user_id TEXT NOT NULL,
                    name TEXT NOT NULL,
                    meal_type TEXT,
                    items JSONB NOT NULL DEFAULT '[]',
                    total_calories INTEGER DEFAULT 0,
                    total_protein REAL DEFAULT 0,
                    usage_count INTEGER DEFAULT 0,
                    last_used TIMESTAMPTZ,
                    created_at TIMESTAMPTZ DEFAULT NOW()
                )
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_saved_meals_user ON v3_saved_meals(user_id)`);
            await query(`
                DO $$ BEGIN
                    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'branded_foods' AND column_name = 'barcode') THEN
                        ALTER TABLE branded_foods ADD COLUMN barcode TEXT;
                    END IF;
                END $$
            `);
            await query(`CREATE INDEX IF NOT EXISTS idx_branded_foods_barcode ON branded_foods(barcode) WHERE barcode IS NOT NULL`);
            await query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_diet_rules_goal_nutrient ON v3_diet_rules(user_id, target_nutrient, rule_type) WHERE active = true AND target_nutrient IS NOT NULL`);
            logger.info('Diet features migration applied (saved_meals, barcode, goals)');
        } catch (migErr) {
            logger.debug('Diet features migration skipped', { error: migErr.message });
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
