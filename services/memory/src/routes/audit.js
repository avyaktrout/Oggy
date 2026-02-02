/**
 * Audit API Routes
 * Week 4: Unified audit system with proper service boundaries
 *
 * Provides centralized audit logging for all services
 */

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

module.exports = (pool) => {
  /**
   * POST /audit/log
   * Write a new audit event to the unified log
   *
   * Body:
   *   - event_type: string (required) - Type of event
   *   - service: string (required) - Service that generated the event
   *   - payload: object (required) - Event-specific data
   *   - correlation_id: uuid (optional) - Links related events
   *   - user_id: string (optional) - User who triggered the event
   *   - session_id: string (optional) - Session ID
   */
  router.post('/log', async (req, res) => {
    try {
      const { event_type, service, payload, correlation_id, user_id, session_id } = req.body;

      // Validation
      if (!event_type || !service || !payload) {
        return res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'event_type, service, and payload are required'
          }
        });
      }

      // Valid event types
      const validEventTypes = ['retrieval', 'card_create', 'card_update', 'card_delete', 'cir_violation'];
      if (!validEventTypes.includes(event_type)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_EVENT_TYPE',
            message: `event_type must be one of: ${validEventTypes.join(', ')}`
          }
        });
      }

      // Valid services
      const validServices = ['memory', 'learning'];
      if (!validServices.includes(service)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_SERVICE',
            message: `service must be one of: ${validServices.join(', ')}`
          }
        });
      }

      // Validate payload is an object
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'payload must be an object'
          }
        });
      }

      // Insert into audit_log
      const result = await pool.query(
        `INSERT INTO audit_log (event_type, service, payload, correlation_id, user_id, session_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING log_id, ts`,
        [event_type, service, JSON.stringify(payload), correlation_id, user_id, session_id]
      );

      res.status(201).json({
        log_id: result.rows[0].log_id,
        ts: result.rows[0].ts
      });

    } catch (error) {
      console.error('Audit log error:', error);
      res.status(500).json({
        error: {
          code: 'AUDIT_LOG_FAILED',
          message: 'Failed to write audit log',
          details: error.message
        }
      });
    }
  });

  /**
   * GET /audit/trace/:correlation_id
   * Get all events linked by correlation_id (full request trace)
   *
   * Returns events in chronological order
   */
  router.get('/trace/:correlation_id', async (req, res) => {
    try {
      const { correlation_id } = req.params;

      if (!correlation_id) {
        return res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: 'correlation_id is required'
          }
        });
      }

      const result = await pool.query(
        `SELECT log_id, event_type, service, payload, user_id, session_id, ts
         FROM audit_log
         WHERE correlation_id = $1
         ORDER BY ts ASC`,
        [correlation_id]
      );

      res.json({
        correlation_id,
        events: result.rows,
        count: result.rows.length
      });

    } catch (error) {
      console.error('Audit trace error:', error);
      res.status(500).json({
        error: {
          code: 'AUDIT_TRACE_FAILED',
          message: 'Failed to retrieve audit trace',
          details: error.message
        }
      });
    }
  });

  /**
   * GET /audit/events
   * Query audit events with filters
   *
   * Query params:
   *   - event_type: Filter by event type
   *   - service: Filter by service
   *   - user_id: Filter by user ID
   *   - limit: Max results (default 100, max 1000)
   *   - offset: Pagination offset (default 0)
   */
  router.get('/events', async (req, res) => {
    try {
      const { event_type, service, user_id, limit = 100, offset = 0 } = req.query;

      // Validate limit
      const parsedLimit = Math.min(parseInt(limit) || 100, 1000);
      const parsedOffset = parseInt(offset) || 0;

      let query = 'SELECT * FROM audit_log WHERE 1=1';
      const params = [];
      let paramIndex = 1;

      if (event_type) {
        query += ` AND event_type = $${paramIndex}`;
        params.push(event_type);
        paramIndex++;
      }

      if (service) {
        query += ` AND service = $${paramIndex}`;
        params.push(service);
        paramIndex++;
      }

      if (user_id) {
        query += ` AND user_id = $${paramIndex}`;
        params.push(user_id);
        paramIndex++;
      }

      query += ` ORDER BY ts DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;
      params.push(parsedLimit, parsedOffset);

      const result = await pool.query(query, params);

      res.json({
        events: result.rows,
        count: result.rows.length,
        limit: parsedLimit,
        offset: parsedOffset
      });

    } catch (error) {
      console.error('Audit events error:', error);
      res.status(500).json({
        error: {
          code: 'AUDIT_EVENTS_FAILED',
          message: 'Failed to retrieve audit events',
          details: error.message
        }
      });
    }
  });

  /**
   * GET /audit/stats
   * Get statistics about audit events
   *
   * Returns:
   *   - total_events: Total number of audit events
   *   - by_event_type: Count by event type
   *   - by_service: Count by service
   *   - recent_activity: Recent events count by hour
   */
  router.get('/stats', async (req, res) => {
    try {
      // Total events
      const totalResult = await pool.query('SELECT COUNT(*) as total FROM audit_log');
      const total = parseInt(totalResult.rows[0].total);

      // By event type
      const eventTypeResult = await pool.query(`
        SELECT event_type, COUNT(*) as count
        FROM audit_log
        GROUP BY event_type
        ORDER BY count DESC
      `);

      // By service
      const serviceResult = await pool.query(`
        SELECT service, COUNT(*) as count
        FROM audit_log
        GROUP BY service
        ORDER BY count DESC
      `);

      // Recent activity (last 24 hours)
      const recentResult = await pool.query(`
        SELECT COUNT(*) as count
        FROM audit_log
        WHERE ts >= NOW() - INTERVAL '24 hours'
      `);

      res.json({
        total_events: total,
        by_event_type: eventTypeResult.rows.reduce((acc, row) => {
          acc[row.event_type] = parseInt(row.count);
          return acc;
        }, {}),
        by_service: serviceResult.rows.reduce((acc, row) => {
          acc[row.service] = parseInt(row.count);
          return acc;
        }, {}),
        last_24h_count: parseInt(recentResult.rows[0].count)
      });

    } catch (error) {
      console.error('Audit stats error:', error);
      res.status(500).json({
        error: {
          code: 'AUDIT_STATS_FAILED',
          message: 'Failed to retrieve audit statistics',
          details: error.message
        }
      });
    }
  });

  return router;
};
