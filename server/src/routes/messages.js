const express = require('express');
const { users, messages } = require('../database/database');
const { validateMessage } = require('../middleware/validation');
const router = express.Router();

router.post('/', validateMessage, (req, res, next) => {
  try {
    if (!users.getById(req.body.sender_id) || !users.getById(req.body.recipient_id)) return res.status(400).json({ error: 'Sender and recipient must exist' });
    // The client performs E2EE. Store ciphertext/IV only; never accept plaintext here.
    res.status(201).json(messages.create(req.body));
  } catch (error) { next(error); }
});
router.get('/conversation/:userA/:userB', (req, res) => {
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '100', 10) || 100, 1), 500);
  res.json(messages.getConversation(req.params.userA, req.params.userB, limit));
});
router.get('/:id', (req, res) => {
  const message = messages.getById(req.params.id);
  return message ? res.json(message) : res.status(404).json({ error: 'Message not found' });
});
router.patch('/:id/delivered', (req, res) => {
  const message = messages.markDelivered(req.params.id);
  return message ? res.json(message) : res.status(404).json({ error: 'Message not found' });
});
router.patch('/:id/read', (req, res) => {
  const message = messages.markRead(req.params.id);
  return message ? res.json(message) : res.status(404).json({ error: 'Message not found' });
});
router.delete('/:id', (req, res) => messages.delete(req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'Message not found' }));
module.exports = router;