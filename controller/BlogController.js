const Blog = require('../models/Blog');

const slugify = (name) =>
  String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === 'string') return tags.split(',').map((t) => t.trim()).filter(Boolean);
  return [];
};

const uniqueSlug = async (title, excludeId = null) => {
  let base = slugify(title) || 'blog-post';
  let slug = base;
  let i = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await Blog.findOne({ slug, ...(excludeId ? { _id: { $ne: excludeId } } : {}) })) {
    i += 1;
    slug = `${base}-${i}`;
  }
  return slug;
};

const blogPayload = (body) => ({
  title: body.title,
  content: body.content || '',
  excerpt: body.excerpt || '',
  coverImage: body.coverImage || '',
  author: body.author || 'BELORELLA',
  tags: normalizeTags(body.tags),
  category: body.category || 'General',
  status: body.status === 'published' ? 'published' : 'draft',
  seo: body.seo || {},
});

// ─── Admin ──────────────────────────────────────────────────
const getAdminBlogs = async (req, res) => {
  try {
    const { q, status } = req.query;
    const filter = {};
    if (q) filter.title = { $regex: String(q).trim(), $options: 'i' };
    if (status) filter.status = status;
    const blogs = await Blog.find(filter).sort({ updatedAt: -1 });
    res.status(200).json(blogs);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch blogs', error: error.message });
  }
};

const createBlog = async (req, res) => {
  try {
    if (!req.body.title?.trim()) return res.status(400).json({ message: 'Title is required' });
    const slug = await uniqueSlug(req.body.title);
    const blog = await Blog.create({ ...blogPayload(req.body), slug });
    res.status(201).json(blog);
  } catch (error) {
    res.status(500).json({ message: 'Failed to create blog', error: error.message });
  }
};

const updateBlog = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog not found' });

    if (req.body.title && req.body.title.trim() && req.body.title !== blog.title) {
      blog.slug = await uniqueSlug(req.body.title, blog._id);
    }
    Object.assign(blog, blogPayload({ ...blog.toObject(), ...req.body }));
    await blog.save();
    res.status(200).json(blog);
  } catch (error) {
    res.status(500).json({ message: 'Failed to update blog', error: error.message });
  }
};

const deleteBlog = async (req, res) => {
  try {
    const deleted = await Blog.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Blog not found' });
    res.status(200).json({ message: 'Blog deleted' });
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete blog', error: error.message });
  }
};

// ─── Public ────────────────────────────────────────────────
const getPublicBlogs = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 12);
    const { category, q } = req.query;

    const filter = { status: 'published' };
    if (category && category !== 'All') filter.category = category;
    if (q) filter.$or = [{ title: { $regex: String(q).trim(), $options: 'i' } }, { tags: { $regex: String(q).trim(), $options: 'i' } }];

    const total = await Blog.countDocuments(filter);
    const blogs = await Blog.find(filter)
      .select('-content')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.status(200).json({ blogs, pages: Math.ceil(total / limit) || 1, total });
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch blogs', error: error.message });
  }
};

const getBlogBySlug = async (req, res) => {
  try {
    const blog = await Blog.findOne({ slug: req.params.slug, status: 'published' })
      .populate('comments.user', 'firstName lastName');
    if (!blog) return res.status(404).json({ message: 'Blog post not found' });

    blog.views = (blog.views || 0) + 1;
    await blog.save();

    res.status(200).json(blog);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch blog', error: error.message });
  }
};

// ─── Likes & Comments (authenticated users) ────────────────
const toggleLike = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog post not found' });

    const userId = String(req.user._id);
    const alreadyLiked = blog.likes.some((u) => String(u) === userId);
    if (alreadyLiked) {
      blog.likes = blog.likes.filter((u) => String(u) !== userId);
    } else {
      blog.likes.push(req.user._id);
    }
    await blog.save();

    res.status(200).json({ likesCount: blog.likes.length, liked: !alreadyLiked });
  } catch (error) {
    res.status(500).json({ message: 'Failed to update like', error: error.message });
  }
};

const addComment = async (req, res) => {
  try {
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ message: 'Comment text is required' });

    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog post not found' });

    blog.comments.push({ user: req.user._id, text });
    await blog.save();

    const populated = await Blog.findById(blog._id).populate('comments.user', 'firstName lastName');
    res.status(201).json(populated.comments);
  } catch (error) {
    res.status(500).json({ message: 'Failed to add comment', error: error.message });
  }
};

const deleteComment = async (req, res) => {
  try {
    const blog = await Blog.findById(req.params.id);
    if (!blog) return res.status(404).json({ message: 'Blog post not found' });

    const comment = blog.comments.id(req.params.commentId);
    if (!comment) return res.status(404).json({ message: 'Comment not found' });

    const isOwner = String(comment.user) === String(req.user._id);
    if (!isOwner) return res.status(403).json({ message: 'Not allowed to delete this comment' });

    comment.deleteOne();
    await blog.save();

    const populated = await Blog.findById(blog._id).populate('comments.user', 'firstName lastName');
    res.status(200).json(populated.comments);
  } catch (error) {
    res.status(500).json({ message: 'Failed to delete comment', error: error.message });
  }
};

module.exports = {
  getAdminBlogs,
  createBlog,
  updateBlog,
  deleteBlog,
  getPublicBlogs,
  getBlogBySlug,
  toggleLike,
  addComment,
  deleteComment,
};
