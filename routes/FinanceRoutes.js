const express = require('express');
const router = express.Router();
const finance = require('../controller/FinanceController');
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

router.get('/admin/finance/overview', authenticateAdmin, finance.getOverview);
router.get('/admin/finance/transactions', authenticateAdmin, finance.getTransactions);
router.get('/admin/finance/transactions.csv', authenticateAdmin, finance.exportTransactionsCsv);
router.get('/admin/finance/expenses', authenticateAdmin, finance.getExpenses);
router.post('/admin/finance/expenses', authenticateAdmin, finance.createExpense);
router.put('/admin/finance/expenses/:id', authenticateAdmin, finance.updateExpense);
router.delete('/admin/finance/expenses/:id', authenticateAdmin, finance.deleteExpense);

module.exports = router;
