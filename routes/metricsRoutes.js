const express = require('express');
const router = express.Router();
const metricsController = require('../controllers/metricsController');
const { authenticateToken } = require('../middlewares/auth');

router.get('/metrics', authenticateToken, metricsController.getMetrics);
router.get('/executions', authenticateToken, metricsController.getExecutions);
router.get('/analytics/slowest', authenticateToken, metricsController.getSlowest);
router.get('/analytics/errors', authenticateToken, metricsController.getErrors);
router.get('/execution-error/:id', authenticateToken, metricsController.getExecutionError);

module.exports = router;
