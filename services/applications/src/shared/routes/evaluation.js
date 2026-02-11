/**
 * Evaluation Routes
 * Week 6: Tessa assessment generation and agent comparison
 */

const express = require('express');
const router = express.Router();
const TessaAssessments = require('../../domains/payments/services/tessaAssessments');
const AgentEvaluator = require('../../domains/payments/services/evaluator');

const tessa = new TessaAssessments();
const evaluator = new AgentEvaluator();

/**
 * POST /evaluation/generate-practice
 * Generate practice assessments for training
 */
router.post('/generate-practice', async (req, res) => {
    try {
        const { user_id, count = 10 } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required field: user_id' });
        }

        const assessments = await tessa.generatePracticeAssessment(user_id, count);

        res.json(assessments);
    } catch (error) {
        console.error('[Evaluation] Generate practice error:', error);
        res.status(500).json({ error: 'Failed to generate practice assessments' });
    }
});

/**
 * POST /evaluation/generate-sealed
 * Generate sealed benchmark assessments
 */
router.post('/generate-sealed', async (req, res) => {
    try {
        const { count = 20 } = req.body;

        const benchmark = await tessa.generateSealedBenchmark(count);

        // Return metadata only (not full assessments for security)
        res.json({
            benchmark_id: benchmark.benchmark_id,
            type: benchmark.type,
            count: benchmark.count,
            generated_at: benchmark.generated_at
        });
    } catch (error) {
        console.error('[Evaluation] Generate sealed error:', error);
        res.status(500).json({ error: 'Failed to generate sealed benchmark' });
    }
});

/**
 * POST /evaluation/compare
 * Run comparison: Oggy vs Base
 */
router.post('/compare', async (req, res) => {
    try {
        const { user_id, benchmark_count = 20 } = req.body;

        if (!user_id) {
            return res.status(400).json({ error: 'Missing required field: user_id' });
        }

        console.log(`[Evaluation] Starting comparison for user ${user_id}...`);

        const results = await evaluator.runComparison(user_id, benchmark_count);

        res.json(results);
    } catch (error) {
        console.error('[Evaluation] Comparison error:', error);
        res.status(500).json({
            error: 'Failed to run comparison',
            details: error.message
        });
    }
});

/**
 * POST /evaluation/score-assessment
 * Score a single assessment response
 */
router.post('/score-assessment', async (req, res) => {
    try {
        const { assessment, agent_response } = req.body;

        if (!assessment || !agent_response) {
            return res.status(400).json({ error: 'Missing required fields: assessment, agent_response' });
        }

        const scored = tessa.scoreResponse(assessment, agent_response);

        res.json(scored);
    } catch (error) {
        console.error('[Evaluation] Score assessment error:', error);
        res.status(500).json({ error: 'Failed to score assessment' });
    }
});

module.exports = router;
