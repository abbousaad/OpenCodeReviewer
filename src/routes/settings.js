import express from 'express';
import { saveSettings, settingsView } from '../core/settings.js';

const router = express.Router();

router.get('/settings', (req, res) => {
  res.json(settingsView());
});

router.put('/settings', (req, res) => {
  const result = saveSettings(req.body);
  if (result) return res.status(400).json({ error: 'Fix the highlighted settings.', fields: result.fields });
  res.json(settingsView());
});

export default router;
