const express = require('express');
const router = express.Router();

const {
  addGender,
  getGenders,
  updateGender,
  deleteGender
} = require('../controller/GenderController');


const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');

// Read — any authenticated admin
router.get('/genders', getGenders);

// Create and update — authenticated admin
router.post('/genders', authenticateAdmin, addGender);
router.put('/genders/:id', authenticateAdmin, updateGender);

// Delete — requires the Products module permission
router.delete('/genders/:id', authenticateAdmin, deleteGender);

module.exports = router;
