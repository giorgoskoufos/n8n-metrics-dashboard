const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateToken } = require('../middlewares/auth');
const { aiLimiter } = require('../middlewares/rateLimiter');

router.post('/ai-chat', authenticateToken, aiLimiter, aiController.chat);
router.get('/chat-history', authenticateToken, aiController.getHistory);

module.exports = router;
