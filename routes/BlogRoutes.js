const express = require('express');
const router = express.Router();
const { authenticateAdmin } = require('../middleware/AdminAuthMiddleware');
const authenticate = require('../middleware/UserAuthMiddleware');
const {
  getAdminBlogs,
  createBlog,
  updateBlog,
  deleteBlog,
  getPublicBlogs,
  getBlogBySlug,
  toggleLike,
  addComment,
  deleteComment,
} = require('../controller/BlogController');

// Admin CRUD
router.get('/admin/blogs', authenticateAdmin, getAdminBlogs);
router.post('/admin/blogs', authenticateAdmin, createBlog);
router.put('/admin/blogs/:id', authenticateAdmin, updateBlog);
router.delete('/admin/blogs/:id', authenticateAdmin, deleteBlog);

// Public
router.get('/blogs', getPublicBlogs);
router.get('/blogs/by-slug/:slug', getBlogBySlug);

// User engagement
router.post('/blogs/:id/like', authenticate, toggleLike);
router.post('/blogs/:id/comment', authenticate, addComment);
router.delete('/blogs/:id/comment/:commentId', authenticate, deleteComment);

module.exports = router;
