const express = require('express');
const http = require('http');
const wsManager = require('./websocket');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);

// Store uploaded pack in memory
let uploadedPack = null;

// Initialize WebSocket
wsManager.initialize(server);

// Middleware
app.use(cors({
  origin: config.corsOrigin
}));
app.use(express.json({ limit: '250mb' }));

// Store connected clients
const clients = new Set();

// WebSocket connection handler
wsManager.wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('Client connected');

    // Send welcome message to the new client
    ws.send(JSON.stringify({
        type: 'system',
        message: 'Welcome to the chatix!'
    }));

    ws.on('message', (message) => {
        try {
            const messageStr = message.toString();
            console.log('Received message:', messageStr);
            
            // Broadcast message to all connected clients
            clients.forEach((client) => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(JSON.stringify({
                        type: 'message',
                        content: messageStr,
                        timestamp: new Date().toISOString()
                    }));
                }
            });
        } catch (error) {
            console.error('Error handling message:', error);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('Client disconnected');
    });
});

// Root route handler
app.get('/', (req, res) => {
    res.json({ message: 'WebSocket Chat Server is running' });
});

// Get online users endpoint
app.get('/api/users/online', (req, res) => {
    const onlineUsers = wsManager.getOnlineUsers();
    res.json({
        status: 'success',
        data: onlineUsers
    });
});

// Update user score endpoint
app.post('/api/users/:userId/score', express.json(), (req, res) => {
    const { userId } = req.params;
    const { score } = req.body;

    if (typeof score !== 'number') {
        return res.status(400).json({
            status: 'error',
            message: 'Score must be a number'
        });
    }

    const userData = wsManager.persistentUsers.get(userId);
    if (!userData) {
        return res.status(404).json({
            status: 'error',
            message: 'User not found'
        });
    }

    // Update the score
    userData.score = score;
    wsManager.persistentUsers.set(userId, userData);

    // Broadcast the updated user list to all clients
    wsManager.broadcastOnlineUsers();

    res.json({
        status: 'success',
        data: userData
    });
});

// Sample JSON API endpoints
app.get('/api/messages', (req, res) => {
    res.json({
        messages: [
            { id: 1, text: 'Hello from server!' },
            { id: 2, text: 'This is a sample message' }
        ]
    });
});

// Serve static JSON files
app.get('/api/data', (req, res) => {
    res.json({
        status: 'success',
        data: {
            timestamp: new Date().toISOString(),
            message: 'This is a sample JSON response'
        }
    });
});

// Serve pack.json
app.get('/api/pack', (req, res) => {
    // If there's an uploaded pack, serve it
    if (uploadedPack) {
        return res.json(uploadedPack);
    }
    
    // Otherwise serve the default pack1.json
    fs.readFile(path.join(__dirname, 'pack1.json'), 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ error: 'Could not read pack1.json' });
        }
        try {
            const pack = JSON.parse(data);
            res.json(pack);
        } catch (e) {
            res.status(500).json({ error: 'Invalid JSON in pack1.json' });
        }
    });
});

// Upload new pack endpoint
app.post('/api/pack/upload', express.json(), (req, res) => {
    try {
        // Validate that the request body is a valid pack
        if (!req.body || typeof req.body !== 'object') {
            return res.status(400).json({ error: 'Invalid pack format' });
        }

        // Store the pack in memory
        uploadedPack = req.body;
        
        res.json({
            status: 'success',
            message: 'Pack uploaded successfully'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Failed to upload pack',
            error: error.message
        });
    }
});

// Get times for a specific question
app.get('/api/questions/:questionId/times', (req, res) => {
  const questionId = parseInt(req.params.questionId);
  const times = wsManager.getQuestionTimes(questionId);
  res.json({
    status: 'success',
    data: Object.fromEntries(times)
  });
});

// Get last user with green frame
app.get('/api/game/last-green-frame', (req, res) => {
  const lastGreenFrameUser = wsManager.getLastGreenFrameUser();
  res.json({
    status: 'success',
    data: {
      userId: lastGreenFrameUser
    }
  });
});

// Start the server
server.listen(config.port, () => {
    console.log(`Server is running on port ${config.port}`);
}); 