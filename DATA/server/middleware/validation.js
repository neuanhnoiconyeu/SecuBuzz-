
function validateUser(req, res, next) {
    const { username, display_name } = req.body;

    if (
        typeof username !== "string" ||
        typeof display_name !== "string" ||
        !username.trim() ||
        !display_name.trim() ||
        username.length > 50 ||
        display_name.length > 100
    ) {
        return res.status(400).json({
            error: "Invalid username or display name"
        });
    }

    next();
}

function validateMessage(req, res, next) {
    const {
        sender_id,
        receiver_id,
        ciphertext,
        iv
    } = req.body;

    if (
        typeof sender_id !== "string" ||
        typeof receiver_id !== "string" ||
        sender_id === receiver_id ||
        typeof ciphertext !== "string" ||
        !ciphertext ||
        ciphertext.length > 1000000 ||
        typeof iv !== "string" ||
        !iv
    ) {
        return res.status(400).json({
            error: "Invalid encrypted message"
        });
    }

    next();
}

function validateSecurityLog(req, res, next) {
    const {
        event_type,
        severity,
        source,
        description
    } = req.body;

    const severities = [
        "LOW",
        "MEDIUM",
        "HIGH",
        "CRITICAL"
    ];

    const sources = [
        "auditor_bot",
        "sentinel_bot",
        "buzz_guard"
    ];

    if (
        typeof event_type !== "string" ||
        !event_type.trim() ||
        !severities.includes(severity) ||
        !sources.includes(source) ||
        typeof description !== "string" ||
        !description.trim()
    ) {
        return res.status(400).json({
            error: "Invalid security log"
        });
    }

    next();
}

module.exports = {
    validateUser,
    validateMessage,
    validateSecurityLog
};