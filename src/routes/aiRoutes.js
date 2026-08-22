const express = require('express');
const router = express.Router();
const aiController = require('../controllers/aiController');
const { authenticateToken, resolveScope } = require('../middlewares/auth');
const { aiLimiter, globalApiLimiter } = require('../middlewares/rateLimiter');

router.use(authenticateToken, globalApiLimiter, resolveScope);

router.post('/ai-chat', aiLimiter, aiController.chat);
router.get('/chat-history', aiController.getHistory);

module.exports = router;
