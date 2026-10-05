// Broadcasts admin-side configuration changes to every connected client so
// carts, checkout and coupon UIs update without a page refresh.
let io = null;

function setSocketIO(instance) {
  io = instance;
}

// Room name convention matches index.js: `user_<userId>` / `adminRoom`
const userRoom = (userId) => `user_${String(userId)}`;

function emitStoreEvent(type, payload = {}, event = 'storeChanged') {
  if (!io) return false;
  const body = { type, ...payload, timestamp: new Date().toISOString() };
  io.emit(event, body);
  if (event !== 'storeChanged') io.emit('storeChanged', body);
  return true;
}

// Targeted emit — used for per-user cart refreshes so we don't shout at
// every connected browser.
function emitToUser(userId, type, payload = {}, event = 'cart:updated') {
  if (!io || userId == null) return false;
  io.to(userRoom(userId)).emit(event, {
    type,
    userId: String(userId),
    ...payload,
    timestamp: new Date().toISOString(),
  });
  return true;
}

function emitToAdmins(type, payload = {}, event = 'storeChanged') {
  if (!io) return false;
  io.to('adminRoom').emit(event, {
    type,
    ...payload,
    timestamp: new Date().toISOString(),
  });
  return true;
}

module.exports = { setSocketIO, emitStoreEvent, emitToUser, emitToAdmins, userRoom };
