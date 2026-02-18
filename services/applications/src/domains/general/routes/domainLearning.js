/**
 * Domain Learning Routes
 * Tag suggestion, knowledge pack build/apply/rollback, study plans, audit.
 */
const express = require('express');
const router = express.Router();
const domainLearningService = require('../services/domainLearningService');
const logger = require('../../../shared/utils/logger');

// Suggest domain tags for a project
router.post('/domain-tags/suggest', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { project_id } = req.body;
        if (!project_id) return res.status(400).json({ error: 'project_id required' });

        const tags = await domainLearningService.suggestDomainTags(userId, project_id);
        res.json({ tags });
    } catch (err) {
        logger.logError(err, { operation: 'domain-tags-suggest' });
        res.status(500).json({ error: err.message });
    }
});

// Enable a domain tag for a project
router.post('/domain-tags/enable', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { project_id, tag_id } = req.body;
        if (!project_id || !tag_id) return res.status(400).json({ error: 'project_id and tag_id required' });

        await domainLearningService.enableDomainTag(userId, project_id, tag_id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'domain-tag-enable' });
        res.status(500).json({ error: err.message });
    }
});

// Decline a domain tag
router.post('/domain-tags/decline', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id required' });

        await domainLearningService.declineDomainTag(userId, tag_id);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'domain-tag-decline' });
        res.status(500).json({ error: err.message });
    }
});

// Get project's domain tags
router.get('/domain-tags', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const projectId = req.query.project_id;
        if (!projectId) return res.status(400).json({ error: 'project_id required' });

        const tags = await domainLearningService.getProjectTags(userId, projectId);
        res.json({ tags });
    } catch (err) {
        logger.logError(err, { operation: 'domain-tags-get' });
        res.status(500).json({ error: err.message });
    }
});

// Build a knowledge pack
router.post('/domain-learning/build-pack', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id required' });

        const pack = await domainLearningService.buildKnowledgePack(userId, tag_id);
        res.json(pack);
    } catch (err) {
        logger.logError(err, { operation: 'build-knowledge-pack' });
        res.status(500).json({ error: err.message });
    }
});

// Get packs for a tag
router.get('/domain-learning/packs', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const tagId = req.query.tag_id;
        if (!tagId) return res.status(400).json({ error: 'tag_id required' });

        const packs = await domainLearningService.getPacks(userId, tagId);
        res.json({ packs });
    } catch (err) {
        logger.logError(err, { operation: 'get-knowledge-packs' });
        res.status(500).json({ error: err.message });
    }
});

// Get pack diff
router.get('/domain-learning/packs/:packId/diff', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const diff = await domainLearningService.getPackDiff(userId, req.params.packId);
        res.json(diff);
    } catch (err) {
        logger.logError(err, { operation: 'pack-diff' });
        res.status(500).json({ error: err.message });
    }
});

// Apply a pack
router.post('/domain-learning/packs/:packId/apply', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { project_id } = req.body;
        if (!project_id) return res.status(400).json({ error: 'project_id required' });

        const result = await domainLearningService.applyPack(userId, project_id, req.params.packId);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'apply-pack' });
        res.status(500).json({ error: err.message });
    }
});

// Reject a pack
router.post('/domain-learning/packs/:packId/reject', async (req, res) => {
    try {
        const userId = req.body.user_id;
        await domainLearningService.rejectPack(userId, req.params.packId);
        res.json({ success: true });
    } catch (err) {
        logger.logError(err, { operation: 'reject-pack' });
        res.status(500).json({ error: err.message });
    }
});

// Rollback a tag's applied pack
router.post('/domain-learning/rollback', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { project_id, tag_id } = req.body;
        if (!project_id || !tag_id) return res.status(400).json({ error: 'project_id and tag_id required' });

        const result = await domainLearningService.rollbackPack(userId, project_id, tag_id);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'rollback-pack' });
        res.status(500).json({ error: err.message });
    }
});

// Generate study plan
router.post('/domain-learning/study-plan', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { tag_id } = req.body;
        if (!tag_id) return res.status(400).json({ error: 'tag_id required' });

        const plan = await domainLearningService.generateStudyPlan(userId, tag_id);
        res.json(plan);
    } catch (err) {
        logger.logError(err, { operation: 'study-plan' });
        res.status(500).json({ error: err.message });
    }
});

// Refine/edit an existing study plan based on user feedback
router.post('/domain-learning/study-plan/refine', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { tag_id, current_plan, feedback } = req.body;
        if (!tag_id || !current_plan || !feedback) return res.status(400).json({ error: 'tag_id, current_plan and feedback required' });

        const plan = await domainLearningService.refineStudyPlan(userId, tag_id, current_plan, feedback);
        res.json(plan);
    } catch (err) {
        logger.logError(err, { operation: 'refine-study-plan' });
        res.status(500).json({ error: err.message });
    }
});

// Save (accept) a study plan for a project
router.post('/domain-learning/study-plan/save', async (req, res) => {
    try {
        const userId = req.body.user_id;
        const { project_id, tag_id, plan } = req.body;
        if (!project_id || !tag_id || !plan) return res.status(400).json({ error: 'project_id, tag_id and plan required' });

        const result = await domainLearningService.saveStudyPlan(userId, project_id, tag_id, plan);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'save-study-plan' });
        res.status(500).json({ error: err.message });
    }
});

// Get all saved study plans for a project
router.get('/domain-learning/study-plans', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const projectId = req.query.project_id;
        if (!projectId) return res.status(400).json({ error: 'project_id required' });

        const plans = await domainLearningService.getProjectStudyPlans(userId, projectId);
        res.json({ plans });
    } catch (err) {
        logger.logError(err, { operation: 'get-project-study-plans' });
        res.status(500).json({ error: err.message });
    }
});

// Delete a saved study plan
router.delete('/domain-learning/study-plan/:planId', async (req, res) => {
    try {
        const userId = req.query.user_id || req.body.user_id;
        const result = await domainLearningService.deleteStudyPlan(userId, req.params.planId);
        res.json(result);
    } catch (err) {
        logger.logError(err, { operation: 'delete-study-plan' });
        res.status(500).json({ error: err.message });
    }
});

// Audit events
router.get('/domain-learning/audit', async (req, res) => {
    try {
        const userId = req.query.user_id;
        const projectId = req.query.project_id;
        const limit = req.query.limit || 20;

        const events = await domainLearningService.getAuditEvents(userId, projectId, limit);
        res.json({ events });
    } catch (err) {
        logger.logError(err, { operation: 'dl-audit' });
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
