import { createHash, timingSafeEqual } from 'node:crypto';

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function safeEqual(a, b) {
  if (a == null || b == null) return false;
  return timingSafeEqual(digest(a), digest(b));
}

const AGENT_ROUTES = [
  ['GET', /^\/api\/catalog$/],
  ['GET', /^\/api\/state$/],
  ['POST', /^\/api\/purchases$/],
  ['POST', /^\/api\/purchases\/preview$/],
  ['GET', /^\/api\/purchases\/[\w-]+$/],
];

export function isAgentRoute(method, path) {
  return AGENT_ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

function basicPassword(header) {
  const match = /^Basic (.+)$/i.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  return decoded.slice(decoded.indexOf(':') + 1);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const PURCHASE_WRITE = /^\/api\/purchases(\/preview)?$/i;

// Browsers can send cross-site form posts with ambient credentials, but not JSON without a CORS preflight.
export function isCrossSiteWrite(req) {
  if (SAFE_METHODS.has(req.method)) return false;
  if (req.get('sec-fetch-site') === 'cross-site') return true;
  return !(req.get('content-type') ?? '').toLowerCase().startsWith('application/json');
}

export function createAccessControl({ dashboardPassword, agentKey }) {
  return function accessControl(req, res, next) {
    if (isCrossSiteWrite(req)) {
      return res.status(403).json({ error: 'Write requests must be same-site JSON requests' });
    }
    const isOwner = !dashboardPassword || safeEqual(basicPassword(req.get('authorization')), dashboardPassword);
    const isAgent = Boolean(agentKey) && safeEqual(req.get('x-leash-agent-key'), agentKey);
    const agentRoute = isAgentRoute(req.method, req.path);

    if (agentRoute && isAgent) return next();
    if (req.method === 'POST' && PURCHASE_WRITE.test(req.path.replace(/\/+$/, '')) && agentKey && !dashboardPassword) {
      return res.status(401).json({ error: 'Missing or invalid x-leash-agent-key header' });
    }
    if (isOwner) return next();

    res.set('WWW-Authenticate', 'Basic realm="Leash", charset="UTF-8"');
    return res.status(401).json({ error: 'Authentication required' });
  };
}
