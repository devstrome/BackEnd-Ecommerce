const SENSITIVE_USER_FIELDS = [
  'password',
  'refreshToken',
  'accessTokens',
  'lastLoginIp',
  'lastDeviceId',
  'lastFingerprint',
  'lastNetwork',
];

function safeUserPayload(user) {
  if (!user) return null;
  const payload = typeof user.toObject === 'function' ? user.toObject({ virtuals: true }) : { ...user };
  for (const field of SENSITIVE_USER_FIELDS) delete payload[field];
  return payload;
}

module.exports = { safeUserPayload, SENSITIVE_USER_FIELDS };
