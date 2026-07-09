const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const DB_FILE = path.join(__dirname, 'database.json');

app.use(express.static('public'));
app.use(express.json());

// Target Super Admin Configuration
const ADMIN_EMAIL = "anuragnarkhede02@gmail.com";

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        const initialData = { users: {}, chats: {} };
        fs.writeFileSync(DB_FILE, JSON.stringify(initialData, null, 2));
        return initialData;
    }
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDatabase(data) {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

// --- TEEN PATTI CARD ENGINE ---
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = [
    { label: '2', weight: 2 }, { label: '3', weight: 3 }, { label: '4', weight: 4 },
    { label: '5', weight: 5 }, { label: '6', weight: 6 }, { label: '7', weight: 7 },
    { label: '8', weight: 8 }, { label: '9', weight: 9 }, { label: '10', weight: 10 },
    { label: 'J', weight: 11 }, { label: 'Q', weight: 12 }, { label: 'K', weight: 13 },
    { label: 'A', weight: 14 }
];

function createDeck() {
    let deck = [];
    for (let suit of SUITS) {
        for (let val of VALUES) {
            deck.push({ suit: suit, label: val.label, weight: val.weight, color: (suit === '♥' || suit === '♦') ? 'red' : 'black' });
        }
    }
    return deck;
}

function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function getHandScore(cards) {
    let c = [...cards].sort((a, b) => b.weight - a.weight);
    let isTrio = c[0].weight === c[1].weight && c[1].weight === c[2].weight;
    let isColor = c[0].suit === c[1].suit && c[1].suit === c[2].suit;
    let isSeq = (c[0].weight - c[1].weight === 1 && c[1].weight - c[2].weight === 1) || (c[0].weight === 14 && c[1].weight === 3 && c[2].weight === 2);
    if (isTrio) return { tier: 6, primary: c[0].weight, label: "Trio / Set" };
    if (isSeq && isColor) return { tier: 5, primary: c[0].weight, label: "Pure Sequence" };
    if (isSeq) return { tier: 4, primary: c[0].weight, label: "Sequence" };
    if (isColor) return { tier: 3, primary: c[0].weight, label: "Color / Flush" };
    if (c[0].weight === c[1].weight || c[1].weight === c[2].weight || c[0].weight === c[2].weight) {
        let pairW = (c[0].weight === c[1].weight) ? c[0].weight : c[2].weight;
        return { tier: 2, primary: pairW, label: "Pair" };
    }
    return { tier: 1, primary: c[0].weight, label: "High Card" };
}

function compareHands(p1, p2) {
    let s1 = getHandScore(p1.cards);
    let s2 = getHandScore(p2.cards);
    if (s1.tier !== s2.tier) return s1.tier > s2.tier ? p1 : p2;
    return s1.primary > s2.primary ? p1 : p2;
}

let tables = {}; 
let socketUserMap = {}; 

function createDefaultStats() {
    return { gamesPlayed: 0, gamesWon: 0, winPercentage: 0, level: 1 };
}

// --- SECURE AUTH CHANNELS ---
app.post('/api/google-auth', (req, res) => {
    const { name, email } = req.body;
    let db = loadDatabase();
    let userKey = email.replace(/[.$#[\]]/g, "_"); 
    const checkAdmin = (email.toLowerCase() === ADMIN_EMAIL.toLowerCase());

    if (db.users[userKey]) {
        db.users[userKey].isAdmin = checkAdmin;
        saveDatabase(db);
        return res.json(db.users[userKey]);
    }

    const uniqueId = "TP-" + crypto.randomBytes(3).toString('hex').toUpperCase();
    const newUser = {
        username: name,
        email: email,
        password: "OAuth_Verified_Google",
        chips: 1000,
        playerId: uniqueId,
        friends: [],
        requests: [],
        isAdmin: checkAdmin,
        stats: createDefaultStats()
    };
    db.users[userKey] = newUser;
    saveDatabase(db);
    res.json(newUser);
});

app.post('/api/email-register', (req, res) => {
    const { email, password } = req.body;
    let db = loadDatabase();
    let userKey = email.replace(/[.$#[\]]/g, "_");

    if (db.users[userKey]) return res.status(400).json({ error: "Account already exists!" });

    const username = email.split('@')[0];
    const uniqueId = "TP-" + crypto.randomBytes(3).toString('hex').toUpperCase();
    const checkAdmin = (email.toLowerCase() === ADMIN_EMAIL.toLowerCase());

    db.users[userKey] = {
        username: username,
        email: email,
        password: password, 
        chips: 1000,
        playerId: uniqueId,
        friends: [],
        requests: [],
        isAdmin: checkAdmin,
        stats: createDefaultStats()
    };
    saveDatabase(db);
    res.json(db.users[userKey]);
});

app.post('/api/email-login', (req, res) => {
    const { email, password } = req.body;
    let db = loadDatabase();
    let userKey = email.replace(/[.$#[\]]/g, "_");
    let user = db.users[userKey];

    if (!user || user.password !== password) return res.status(400).json({ error: "Invalid credentials!" });
    res.json(user);
});

// --- CORE SOCKET MULTIPLAYER PIPELINE ---
io.on('connection', (socket) => {

    socket.on('register-socket', (username) => {
        socketUserMap[socket.id] = username;
        socket.join(`user_${username}`);
        
        let db = loadDatabase();
        let requestingUser = Object.values(db.users).find(u => u.username === username);
        
        if (requestingUser) {
            if (requestingUser.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
                requestingUser.isAdmin = true;
                saveDatabase(db);
            }
            if (requestingUser.isAdmin) {
                socket.emit('admin-users-data', { users: db.users, chats: db.chats || {} });
            }
        }
    });

    // 👥 FIXED LOOKUP FRIEND SYSTEM WITH CASE INSENSITIVE UPPERCASE FALLBACKS
    socket.on('search-friend', (searchId) => {
        let db = loadDatabase();
        let targetUser = Object.values(db.users).find(u => u.playerId && u.playerId.toUpperCase() === searchId.trim().toUpperCase());
        
        if (!targetUser) {
            return socket.emit('search-result', { error: "Player ID not found inside database registry!" });
        }
        socket.emit('search-result', { username: targetUser.username, playerId: targetUser.playerId });
    });

    socket.on('send-friend-request', (targetId) => {
        let db = loadDatabase();
        let senderUsername = socketUserMap[socket.id];
        let targetUser = Object.values(db.users).find(u => u.playerId && u.playerId.toUpperCase() === targetId.toUpperCase());
        
        if (targetUser && senderUsername !== targetUser.username) {
            if (!targetUser.requests) targetUser.requests = [];
            if (!targetUser.friends) targetUser.friends = [];

            if (!targetUser.requests.includes(senderUsername) && !targetUser.friends.includes(senderUsername)) {
                targetUser.requests.push(senderUsername);
                saveDatabase(db);
                
                io.to(`user_${targetUser.username}`).emit('refresh-profile-data');
                io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
            }
        }
    });

    socket.on('respond-request', ({ requester, action }) => {
        let db = loadDatabase();
        let myUsername = socketUserMap[socket.id];
        
        let me = Object.values(db.users).find(u => u.username === myUsername);
        let them = Object.values(db.users).find(u => u.username === requester);

        if (!me || !them) return;
        if (!me.requests) me.requests = [];
        if (!me.friends) me.friends = [];
        if (!them.friends) them.friends = [];

        me.requests = me.requests.filter(r => r !== requester);

        if (action === 'accept') {
            if (!me.friends.includes(requester)) me.friends.push(requester);
            if (!them.friends.includes(myUsername)) them.friends.push(myUsername);
        }
        saveDatabase(db);
        socket.emit('refresh-profile-data');
        io.to(`user_${requester}`).emit('refresh-profile-data');
        io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
    });

    socket.on('get-latest-profile', (username) => {
        let db = loadDatabase();
        let foundUser = Object.values(db.users).find(u => u.username === username);
        if (foundUser) socket.emit('profile-data-update', foundUser);
    });

    // 💬 REALTIME PRIVATE CHAT LOG MEMORY
    socket.on('get-friend-chat-history', ({ friendName }) => {
        let myUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        if(!db.chats) db.chats = {};
        
        let chatKey = [myUsername, friendName].sort().join("%%");
        let history = db.chats[chatKey] || [];
        socket.emit('friend-chat-history-loaded', { friendName, history });
    });

    socket.on('send-friend-message', ({ friendName, messageText }) => {
        let myUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        if(!db.chats) db.chats = {};

        let chatKey = [myUsername, friendName].sort().join("%%");
        if(!db.chats[chatKey]) db.chats[chatKey] = [];

        let msgObj = { sender: myUsername, msg: messageText, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
        db.chats[chatKey].push(msgObj);
        saveDatabase(db);

        io.to(`user_${myUsername}`).emit('inbound-friend-msg', { friendName: friendName, msgObj });
        io.to(`user_${friendName}`).emit('inbound-friend-msg', { friendName: myUsername, msgObj });
        io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats });
    });

    socket.on('send-table-chat', ({ tableId, messageText }) => {
        let myUsername = socketUserMap[socket.id];
        let msgObj = { sender: myUsername, msg: messageText, time: new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) };
        io.to(tableId).emit('inbound-table-msg', msgObj);
    });

    // 🎰 LOUNGE MATCH MATCHING TABLES
    socket.on('create-table', () => {
        let myUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        let foundUser = Object.values(db.users).find(u => u.username === myUsername);
        let tableId = crypto.randomBytes(3).toString('hex').toUpperCase();

        tables[tableId] = {
            id: tableId,
            host: socket.id,
            players: [{ id: socket.id, username: myUsername, chips: foundUser.chips, cards: [], status: 'lobby' }],
            pot: 0,
            currentTurnIndex: 0,
            chaalAmount: 10,
            isActive: false
        };

        socket.join(tableId);
        socket.emit('table-joined', tables[tableId]);
    });

    socket.on('join-table', (tableId) => {
        let myUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        let foundUser = Object.values(db.users).find(u => u.username === myUsername);
        let t = tables[tableId];

        if (!t) return socket.emit('table-error', "Invalid Table ID Room!");
        if (t.players.some(p => p.username === myUsername)) return;

        t.players.push({ id: socket.id, username: myUsername, chips: foundUser.chips, cards: [], status: 'lobby' });
        socket.join(tableId);
        io.to(tableId).emit('table-updated', t);
        socket.emit('table-joined', t);
    });

    socket.on('start-table-match', (tableId) => {
        let t = tables[tableId];
        if (!t || t.host !== socket.id || t.players.length < 2) return;

        let deck = shuffleDeck(createDeck());
        t.pot = t.players.length * 10;
        t.currentTurnIndex = 0;
        t.isActive = true;

        let db = loadDatabase();
        t.players.forEach(p => {
            p.cards = [deck.pop(), deck.pop(), deck.pop()];
            p.status = 'playing';
            p.chips -= 10;
            
            let matchedRecord = Object.values(db.users).find(u => u.username === p.username);
            if (matchedRecord) {
                matchedRecord.chips = p.chips;
                if(!matchedRecord.stats) matchedRecord.stats = createDefaultStats();
                matchedRecord.stats.gamesPlayed++;
            }
        });
        saveDatabase(db);
        io.to(tableId).emit('match-started', t);
        io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
    });

    socket.on('table-chaal', (tableId) => {
        let t = tables[tableId];
        if (!t) return;
        let activePlayer = t.players[t.currentTurnIndex];
        if (activePlayer.id !== socket.id) return;

        activePlayer.chips -= t.chaalAmount;
        t.pot += t.chaalAmount;

        let db = loadDatabase();
        let matchedRecord = Object.values(db.users).find(u => u.username === activePlayer.username);
        if (matchedRecord) matchedRecord.chips = activePlayer.chips;
        saveDatabase(db);

        do {
            t.currentTurnIndex = (t.currentTurnIndex + 1) % t.players.length;
        } while (t.players[t.currentTurnIndex].status !== 'playing');

        io.to(tableId).emit('match-state-updated', t);
    });

    function resolveMatchWinner(tableId, winnerUsername, reason) {
        let t = tables[tableId];
        let db = loadDatabase();

        t.players.forEach(p => {
            let record = Object.values(db.users).find(u => u.username === p.username);
            if (!record) return;

            if (p.username === winnerUsername) {
                p.chips += t.pot;
                record.chips = p.chips;
                record.stats.gamesWon++;
            }
            record.stats.winPercentage = Math.round((record.stats.gamesWon / record.stats.gamesPlayed) * 100);
            record.stats.level = Math.floor(record.stats.gamesWon / 10) + 1;
        });

        saveDatabase(db);
        io.to(tableId).emit('match-ended', { winner: winnerUsername, reason, pot: t.pot });
        t.isActive = false;
        io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
    }

    socket.on('table-pack', (tableId) => {
        let t = tables[tableId];
        if (!t) return;
        let activePlayer = t.players[t.currentTurnIndex];
        if (activePlayer.id !== socket.id) return;

        activePlayer.status = 'packed';
        let survivors = t.players.filter(p => p.status === 'playing');

        if (survivors.length === 1) {
            resolveMatchWinner(tableId, survivors[0].username, "Everyone else packed.");
            return;
        }

        do {
            t.currentTurnIndex = (t.currentTurnIndex + 1) % t.players.length;
        } while (t.players[t.currentTurnIndex].status !== 'playing');

        io.to(tableId).emit('match-state-updated', t);
    });

    socket.on('table-show', (tableId) => {
        let t = tables[tableId];
        if (!t) return;

        let survivors = t.players.filter(p => p.status === 'playing');
        if (survivors.length !== 2) return;

        let winObj = compareHands(survivors[0], survivors[1]);
        resolveMatchWinner(tableId, winObj.username, "Showdown complete!");
    });

    // --- SUPER ADMIN DIRECT OPERATIONS ---
    socket.on('admin-add-chips-action', ({ targetPlayerId, chipAmount }) => {
        let senderUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        let exec = Object.values(db.users).find(u => u.username === senderUsername);
        if (!exec || !exec.isAdmin) return;

        let target = Object.values(db.users).find(u => u.playerId === targetPlayerId);
        if (target) {
            target.chips += parseInt(chipAmount);
            saveDatabase(db);
            io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
            io.to(`user_${target.username}`).emit('refresh-profile-data');
        }
    });

    socket.on('admin-remove-user-action', ({ targetPlayerId }) => {
        let senderUsername = socketUserMap[socket.id];
        let db = loadDatabase();
        let exec = Object.values(db.users).find(u => u.username === senderUsername);
        if (!exec || !exec.isAdmin) return;

        let matchKey = Object.keys(db.users).find(k => db.users[k].playerId === targetPlayerId);
        if (matchKey) {
            let deletedUsername = db.users[matchKey].username;
            delete db.users[matchKey];
            saveDatabase(db);
            
            io.emit('refresh-admin-dashboard', { users: db.users, chats: db.chats || {} });
            io.to(`user_${deletedUsername}`).emit('force-logout-eviction');
        }
    });

    socket.on('leave-table-room', (tableId) => {
        socket.leave(tableId);
        if (tables[tableId]) {
            tables[tableId].players = tables[tableId].players.filter(p => p.id !== socket.id);
            if (tables[tableId].players.length === 0) delete tables[tableId];
            else io.to(tableId).emit('table-updated', tables[tableId]);
        }
    });

    socket.on('ready-next-round', (tableId) => {
        let t = tables[tableId];
        if (t) {
            t.players.forEach(p => p.status = 'lobby');
            io.to(tableId).emit('table-updated', t);
        }
    });

    socket.on('disconnect', () => {
        delete socketUserMap[socket.id];
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 System Online at http://localhost:${PORT}`);
});