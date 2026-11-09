
const db = require("./db");
const { randomUUID } = require("crypto");

// ==========================================
// USER FUNCTIONS
// ==========================================

function addUser(username, displayName) {
    const id = randomUUID();

    db.prepare(`
        INSERT INTO Users (
            user_id,
            username,
            display_name
        )
        VALUES (?, ?, ?)
    `).run(id, username, displayName);

    return getUserById(id);
}

function getUserById(userId) {
    return db.prepare(`
        SELECT *
        FROM Users
        WHERE user_id = ?
    `).get(userId);
}

function getAllUsers() {
    return db.prepare(`
        SELECT *
        FROM Users
        ORDER BY username
    `).all();
}

function updateUserStatus(userId, status) {
    return db.prepare(`
        UPDATE Users
        SET status = ?,
            last_seen = CURRENT_TIMESTAMP
        WHERE user_id = ?
    `).run(status, userId);
}

// ==========================================
// CONTACT FUNCTIONS
// ==========================================

function addContact(userId, friendId) {
    const id = randomUUID();

    db.prepare(`
        INSERT INTO Contacts (
            contact_id,
            user_id,
            friend_id
        )
        VALUES (?, ?, ?)
    `).run(id, userId, friendId);

    return db.prepare(`
        SELECT *
        FROM Contacts
        WHERE contact_id = ?
    `).get(id);
}

function getContacts(userId) {
    return db.prepare(`
        SELECT
            c.contact_id,
            c.status AS contact_status,
            u.user_id,
            u.username,
            u.display_name,
            u.status AS online_status
        FROM Contacts c
        JOIN Users u
            ON c.friend_id = u.user_id
        WHERE c.user_id = ?
        ORDER BY u.username
    `).all(userId);
}

// ==========================================
// MESSAGE FUNCTIONS
// ==========================================

function saveMessage(senderId, receiverId, ciphertext, iv) {
    const id = randomUUID();

    db.prepare(`
        INSERT INTO Messages (
            message_id,
            sender_id,
            receiver_id,
            ciphertext,
            iv
        )
        VALUES (?, ?, ?, ?, ?)
    `).run(
        id,
        senderId,
        receiverId,
        ciphertext,
        iv
    );

    return getMessageById(id);
}

function getMessageById(messageId) {
    return db.prepare(`
        SELECT *
        FROM Messages
        WHERE message_id = ?
    `).get(messageId);
}

function getConversation(user1, user2, limit = 50, offset = 0) {
    return db.prepare(`
        SELECT *
        FROM Messages
        WHERE
            (sender_id = ? AND receiver_id = ?)
            OR
            (sender_id = ? AND receiver_id = ?)
        ORDER BY created_at DESC, message_id DESC
        LIMIT ? OFFSET ?
    `).all(
        user1,
        user2,
        user2,
        user1,
        limit,
        offset
    ).reverse();
}

function updateMessageStatus(messageId, status) {
    const columns = {
        delivered: "delivered_at",
        read: "read_at"
    };

    const column = columns[status];

    if (!column) {
        throw new Error("Invalid message status");
    }

    return db.prepare(`
        UPDATE Messages
        SET ${column} = CURRENT_TIMESTAMP
        WHERE message_id = ?
    `).run(messageId);
}

// ==========================================
// SECURITY LOG FUNCTIONS
// ==========================================

function createSecurityLog(
    userId,
    eventType,
    severity,
    source,
    description,
    details = {}
) {
    const id = randomUUID();

    db.prepare(`
        INSERT INTO SecurityLogs (
            log_id,
            user_id,
            event_type,
            severity,
            source,
            description,
            details_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
        id,
        userId || null,
        eventType,
        severity,
        source,
        description,
        JSON.stringify(details)
    );

    return db.prepare(`
        SELECT *
        FROM SecurityLogs
        WHERE log_id = ?
    `).get(id);
}

function getSecurityLogs(limit = 50, offset = 0) {
    return db.prepare(`
        SELECT *
        FROM SecurityLogs
        ORDER BY created_at DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);
}

function getCriticalLogs() {
    return db.prepare(`
        SELECT *
        FROM SecurityLogs
        WHERE severity = 'CRITICAL'
        ORDER BY created_at DESC
    `).all();
}

// ==========================================
// EXPORT ALL FUNCTIONS
// ==========================================

module.exports = {
    addUser,
    getUserById,
    getAllUsers,
    updateUserStatus,

    addContact,
    getContacts,

    saveMessage,
    getMessageById,
    getConversation,
    updateMessageStatus,

    createSecurityLog,
    getSecurityLogs,
    getCriticalLogs
};