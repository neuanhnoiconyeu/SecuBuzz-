// Backward-compatible facade; all operations share the injected repository implementation.
const db = require('./db');
const { createRepositories } = require('./repositories');
const repositories = createRepositories(db);
module.exports = {
    addUser: (username, displayName) => repositories.users.create({ username, display_name: displayName }),
    getUserById: repositories.users.get,
    getAllUsers: repositories.users.list,
    updateUserStatus: repositories.users.setStatus,
    addContact: repositories.legacy.addContact,
    getContacts: repositories.legacy.getContacts,
    saveMessage: repositories.legacy.saveMessage,
    getMessageById: repositories.messages.get,
    getConversation: repositories.legacy.getConversation,
    updateMessageStatus: repositories.messages.setLegacyStatus,
    createSecurityLog: repositories.legacy.createSecurityLog,
    getSecurityLogs: repositories.legacy.getSecurityLogs,
    getCriticalLogs: repositories.legacy.getCriticalLogs
};
