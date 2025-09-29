import { createClient } from '@supabase/supabase-js';

const supaAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Expect `Authorization: Bearer <supabase_access_token>` from the browser.
// We verify it server-side and attach req.user.
export async function requireUser(req, res, next) {
  try {
    const hdr = req.get('authorization') || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing_token' });

    const { data, error } = await supaAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ error: 'bad_token' });

    req.user = data.user; // { id, email, ... }
    next();
  } catch (e) {
    res.status(401).json({ error: 'unauthorized' });
  }
}
