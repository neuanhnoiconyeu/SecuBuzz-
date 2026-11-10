
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const testDbPath = path.join(
    __dirname,
    "test-database.sqlite"
);

process.env.DB_PATH = testDbPath;

const db = require("../server/database/db");

const {
    addUser,
    getUserById,
    updateUserStatus,
    saveMessage,
    getConversation,
    createSecurityLog,
    getCriticalLogs
} = require("../server/database/database");

before(() => {
    db.exec("DELETE FROM SecurityLogs");
    db.exec("DELETE FROM Messages");
    db.exec("DELETE FROM Contacts");
    db.exec("DELETE FROM Users");
});

test("Create and retrieve a user", () => {
    const user = addUser("henry", "Henry Nguyen");

    assert.equal(user.username, "henry");
    assert.equal(user.status, "offline");

    const retrieved = getUserById(user.user_id);

    assert.equal(retrieved.username, "henry");
});

test("Update user online status", () => {
    const user = addUser("alice", "Alice");

    updateUserStatus(user.user_id, "online");

    const updated = getUserById(user.user_id);

    assert.equal(updated.status, "online");
});

test("Store and retrieve encrypted messages", () => {
    const sender = addUser("bob", "Bob");
    const receiver = addUser("charlie", "Charlie");

    saveMessage(
        sender.user_id,
        receiver.user_id,
        "encrypted_payload",
        "test_iv"
    );

    const messages = getConversation(
        sender.user_id,
        receiver.user_id
    );

    assert.equal(messages.length, 1);
    assert.equal(
        messages[0].ciphertext,
        "encrypted_payload"
    );
});

test("Record a critical security event", () => {
    createSecurityLog(
        null,
        "SQL_INJECTION_DETECTED",
        "CRITICAL",
        "auditor_bot",
        "Potential SQL injection detected",
        { file: "login.js" }
    );

    const logs = getCriticalLogs();

    assert.ok(logs.length > 0);
    assert.equal(logs[0].severity, "CRITICAL");
});

after(() => {
    db.close();

    for (const suffix of ["", "-wal", "-shm"]) {
        const file = testDbPath + suffix;

        if (fs.existsSync(file)) {
            fs.unlinkSync(file);
        }
    }
});