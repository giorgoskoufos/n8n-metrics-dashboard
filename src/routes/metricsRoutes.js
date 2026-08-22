const express = require('express');
const router = express.Router();
const metricsController = require('../controllers/metricsController');
const { authenticateToken, requireElevatedRole, resolveScope } = require('../middlewares/auth');
const { syncLimiter, globalApiLimiter } = require('../middlewares/rateLimiter');

// Every route below reads or writes workflow-derived data, so resolveScope runs
// on all of them. Applied at the router rather than per route: a handler added
// later inherits the scope instead of silently shipping unscoped.
// It reads req.user, so authenticateToken has to come first.
// globalApiLimiter sits between the two: it keys on req.user, so it needs the
// token decoded first, and there is no point resolving a scope for a request
// that is about to be refused.
router.use(authenticateToken, globalApiLimiter, resolveScope);

router.get('/analytics/metrics', metricsController.getMetrics);
router.get('/analytics/executions', metricsController.getExecutions);
router.get('/analytics/slowest', metricsController.getSlowest);
router.get('/analytics/errors', metricsController.getErrors);
router.get('/execution-error/:id', metricsController.getExecutionError);
// syncLimiter keys on req.user.id, which router.use above has already set.
router.post('/sync/force', syncLimiter, requireElevatedRole, metricsController.forceSync);

// Insights & ROI
router.get('/n8n-health', metricsController.getN8nHealth);
router.get('/settings/roi', metricsController.getSettings);
router.get('/settings', metricsController.getGlobalSettings);
// Instance-wide, not per user: whatever is written here changes the dashboard
// for everyone, so it takes the same gate as forcing a sync.
router.post('/settings', requireElevatedRole, metricsController.updateGlobalSettings);
router.post('/settings/roi', metricsController.updateSettings);
router.get('/analytics/roi', metricsController.getRoiMetrics);
router.get('/analytics/first-execution-date', metricsController.getFirstExecutionDate);
// Renamed from /analytics/concurrency in L-30: the series counts executions
// STARTED per bucket, which is volume, not concurrency. The old name is what
// made the drill-down behind it get written against a different measurement.
router.get('/analytics/execution-volume', metricsController.getExecutionVolume);
router.get('/analytics/execution-volume/details', metricsController.getExecutionVolumeDetails);
router.get('/analytics/error-intelligence', metricsController.getErrorIntelligence);
router.post('/analytics/error-group-executions', metricsController.getErrorGroupExecutions);
router.get('/analytics/workflow-drilldown/:id', metricsController.getWorkflowErrorDrilldown);

module.exports = router;
