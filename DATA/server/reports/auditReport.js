
const db = require("../database/db");

function generateAuditReport() {

    // Total number of security events
    const total = db.prepare(`
        SELECT COUNT(*) AS total
        FROM SecurityLogs
    `).get();

    // Security events by severity
    const severity = db.prepare(`
        SELECT
            severity,
            COUNT(*) AS total
        FROM SecurityLogs
        GROUP BY severity
    `).all();

    // Security events by AI agent
    const agents = db.prepare(`
        SELECT
            source,
            COUNT(*) AS total
        FROM SecurityLogs
        GROUP BY source
    `).all();

    // Security events by event type
    const eventTypes = db.prepare(`
        SELECT
            event_type,
            COUNT(*) AS total
        FROM SecurityLogs
        GROUP BY event_type
        ORDER BY total DESC
    `).all();

    // Latest critical events
    const critical = db.prepare(`
        SELECT
            log_id,
            event_type,
            severity,
            source,
            description,
            created_at
        FROM SecurityLogs
        WHERE severity = 'CRITICAL'
        ORDER BY created_at DESC
        LIMIT 10
    `).all();

    return {
        generated_at: new Date().toISOString(),

        summary: {
            total_events: total.total
        },

        severity_breakdown: severity,

        agent_breakdown: agents,

        event_type_breakdown: eventTypes,

        recent_critical_events: critical
    };
}

module.exports = generateAuditReport;