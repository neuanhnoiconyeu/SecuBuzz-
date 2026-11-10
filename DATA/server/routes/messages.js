
const express = require("express");
const router = express.Router();

const {
    saveMessage,
    getMessageById,
    getConversation,
    updateMessageStatus
} = require("../database/database");

const {
    validateMessage
} = require("../middleware/validation");

// STORE ENCRYPTED MESSAGE
router.post("/", validateMessage, (req, res) => {
    try {
        const {
            sender_id,
            receiver_id,
            ciphertext,
            iv
        } = req.body;

        const message = saveMessage(
            sender_id,
            receiver_id,
            ciphertext,
            iv
        );

        res.status(201).json({
            message: "Message stored successfully",
            data: message
        });

    } catch (error) {
        res.status(400).json({
            error: "Unable to store message"
        });
    }
});

// GET CONVERSATION HISTORY
router.get("/conversation/:user1/:user2", (req, res) => {
    try {
        const limit = Math.min(
            Math.max(Number(req.query.limit) || 50, 1),
            100
        );

        const offset = Math.max(
            Number(req.query.offset) || 0,
            0
        );

        const messages = getConversation(
            req.params.user1,
            req.params.user2,
            limit,
            offset
        );

        res.json({
            count: messages.length,
            messages
        });

    } catch (error) {
        res.status(500).json({
            error: "Unable to retrieve messages"
        });
    }
});

// GET MESSAGE BY ID
router.get("/:id", (req, res) => {
    const message = getMessageById(req.params.id);

    if (!message) {
        return res.status(404).json({
            error: "Message not found"
        });
    }

    res.json(message);
});

// UPDATE DELIVERY OR READ STATUS
router.patch("/:id/status", (req, res) => {
    try {
        const { status } = req.body;

        if (!["delivered", "read"].includes(status)) {
            return res.status(400).json({
                error: "Invalid message status"
            });
        }

        const result = updateMessageStatus(
            req.params.id,
            status
        );

        if (!result.changes) {
            return res.status(404).json({
                error: "Message not found"
            });
        }

        res.json({
            message: `Message marked as ${status}`
        });

    } catch (error) {
        res.status(500).json({
            error: "Unable to update message"
        });
    }
});

module.exports = router;