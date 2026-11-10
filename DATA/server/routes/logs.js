
const express = require("express");
const router = express.Router();

const {
    createSecurityLog,
    getSecurityLogs,
    getCriticalLogs
} = require("../database/database");

const {
    validateSecurityLog
} = require("../middleware/validation");

const generateAuditReport =
    require("../reports/auditReport");

// CREATE SECURITY EVENT
router.post("/", validateSecurityLog, (req, res) => {
    try {
        const {
            user_id,
            event_type,
            severity,
            source,
            description,
            details
        } = req.body;

        const log = createSecurityLog(
            user_id,
            event_type,
            severity,
            source,
            description,
            details || {}
        );

        res.status(201).json({
            message: "Security event recorded",
            data: log
        });

    } catch (error) {
        res.status(400).json({
            error: "Unable to create security log"
        });
    }
});

// GET AUDIT REPORT
router.get("/report", (req, res) => {
    res.json(generateAuditReport());
});

// GET CRITICAL SECURITY EVENTS
router.get("/critical", (req, res) => {
    res.json({
        logs: getCriticalLogs()
    });
});

// GET ALL SECURITY EVENTS
router.get("/", (req, res) => {
    const limit = Math.min(
        Math.max(Number(req.query.limit) || 50, 1),
        100
    );

    const offset = Math.max(
        Number(req.query.offset) || 0,
        0
    );

    const logs = getSecurityLogs(limit, offset);

    res.json({
        count: logs.length,
        logs
    });
});

module.exports = router;