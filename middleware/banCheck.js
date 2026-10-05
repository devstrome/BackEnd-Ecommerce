const Ban = require('../models/Ban');

// Extract the client's IP, preferring the real client behind a proxy/CDN.
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip || req.connection?.remoteAddress || '';
}

// Parse a coarse network identifier (first 3 octets for IPv4) for grouping.
function networkOf(ip) {
  if (!ip) return '';
  const parts = String(ip).split('.');
  if (parts.length === 4) return parts.slice(0, 3).join('.') + '.0/24';
  return ip;
}

// Block account creation / login when the request's IP, device id or browser
// fingerprint appears on the ban list.
async function checkBan(req, res, next) {
  try {
    const ip = clientIp(req);
    const deviceId = String(req.body?.deviceId || '').trim();
    const fingerprint = String(req.body?.fingerprint || '').trim();

    // Expose for the controller to persist on the user/admin record
    req.clientIdent = { ip, deviceId, fingerprint, network: networkOf(ip) };

    const or = [];
    if (ip) or.push({ ip });
    if (deviceId) or.push({ deviceId });
    if (fingerprint) or.push({ fingerprint });
    const network = networkOf(ip);
    if (network) or.push({ network });

    if (!or.length) return next();

    const ban = await Ban.findOne({ active: true, $or: or }).lean();
    if (ban) {
      return res.status(403).json({
        message:
          'This device/network has been banned. Creating a new account or signing in is not allowed.',
        reason: ban.reason || undefined,
        banned: true,
      });
    }
    return next();
  } catch (err) {
    // Fail open — a ban-list lookup error shouldn't block legit users.
    console.error('checkBan error:', err.message);
    return next();
  }
}

module.exports = { checkBan, clientIp, networkOf };
