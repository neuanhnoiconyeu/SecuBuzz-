const express = require('express');
const { logs } = require('../database/database');
const { validateLog, SEVERITIES } = require('../middleware/validation');
const router = express.Router();

router.post('/', validateLog, (req, res, next) => {
  try { res.status(201).json(logs.create(req.body)); }
  catch (error) { next(error); }
});
router.get('/', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  if (req.query.severity && !SEVERITIES.includes(req.query.severity)) return res.status(400).json({ error: 'Invalid severity' });
  res.json(logs.list({ severity: req.query.severity, limit }));
});
router.get('/:id', (req, res) => {
  const log = logs.getById(req.params.id);
  return log ? res.json(log) : res.status(404).json({ error: 'Security log not found' });
});
module.exports = router;