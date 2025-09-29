import express from 'express';
import { requireUser } from '../auth.js';
import { receptionistConfigSchema } from '../lib/schema.js';
import { getConfigForUser, upsertConfigForUser } from '../lib/config.js';

const router = express.Router();

// Read my config
router.get('/config', requireUser, async (req, res) => {
  try {
    const cfg = await getConfigForUser(req.user.id);
    res.json(cfg);
  } catch (e) {
    res.status(500).json({ error: 'read_failed' });
  }
});

// Update my config
router.put('/config', requireUser, express.json(), async (req, res) => {
  try {
    const parsed = receptionistConfigSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'invalid', details: parsed.error.flatten() });
    }
    await upsertConfigForUser(req.user.id, parsed.data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'write_failed' });
  }
});

export default router;
