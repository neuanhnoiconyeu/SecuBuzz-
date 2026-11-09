
const express = require("express");
const router = express.Router();

const {
    addUser,
    getUserById,
    getAllUsers,
    updateUserStatus,
    addContact,
    getContacts
} = require("../database/database");

const {
    validateUser
} = require("../middleware/validation");

// CREATE USER
router.post("/", validateUser, (req, res) => {
    try {
        const { username, display_name } = req.body;

        const user = addUser(
            username.trim(),
            display_name.trim()
        );

        res.status(201).json(user);

    } catch (error) {
        res.status(400).json({
            error: "Unable to create user"
        });
    }
});

// GET ALL USERS
router.get("/", (req, res) => {
    res.json(getAllUsers());
});

// GET USER BY ID
router.get("/:id", (req, res) => {
    const user = getUserById(req.params.id);

    if (!user) {
        return res.status(404).json({
            error: "User not found"
        });
    }

    res.json(user);
});

// UPDATE USER STATUS
router.patch("/:id/status", (req, res) => {
    const { status } = req.body;

    if (!["online", "offline", "away"].includes(status)) {
        return res.status(400).json({
            error: "Invalid status"
        });
    }

    const result = updateUserStatus(
        req.params.id,
        status
    );

    if (!result.changes) {
        return res.status(404).json({
            error: "User not found"
        });
    }

    res.json({
        message: "User status updated",
        status
    });
});

// ADD CONTACT
router.post("/:id/contacts", (req, res) => {
    try {
        const { friend_id } = req.body;

        if (typeof friend_id !== "string" || !friend_id) {
            return res.status(400).json({
                error: "friend_id is required"
            });
        }

        const contact = addContact(
            req.params.id,
            friend_id
        );

        res.status(201).json(contact);

    } catch (error) {
        res.status(400).json({
            error: "Unable to add contact"
        });
    }
});

// GET CONTACTS
router.get("/:id/contacts", (req, res) => {
    res.json(getContacts(req.params.id));
});

module.exports = router;