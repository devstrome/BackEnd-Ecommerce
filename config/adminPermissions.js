const ADMIN_PERMISSION_CODES = Object.freeze([
  'dashboard', 'inbox', 'admins', 'users', 'products', 'orders', 'courier',
  'checkoutRules', 'contacts', 'blogs', 'inventory', 'finance', 'partnership',
  'viewers', 'pos', 'posOrders', 'wishlists', 'loyalty', 'seo', 'heroSlides',
  'announcements', 'help', 'newsletters', 'contactSettings',
]);

const PERMISSION_LABELS = Object.freeze({
  dashboard: 'Dashboard', inbox: 'Inbox', admins: 'Admin management', users: 'Users',
  products: 'Products and catalog', orders: 'Orders', courier: 'Courier shipments',
  checkoutRules: 'Checkout rules', contacts: 'Contact messages', blogs: 'Blog posts',
  inventory: 'Inventory management', finance: 'Finance', partnership: 'Partnership',
  viewers: 'Live viewers', pos: 'Point of sale', posOrders: 'POS orders',
  wishlists: 'Wishlists', loyalty: 'Loyalty and gift codes', seo: 'SEO optimizer',
  heroSlides: 'Hero slides', announcements: 'Announcements', help: 'Help pages',
  newsletters: 'Newsletters', contactSettings: 'Contact settings',
});

// Only consulted for requests that already passed authenticateAdmin. Public
// storefront endpoints do not use this middleware and remain unaffected.
const permissionForAdminRequest = (req) => {
  const pathname = String(req.originalUrl || req.path || '').split('?')[0].toLowerCase();
  const method = String(req.method || 'GET').toUpperCase();
  if (pathname.includes('/admin/notifications/count')) return null;
  if (/\/api\/admin\/(me|logout|verify-token|refresh-token)(\/|$)/.test(pathname)) return null;
  if (pathname.startsWith('/api/admin/contacts') || pathname === '/api/admin/stats' || pathname === '/api/admin/export') return 'contacts';
  if (pathname.startsWith('/api/admin/orders') || pathname.startsWith('/api/allorders') || pathname.startsWith('/api/order')) return 'orders';
  if (pathname.startsWith('/api/admin/finance')) return 'finance';
  if (pathname.startsWith('/api/admin/loyalty')) return 'loyalty';
  if (pathname.startsWith('/api/admin/blog')) return method === 'GET' ? ['blogs', 'seo'] : 'blogs';
  if (pathname.startsWith('/api/admin/help-pages')) return 'help';
  if (pathname.startsWith('/api/admin/hero-slides')) return 'heroSlides';
  if (pathname.startsWith('/api/admin/announcements')) return 'announcements';
  if (pathname.startsWith('/api/admin/newsletters') || pathname.startsWith('/api/admin/subscribers')) return 'newsletters';
  if (pathname.startsWith('/api/admin/wishlists')) return 'wishlists';
  if (pathname.startsWith('/api/admin/users/subscribe-all')) return 'newsletters';
  if (pathname.startsWith('/api/admin/cart')) return 'users';
  if (pathname.startsWith('/api/admin/popup-ads')) return 'announcements';
  if (pathname === '/api/upload/image') return '__assigned__';
  if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) return '__unmapped__';
  if (pathname === '/api/pos/stats' || pathname === '/api/pos/recent-orders' || /\/api\/pos\/orders\/[^/]+\/receipt$/.test(pathname)) {
    return ['pos', 'posOrders'];
  }
  if (pathname.startsWith('/api/pos/orders')) {
    return method === 'POST' && pathname === '/api/pos/orders' ? 'pos' : 'posOrders';
  }
  if (pathname.startsWith('/api/pos')) return 'pos';
  if (pathname.startsWith('/api/courier')) return 'courier';
  if (pathname.startsWith('/api/contact-settings')) return 'contactSettings';
  if (pathname.startsWith('/api/contact')) return 'contacts';
  if (pathname.startsWith('/api/checkout-rules')) return 'checkoutRules';
  if (pathname.startsWith('/api/shipping') || pathname.startsWith('/api/delivery-setting')) return 'checkoutRules';
  if (pathname.startsWith('/api/loyalty')) return 'loyalty';
  if (pathname.startsWith('/api/finance')) return 'finance';
  if (pathname.startsWith('/api/inventory')) return 'inventory';
  if (pathname.startsWith('/api/partnership')) return 'partnership';
  if (pathname.startsWith('/api/seo')) return 'seo';
  if (pathname.startsWith('/api/hero-slides') || pathname.startsWith('/api/top-rated')) return 'heroSlides';
  if (pathname.startsWith('/api/announcements')) return 'announcements';
  if (pathname.startsWith('/api/help')) return 'help';
  if (pathname.startsWith('/api/subscribers') || pathname.startsWith('/api/newsletter')) return 'newsletters';
  if (pathname.startsWith('/api/blog')) return 'blogs';
  if (pathname.startsWith('/api/orders') || pathname === '/api/order' || pathname.startsWith('/api/allorders')) return 'orders';
  if (pathname.startsWith('/api/products')) return 'products';
  if (pathname.startsWith('/api/users')) return 'users';
  if (pathname.startsWith('/api/wishlist')) return 'wishlists';
  if (pathname.startsWith('/api/dashboard/viewers')) return 'viewers';
  if (pathname.startsWith('/api/dashboard')) return 'dashboard';
  if (pathname.startsWith('/api/viewers')) return 'viewers';
  if (/^\/api\/(regions|colors|sizes|genders|badges|measure-types|related-products|brands|categories|coupons|relatedproduct|create-related-product|createrelatedproduct|updaterelatedproduct|deleterelatedproduct)(\/|$)/.test(pathname)) return pathname.startsWith('/api/coupons') ? 'checkoutRules' : 'products';
  if (/^\/api\/(createslides|updateslides|deleteslides|topratedslides|createtopratedslides|updatetopratedslides|deletetopratedslides)(\/|$)/.test(pathname)) return 'heroSlides';
  if (pathname.startsWith('/api/chat')) return 'inbox';
  if (pathname.startsWith('/api/rooms')) return 'inbox';
  if (pathname.startsWith('/api/bans')) return pathname.includes('/admin') ? 'admins' : 'users';
  if (pathname.startsWith('/api/cron')) return '__super_admin__';
  if (pathname.startsWith('/api/admins/search')) return 'inbox';
  if (pathname === '/api/units' || pathname.startsWith('/api/units/')) return 'products';
  return '__unmapped__';
};

module.exports = { ADMIN_PERMISSION_CODES, PERMISSION_LABELS, permissionForAdminRequest };
