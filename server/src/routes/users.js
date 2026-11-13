const express = require('express');
const { users, contacts } = require('../database/database');
const { validateUser, validateUserUpdate, USER_STATUSES } = require('../middleware/validation');
const router = express.Router();

router.post('/', validateUser, (req, res, next) => {
  try { res.status(201).json(users.create(req.body)); }
  catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' }); next(error); }
});
router.get('/', (req, res) => res.json(users.getAll()));
router.get('/:id', (req, res) => {
  const user = users.getById(req.params.id);
  return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
});
router.patch('/:id', validateUserUpdate, (req, res, next) => {
  try {
    const user = users.update(req.params.id, req.body);
    return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
  } catch (error) { if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'Username already exists' }); next(error); }
});
router.patch('/:id/status', (req, res) => {
  if (!USER_STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' });
  const user = users.updateStatus(req.params.id, req.body.status);
  return user ? res.json(user) : res.status(404).json({ error: 'User not found' });
});
router.delete('/:id', (req, res) => users.delete(req.params.id) ? res.status(204).end() : res.status(404).json({ error: 'User not found' }));
router.get('/:id/contacts', (req, res) => {
  if (!users.getById(req.params.id)) return res.status(404).json({ error: 'User not found' });
  res.json(contacts.list(req.params.id));
});
router.post('/:id/contacts', (req, res, next) => {
  const { contact_user_id, nickname = null } = req.body;
  if (typeof contact_user_id !== 'string' || !contact_user_id) return res.status(400).json({ error: 'contact_user_id is required' });
  try { res.status(201).json(contacts.add({ user_id: req.params.id, contact_user_id, nickname })); }
  catch (error) { if (error.code?.startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'Could not add contact; check both users exist and are not already contacts' }); next(error); }
});
router.delete('/:id/contacts/:contactId', (req, res) => contacts.remove(req.params.contactId) ? res.status(204).end() : res.status(404).json({ error: 'Contact not found' }));
module.exports = router;