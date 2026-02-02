/**
 * Payments Service - Main Entry Point
 * Stage 0, Week 5: Payments App Minimal Surface
 */

const express = require('express');
const cors = require('cors');
const { query, close } = require('./utils/db');
const AppEventProcessor = require('./services/eventProcessor');

// Import routes
const expensesRouter = require('./routes/expenses');
const queryRouter = require('./routes/query');
const categorizationRouter = require('./routes/categorization');
const evaluationRouter = require('./routes/evaluation');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
    next();
});

// Health check
app.get('/health', async (req, res) => {
    try {
        await query('SELECT 1');
        res.json({
            ok: true,
            service: 'payments-service',
            version: '0.1.0',
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            ok: false,
            error: 'Database connection failed'
        });
    }
});

// API Routes
app.use('/v0/expenses', expensesRouter);
app.use('/v0/query', queryRouter);
app.use('/v0/categorization', categorizationRouter);
app.use('/v0/evaluation', evaluationRouter);

// Event processing endpoint (for manual trigger or webhook)
app.post('/v0/process-events', async (req, res) => {
    try {
        const processor = new AppEventProcessor();
        const limit = req.body.limit || 100;
        const processed = await processor.processUnprocessedEvents(limit);
        res.json({
            processed_count: processed,
            message: `Processed ${processed} events`
        });
    } catch (error) {
        console.error('[ProcessEvents] Error:', error);
        res.status(500).json({ error: 'Failed to process events' });
    }
});

// Error handler
app.use((error, req, res, next) => {
    console.error('[Error]', error);
    res.status(500).json({
        error: 'Internal server error',
        message: error.message
    });
});

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        error: 'Not found',
        path: req.path
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`\n🚀 Payments Service running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/health`);
    console.log(`💳 Expenses API: http://localhost:${PORT}/v0/expenses`);
    console.log(`🔍 Query API: http://localhost:${PORT}/v0/query`);
    console.log(`🤖 Categorization API: http://localhost:${PORT}/v0/categorization`);
    console.log(`🧪 Evaluation API: http://localhost:${PORT}/v0/evaluation`);
    console.log(`\n✅ Ready to accept connections\n`);

    // Start background event processor
    startEventProcessor();
});

// Background event processor
function startEventProcessor() {
    const processor = new AppEventProcessor();
    const INTERVAL_MS = 60000; // Process every minute

    console.log(`[EventProcessor] Starting background processor (interval: ${INTERVAL_MS}ms)`);

    setInterval(async () => {
        try {
            const processed = await processor.processUnprocessedEvents(100);
            if (processed > 0) {
                console.log(`[EventProcessor] Background job processed ${processed} events`);
            }
        } catch (error) {
            console.error('[EventProcessor] Background job error:', error);
        }
    }, INTERVAL_MS);
}

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('\n🛑 SIGTERM received, shutting down gracefully...');
    server.close(async () => {
        await close();
        console.log('✅ Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('\n🛑 SIGINT received, shutting down gracefully...');
    server.close(async () => {
        await close();
        console.log('✅ Server closed');
        process.exit(0);
    });
});

module.exports = app;
