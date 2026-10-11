const idOf = (value) => {
  const id = value && typeof value === 'object' ? value._id || value.id : value;
  return id == null ? '' : String(id);
};

const ownsOrder = (order, authenticatedUserId) => {
  const ownerId = idOf(order?.userId);
  const userId = idOf(authenticatedUserId);
  return Boolean(ownerId && userId && ownerId === userId);
};

const customerOrdersFilter = (authenticatedUserId) => {
  const userId = idOf(authenticatedUserId);
  return userId ? { userId } : null;
};

module.exports = { ownsOrder, customerOrdersFilter };
