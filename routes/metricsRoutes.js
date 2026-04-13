const express = require('express');
const router = express.Router();
const metricsController = require('../controllers/metricsController');
const { authenticateToken } = require('../middlewares/auth');

router.get('/metrics', authenticateToken, metricsController.getMetrics);
router.get('/executions', authenticateToken, metricsController.getExecutions);
router.get('/analytics/slowest', authenticateToken, metricsController.getSlowest);
router.get('/analytics/errors', authenticateToken, metricsController.getErrors);
router.get('/execution-error/:id', authenticateToken, metricsController.getExecutionError);
router.post('/sync/force', authenticateToken, metricsController.forceSync);

// Insights & ROI
router.get('/n8n-health', authenticateToken, metricsController.getN8nHealth);
router.get('/settings/roi', authenticateToken, metricsController.getSettings);
router.get('/settings', authenticateToken, metricsController.getGlobalSettings);
router.post('/settings', authenticateToken, metricsController.updateGlobalSettings);
router.post('/settings/roi', authenticateToken, metricsController.updateSettings);
router.get('/analytics/roi', authenticateToken, metricsController.getRoiMetrics);
router.get('/analytics/concurrency', authenticateToken, metricsController.getConcurrencyData);
router.get('/analytics/concurrency/details', authenticateToken, metricsController.getConcurrencyDetails);

module.exports = router;
