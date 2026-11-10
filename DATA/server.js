
require("dotenv").config();

const express = require("express");

const app = express();

// Initialize database
require("./server/database/db");

// Import API routes
const usersRouter =
    require("./server/routes/users");

const messagesRouter =
    require("./server/routes/messages");

const logsRouter =
    require("./server/routes/logs");

// Middleware
app.use(express.json({
    limit: "1mb"
}));

// API ROUTES
app.use("/api/users", usersRouter);

app.use("/api/messages", messagesRouter);

app.use("/api/logs", logsRouter);

// HEALTH CHECK
app.get("/", (req, res) => {
    res.json({
        application: "Yahoo Security Messenger",
        status: "running",
        module: "Data Engineering API"
    });
});

// ERROR HANDLER
app.use((err, req, res, next) => {
    console.error(err.message);

    res.status(500).json({
        error: "Internal server error"
    });
});

// START SERVER
const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(
        `Yahoo Security Messenger API running on port ${PORT}`
    );
});