function customerOwnsRoom(room, userId) {
  const roomCustomerId = room?.customerId?._id || room?.customerId;
  if (!roomCustomerId || !userId) return false;
  return String(roomCustomerId) === String(userId?._id || userId);
}

module.exports = { customerOwnsRoom };
