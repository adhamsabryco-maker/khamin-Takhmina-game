import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs";
import Database from 'better-sqlite3';

import { filterProfanity } from "./src/profanityFilter";

// Global Error Handlers to prevent server crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

function normalizeEgyptian(text: string): string {
  if (!text) return "";
  return text
    .replace(/[أإآ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/لآ/g, "لا")
    .replace(/[ضظط]/g, "ظ");
}

import axios from "axios";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

async function startServer() {
  try {
  const getLevel = (xp: number) => Math.min(50, Math.floor(Math.sqrt(xp / 50)) + 1);
const getQuickGuessWaitTime = (level: number) => {
  // Level 1: 150s wait, Level 50: 3s wait (decreases 3s per level)
  return Math.max(3, 150 - (level - 1) * 3);
};

const getQuickGuessThreshold = (level: number) => {
  // The threshold is when the game timer (300s) reaches (300 - waitTime)
  // Level 1: 300 - 150 = 150s remaining
  // Level 10: 300 - 123 = 177s remaining
  return 300 - getQuickGuessWaitTime(level);
};

const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  const PORT = 3000;

  // Game State
  const rooms = new Map<string, any>();
  const intervals = new Map<string, NodeJS.Timeout>();
  const matchmakingQueue: any[] = [];
  const reportsList: any[] = [];
  const blocks = new Map<string, { blockedId: string, expiresAt: number }[]>();
  const pendingMatches = new Map<string, any>();
  const allPlayers = new Map<string, { 
    name: string, 
    level: number, 
    avatar: string, 
    xp: number, 
    serial: string, 
    wins: number, 
    reports: number, 
    banUntil: number, 
    banCount: number,
    isPermanentBan: number,
    reportedBy: { reporterSerial: string, timestamp: number }[],
    email?: string,
    isAdmin?: boolean
  }>();

  const db = new Database('players.db');
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      serial TEXT PRIMARY KEY,
      name TEXT,
      avatar TEXT,
      xp INTEGER,
      wins INTEGER,
      level INTEGER
    )
  `);

  // Add new columns for reporting system if they don't exist
  try { db.exec(`ALTER TABLE players ADD COLUMN reports INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN banUntil INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN banCount INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN isPermanentBan INTEGER DEFAULT 0`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN reportedBy TEXT DEFAULT '[]'`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN email TEXT`); } catch (e) {}
  try { db.exec(`ALTER TABLE players ADD COLUMN isAdmin INTEGER DEFAULT 0`); } catch (e) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      timestamp INTEGER,
      reporterSerial TEXT,
      reporterName TEXT,
      reportedSerial TEXT,
      reportedName TEXT,
      reason TEXT,
      roomId TEXT
    )
  `);

    const insertPlayer = db.prepare(`
      INSERT OR REPLACE INTO players (serial, name, avatar, xp, wins, level, reports, banUntil, banCount, isPermanentBan, reportedBy, email, isAdmin)
      VALUES (@serial, @name, @avatar, @xp, @wins, @level, @reports, @banUntil, @banCount, @isPermanentBan, @reportedBy, @email, @isAdmin)
    `);

    const insertMany = db.transaction((players) => {
      for (const player of players) {
        insertPlayer.run({
          ...player,
          reportedBy: JSON.stringify(player.reportedBy || []),
          email: player.email || null,
          isAdmin: player.isAdmin ? 1 : 0
        });
      }
    });

  function savePlayersData() {
    try {
      const players = Array.from(allPlayers.values());
      insertMany(players);
    } catch (err) {
      console.error("Failed to save players data:", err);
    }
  }

  function loadPlayersData() {
    try {
      const rows = db.prepare('SELECT * FROM players').all();
      allPlayers.clear();
      
      rows.forEach((row: any) => {
        let reportedBy = [];
        try {
          reportedBy = JSON.parse(row.reportedBy || '[]');
        } catch (e) {}
        
        allPlayers.set(row.serial, {
          ...row,
          reports: row.reports || 0,
          banUntil: row.banUntil || 0,
          banCount: row.banCount || 0,
          isPermanentBan: row.isPermanentBan || 0,
          reportedBy: reportedBy,
          email: row.email,
          isAdmin: row.isAdmin === 1
        });
      });
      console.log(`Loaded ${allPlayers.size} players from SQLite.`);
    } catch (err) {
      console.error("Failed to load players data:", err);
    }
  }

  loadPlayersData();

  function getTopPlayers() {
    return Array.from(allPlayers.values())
      .sort((a, b) => {
        // 1. Level (derived from XP)
        // 2. XP
        if (b.xp !== a.xp) return b.xp - a.xp;
        // 3. Wins
        return (b.wins || 0) - (a.wins || 0);
      })
      .slice(0, 3) // Back to top 3 as requested, sorted globally from all registered players
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  function broadcastOnlineCount() {
    io.emit('online_count', io.engine.clientsCount);
  }

  app.get("/api/reports", (req, res) => {
    res.json(reportsList);
  });

  app.get("/api/admin/players", (req, res) => {
    res.json(Array.from(allPlayers.values()));
  });

  function isBlocked(id1: string, id2: string) {
    const now = Date.now();
    const b1 = blocks.get(id1) || [];
    const b2 = blocks.get(id2) || [];
    
    // Clean up expired blocks
    if (b1.length > 0) blocks.set(id1, b1.filter(b => b.expiresAt > now));
    if (b2.length > 0) blocks.set(id2, b2.filter(b => b.expiresAt > now));

    return b1.some(b => b.blockedId === id2 && b.expiresAt > now) ||
           b2.some(b => b.blockedId === id1 && b.expiresAt > now);
  }

  function processQueue() {
    if (matchmakingQueue.length < 2) return;
    
    const now = Date.now();

    for (let i = 0; i < matchmakingQueue.length; i++) {
      for (let j = i + 1; j < matchmakingQueue.length; j++) {
        const p1 = matchmakingQueue[i];
        const p2 = matchmakingQueue[j];
        
        // Check if blocked
        if (isBlocked(p1.playerId, p2.playerId)) continue;

        // Check if temporarily skipped (10 seconds cooldown)
        const p1SkippedP2 = p1.skipped?.get(p2.playerId);
        const p2SkippedP1 = p2.skipped?.get(p1.playerId);

        if (p1SkippedP2 && now < p1SkippedP2 + 10000) continue;
        if (p2SkippedP1 && now < p2SkippedP1 + 10000) continue;
          
        // Match found
        // Remove from highest index first to avoid shifting issues
        matchmakingQueue.splice(j, 1);
        matchmakingQueue.splice(i, 1);
        
        const matchId = `match_${Math.random().toString(36).substr(2, 9)}`;
        pendingMatches.set(matchId, {
          id: matchId,
          p1,
          p2,
          p1Response: null,
          p2Response: null
        });

        p1.socket.emit("match_proposed", {
          matchId,
          opponent: { name: p2.playerName, avatar: p2.avatar, age: p2.age, level: getLevel(p2.xp || 0) }
        });
        p2.socket.emit("match_proposed", {
          matchId,
          opponent: { name: p1.playerName, avatar: p1.avatar, age: p1.age, level: getLevel(p1.xp || 0) }
        });
        
        // Restart processing since array mutated
        processQueue();
        return;
      }
    }
  }

  const CATEGORIES = {
    people: [
      { name: "محمد صلاح", image: "https://picsum.photos/seed/salah/200/200" },
      { name: "عادل إمام", image: "https://picsum.photos/seed/adel/200/200" },
      { name: "عمرو دياب", image: "https://picsum.photos/seed/amr/200/200" },
      { name: "ليونيل ميسي", image: "https://picsum.photos/seed/messi/200/200" },
    ],
    food: [
      { name: "كشري", image: "https://picsum.photos/seed/koshary/200/200" },
      { name: "بيتزا", image: "https://picsum.photos/seed/pizza/200/200" },
      { name: "شاورما", image: "https://picsum.photos/seed/shawarma/200/200" },
      { name: "ملوخية", image: "https://picsum.photos/seed/molokhia/200/200" },
    ],
    animals: [
      { name: "أسد", image: "https://picsum.photos/seed/lion/200/200" },
      { name: "فيل", image: "https://picsum.photos/seed/elephant/200/200" },
      { name: "زرافة", image: "https://picsum.photos/seed/giraffe/200/200" },
      { name: "قطة", image: "https://picsum.photos/seed/cat/200/200" },
    ],
    objects: [
      { name: "كرسي", image: "https://picsum.photos/seed/chair/200/200" },
      { name: "ساعة", image: "https://picsum.photos/seed/clock/200/200" },
      { name: "مفتاح", image: "https://picsum.photos/seed/key/200/200" },
      { name: "نظارة", image: "https://picsum.photos/seed/glasses/200/200" },
    ],
    birds: [
      { name: "ببغاء", image: "https://picsum.photos/seed/parrot/200/200" },
      { name: "صقر", image: "https://picsum.photos/seed/falcon/200/200" },
      { name: "حمامة", image: "https://picsum.photos/seed/pigeon/200/200" },
      { name: "نعامة", image: "https://picsum.photos/seed/ostrich/200/200" },
    ],
    plants: [
      { name: "صبار", image: "https://picsum.photos/seed/cactus/200/200" },
      { name: "وردة", image: "https://picsum.photos/seed/rose/200/200" },
      { name: "شجرة", image: "https://picsum.photos/seed/tree/200/200" },
      { name: "نخلة", image: "https://picsum.photos/seed/palm/200/200" },
    ],
    movies_series: [
      { name: "لعبة الحبار", image: "https://picsum.photos/seed/squid/200/200" },
      { name: "الجوكر", image: "https://picsum.photos/seed/joker/200/200" },
      { name: "سبايدر مان", image: "https://picsum.photos/seed/spiderman/200/200" },
      { name: "هاري بوتر", image: "https://picsum.photos/seed/harry/200/200" },
    ],
  };

  io.on("connection", (socket) => {
    console.log("User connected:", socket.id);
    broadcastOnlineCount();

    socket.on("register_player", ({ name, avatar, xp }, callback) => {
      // Generate a unique non-sequential ID
      const serial = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      const level = getLevel(xp || 0);
      const filteredName = filterProfanity(name);
      
      allPlayers.set(serial, { 
        name: filteredName, 
        level, 
        avatar, 
        xp: xp || 0, 
        serial, 
        wins: 0, 
        reports: 0, 
        banUntil: 0, 
        banCount: 0,
        isPermanentBan: 0,
        reportedBy: [] 
      });
      savePlayersData();
      callback({ serial, name: filteredName });
      io.emit("top_players_update", getTopPlayers());
    });

    socket.on("update_profile", ({ playerSerial, playerName, avatar }, callback) => {
      const player = allPlayers.get(playerSerial);
      if (player) {
        player.name = filterProfanity(playerName);
        player.avatar = avatar;
        savePlayersData();
        const topPlayers = getTopPlayers();
        io.emit("top_players_update", topPlayers);
        if (callback) callback({ topPlayers, name: player.name });
      }
    });

    socket.on("get_top_players", (callback) => {
      callback(getTopPlayers());
    });
    
    socket.on("get_player_data", (serial, callback) => {
      const player = allPlayers.get(serial);
      if (player && callback) {
        callback(player);
      } else if (callback) {
        callback(null);
      }
    });
    
    socket.on("delete_account", ({ playerSerial }, callback) => {
      if (allPlayers.has(playerSerial)) {
        allPlayers.delete(playerSerial);
        
        // Delete from DB directly
        try {
          db.prepare('DELETE FROM players WHERE serial = ?').run(playerSerial);
        } catch (err) {
          console.error("Failed to delete player from DB:", err);
        }

        io.emit("top_players_update", getTopPlayers());
        if (callback) callback({ success: true });
      } else {
        if (callback) callback({ success: false, error: "Player not found" });
      }
    });

    socket.on("join_room", ({ roomId, playerName, avatar, age, xp, streak, serial, wins }) => {
      // Check if player is banned
      const serverPlayer = allPlayers.get(serial);
      if (!serverPlayer) {
        socket.emit("auth_error");
        return;
      }
      
      if (serverPlayer.isPermanentBan) {
          socket.emit("banned_status", { isPermanent: true });
          return;
        }
        if (serverPlayer.banUntil > Date.now()) {
          socket.emit("banned_status", { banUntil: serverPlayer.banUntil, isPermanent: false });
          return;
        }

      if (!rooms.has(roomId)) {
        rooms.set(roomId, {
          id: roomId,
          players: [],
          gameState: "waiting",
          timer: 60,
          category: "people",
          isPaused: false,
          pausingPlayerId: null,
          quickGuessTimer: 0,
        });
      }

      const room = rooms.get(roomId);
      if (room && room.players.length < 2) {
        socket.join(roomId);
        
        // Use server data as absolute source of truth
        const actualXp = serverPlayer.xp;
        const actualWins = serverPlayer.wins;
        const actualReports = serverPlayer.reports;
        const actualReportedBy = serverPlayer.reportedBy;
        const actualName = serverPlayer.name || filterProfanity(playerName);

        const player = {
          id: socket.id,
          serial: serial,
          name: actualName,
          age: age,
          avatar: avatar,
          score: 1000,
          targetImage: null,
          isMuted: false,
          hasGuessed: false,
          selectedCategory: null,
          hintCount: 0,
          quickGuessUsed: false,
          wordLengthUsed: false,
          timeFreezeUsed: false,
          spyLensUsed: false,
          reported: false,
          xp: actualXp,
          streak: streak || 0,
          wins: actualWins,
          reports: actualReports,
          reportedBy: actualReportedBy
        };
        room.players.push(player);
        
        if (room.players.length === 2) {
          startWaitingInterval(roomId);
        }

        io.to(roomId).emit("room_update", room);
      } else {
        socket.emit("error", "الغرفة ممتلئة، يجب تغيير كود الغرفة");
      }
    });

    socket.on("find_random_match", ({ playerId, playerName, avatar, age, xp, streak, serial, wins }) => {
      // Check if player is banned
      const bannedPlayer = allPlayers.get(serial);
      if (!bannedPlayer) {
        socket.emit("auth_error");
        return;
      }
      
      if (bannedPlayer.isPermanentBan) {
          socket.emit("banned_status", { isPermanent: true });
          return;
        }
        if (bannedPlayer.banUntil > Date.now()) {
          socket.emit("banned_status", { banUntil: bannedPlayer.banUntil, isPermanent: false });
          return;
        }

      // Remove from queue if already there (re-join)
      const existingIndex = matchmakingQueue.findIndex(p => p.id === socket.id);
      if (existingIndex !== -1) matchmakingQueue.splice(existingIndex, 1);

      for (const [matchId, match] of pendingMatches.entries()) {
        if (match.p1.socket.id === socket.id || match.p2.socket.id === socket.id) {
          const oppData = match.p1.socket.id === socket.id ? match.p2 : match.p1;
          pendingMatches.delete(matchId);
          oppData.socket.emit("match_rejected");
          matchmakingQueue.unshift(oppData);
          break;
        }
      }

      // Use server data as absolute source of truth
      const actualXp = bannedPlayer.xp;
      const actualWins = bannedPlayer.wins;
      const actualName = bannedPlayer.name || filterProfanity(playerName);

      matchmakingQueue.push({ 
        id: socket.id, 
        socket, 
        playerId, 
        playerName: actualName, 
        avatar, 
        age,
        xp: actualXp,
        streak: streak || 0,
        serial: serial,
        wins: actualWins,
        skipped: new Map() // Initialize skipped map (playerId -> timestamp)
      });
      socket.emit("waiting_for_match");
      processQueue();
    });

    socket.on("respond_to_match", ({ matchId, response }) => {
      const match = pendingMatches.get(matchId);
      if (!match) return;

      const isP1 = match.p1.socket.id === socket.id;
      const isP2 = match.p2.socket.id === socket.id;

      if (!isP1 && !isP2) return;

      if (isP1) match.p1Response = response;
      if (isP2) match.p2Response = response;

      const myData = isP1 ? match.p1 : match.p2;
      const oppData = isP1 ? match.p2 : match.p1;

      if (response === 'block') {
        const myBlocks = blocks.get(myData.playerId) || [];
        myBlocks.push({ blockedId: oppData.playerId, expiresAt: Date.now() + 60 * 60 * 1000 }); // 1 hour
        blocks.set(myData.playerId, myBlocks);
      }

      if (response === 'reject' || response === 'block') {
        pendingMatches.delete(matchId);
        
        // Add to skipped list so they don't match again immediately (10s cooldown)
        if (response === 'reject') {
          if (!myData.skipped) myData.skipped = new Map();
          myData.skipped.set(oppData.playerId, Date.now());
          
          // Re-process queue after cooldown expires
          setTimeout(() => {
            processQueue();
          }, 10000);
        }

        // Notify both players
        oppData.socket.emit("match_rejected");
        myData.socket.emit("match_rejected");
        
        matchmakingQueue.unshift(oppData); // Put innocent back at front
        matchmakingQueue.push(myData); // Put rejector back at end
        
        processQueue();
        return;
      }

      if (match.p1Response === 'accept' && match.p2Response === 'accept') {
        pendingMatches.delete(matchId);
        
        const roomId = `random_${Math.random().toString(36).substr(2, 9)}`;
        match.p1.socket.join(roomId);
        match.p2.socket.join(roomId);

        const p1ServerPlayer = allPlayers.get(match.p1.serial);
        const p2ServerPlayer = allPlayers.get(match.p2.serial);

        const room = {
          id: roomId,
          players: [
            {
              id: match.p1.socket.id,
              playerId: match.p1.playerId,
              serial: match.p1.serial,
              name: match.p1.playerName,
              age: match.p1.age,
              avatar: match.p1.avatar,
              score: 1000,
              targetImage: null,
              isMuted: false,
              hasGuessed: false,
              selectedCategory: null,
              hintCount: 0,
              quickGuessUsed: false,
              wordLengthUsed: false,
              timeFreezeUsed: false,
              spyLensUsed: false,
              reported: false,
              xp: match.p1.xp || 0,
              streak: match.p1.streak || 0,
              wins: match.p1.wins || 0,
              reports: p1ServerPlayer ? p1ServerPlayer.reports : 0,
              reportedBy: p1ServerPlayer ? p1ServerPlayer.reportedBy : []
            },
            {
              id: match.p2.socket.id,
              playerId: match.p2.playerId,
              serial: match.p2.serial,
              name: match.p2.playerName,
              age: match.p2.age,
              avatar: match.p2.avatar,
              score: 1000,
              targetImage: null,
              isMuted: false,
              hasGuessed: false,
              selectedCategory: null,
              hintCount: 0,
              quickGuessUsed: false,
              wordLengthUsed: false,
              timeFreezeUsed: false,
              spyLensUsed: false,
              reported: false,
              xp: match.p2.xp || 0,
              streak: match.p2.streak || 0,
              wins: match.p2.wins || 0,
              reports: p2ServerPlayer ? p2ServerPlayer.reports : 0,
              reportedBy: p2ServerPlayer ? p2ServerPlayer.reportedBy : []
            }
          ],
          gameState: "waiting",
          timer: 60,
          category: "people",
          isPaused: false,
          pausingPlayerId: null,
          quickGuessTimer: 0,
        };

        rooms.set(roomId, room);
        startWaitingInterval(roomId);
        io.to(roomId).emit("room_update", room);
        io.to(roomId).emit("random_match_found", { roomId });
      }
    });

    socket.on("select_category", ({ roomId, category }) => {
      const room = rooms.get(roomId);
      if (room && room.gameState === "waiting") {
        const player = room.players.find((p: any) => p.id === socket.id);
        if (player) {
          player.selectedCategory = category;
          
          // Check if both players selected the same category
          const allSelected = room.players.length === 2 && 
                            room.players.every((p: any) => p.selectedCategory === category);
          
          if (allSelected) {
            room.category = category;
          }
          
          io.to(roomId).emit("room_update", room);
        }
      }
    });

    socket.on("start_game_request", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (room && room.players.length === 2 && room.gameState === "waiting") {
        const p1 = room.players[0];
        const p2 = room.players[1];
        if (p1.selectedCategory && p1.selectedCategory === p2.selectedCategory) {
          startGame(roomId);
        }
      }
    });

    socket.on("send_emote", ({ roomId, emote }) => {
      const room = rooms.get(roomId);
      if (room) {
        io.to(roomId).emit("emote_received", { senderId: socket.id, emote });
      }
    });

    socket.on("send_chat", ({ roomId, text }) => {
      console.log(`Chat request from ${socket.id} for room ${roomId}: ${text}`);
      const room = rooms.get(roomId);
      if (room) {
        const sender = room.players.find((p: any) => p.id === socket.id);
        let messageToSend = filterProfanity(text);

        if (sender && sender.age < 13) {
          console.log(`Child player ${sender.name} (${sender.id}) sent: "${text}". Message replaced.`);
          messageToSend = "(رسالة طفل)"; // Generic message for children
        }

        console.log(`Broadcasting chat to room ${roomId}`);
        io.to(roomId).emit("chat_bubble", { senderId: socket.id, text: messageToSend });
      } else {
        console.log(`Room ${roomId} not found for chat`);
      }
    });

    socket.on("submit_guess", ({ roomId, guess }) => {
      const room = rooms.get(roomId);
      if (room && room.gameState === "guessing") {
        const player = room.players.find((p: any) => p.id === socket.id);
        
        if (player) {
          const isCorrect = normalizeEgyptian(guess.trim()).toLowerCase() === normalizeEgyptian(player.targetImage.name).toLowerCase();
          
          if (isCorrect) {
            player.hasGuessed = true;
            player.score += 500;
            io.to(roomId).emit("guess_result", { playerId: socket.id, correct: true });
            
            // Pass winner name to endGame
            endGame(roomId, player.name);
          } else {
            io.to(roomId).emit("guess_result", { playerId: socket.id, correct: false });
          }
        }
      }
    });

    socket.on("use_card", ({ roomId, cardType }) => {
      const room = rooms.get(roomId);
      if (!room || room.isPaused) return;

      const player = room.players.find((p: any) => p.id === socket.id);
      const opponent = room.players.find((p: any) => p.id !== socket.id);
      if (!player || !opponent) return;

      if (cardType === "hint") {
        if (!player.hintCount) player.hintCount = 0;
        if (player.hintCount < 2) {
          player.hintCount++;
          const targetName = player.targetImage.name;
          const hintChar = targetName[player.hintCount - 1] || "?";
          socket.emit("hint_received", { 
            hint: `التلميح رقم ${player.hintCount}: الحرف هو "${hintChar}"`,
            count: player.hintCount
          });
          io.to(roomId).emit("room_update", room);
        }
      } else if (cardType === "quick_guess") {
        const playerLevel = getLevel(player.xp || 0);
        const threshold = getQuickGuessThreshold(playerLevel);
        if (room.timer <= threshold && !player.quickGuessUsed) {
          player.quickGuessUsed = true;
          room.isPaused = true;
          room.pausingPlayerId = socket.id;
          room.quickGuessTimer = 60;
          io.to(roomId).emit("room_update", room);
          io.to(roomId).emit("quick_guess_started", { playerId: socket.id });
        }
      } else if (cardType === "word_length") {
        const playerLevel = getLevel(player.xp || 0);
        if (playerLevel >= 20 && !player.wordLengthUsed) {
          player.wordLengthUsed = true;
          const targetName = player.targetImage.name;
          socket.emit("word_length_result", { length: targetName.length });
          io.to(roomId).emit("room_update", room);
        }
      } else if (cardType === "time_freeze") {
        const playerLevel = getLevel(player.xp || 0);
        if (playerLevel >= 30 && !player.timeFreezeUsed && !room.isFrozen) {
          player.timeFreezeUsed = true;
          room.isFrozen = true;
          room.freezeTimer = 60;
          io.to(roomId).emit("freeze_started", { playerId: socket.id });
          io.to(roomId).emit("room_update", room);
        }
      } else if (cardType === "spy_lens") {
        const playerLevel = getLevel(player.xp || 0);
        if (playerLevel >= 50 && !player.spyLensUsed) {
          player.spyLensUsed = true;
          // The player wants to see their own target image (which is what the opponent sees)
          socket.emit("spy_lens_active", { image: player.targetImage.image });
          io.to(roomId).emit("room_update", room);
        }
      }
    });

    socket.on("cancel_quick_guess", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (room && room.isPaused && room.pausingPlayerId === socket.id) {
        const player = room.players.find((p: any) => p.id === socket.id);
        const playerLevel = getLevel(player.xp || 0);
        
        if (playerLevel >= 20) {
          room.isPaused = false;
          room.pausingPlayerId = null;
          room.quickGuessTimer = 0;
          // Refund the usage? The requirement says "cancel the quick guess state and resume", 
          // usually "cancel" implies you didn't use it, but the requirement says "resume without penalty".
          // However, "quickGuessUsed" was set to true when started. 
          // If we want to allow them to try again later, we should set quickGuessUsed = false.
          // But the prompt says "cancel the quick guess state", implying just exiting the modal.
          // Let's assume it consumes the "use" for this turn unless specified otherwise, 
          // but usually "cancel" means "I changed my mind, let me go back to discussion".
          // If it consumes the use, they can't do it again. 
          // Let's keep quickGuessUsed = true for now as it's a "one time use" card usually.
          // Wait, "resume without penalty" might mean they don't lose the game (which happens if timer runs out or wrong guess).
          
          io.to(roomId).emit("room_update", room);
        }
      }
    });

    socket.on("submit_quick_guess", ({ roomId, guess }) => {
      const room = rooms.get(roomId);
      if (room && room.isPaused && room.pausingPlayerId === socket.id) {
        const player = room.players.find((p: any) => p.id === socket.id);
        const isCorrect = normalizeEgyptian(guess.trim()).toLowerCase() === normalizeEgyptian(player.targetImage.name).toLowerCase();
        
        if (isCorrect) {
          io.to(roomId).emit("guess_result", { playerId: socket.id, correct: true });
          endGame(roomId, player.name);
        } else {
          // Wrong quick guess = instant lose
          io.to(roomId).emit("guess_result", { playerId: socket.id, correct: false });
          const opponent = room.players.find((p: any) => p.id !== socket.id);
          endGame(roomId, opponent ? opponent.name : "المنافس");
        }
      }
    });

    socket.on("report_player", ({ roomId, reportedPlayerId, reason }, callback) => {
      const room = rooms.get(roomId);
      if (room) {
        const reportedPlayer = room.players.find((p: any) => p.id === reportedPlayerId);
        const reporter = room.players.find((p: any) => p.id === socket.id);
        if (reportedPlayer && reporter) {
          reportedPlayer.reported = true;
          
          // Update allPlayers data
          const serverReportedPlayer = allPlayers.get(reportedPlayer.serial);
          const serverReporter = allPlayers.get(reporter.serial);
          
          console.log(`Report attempt: Reporter=${reporter.name}(Serial: ${reporter.serial}, ID: ${reporter.id}), Reported=${reportedPlayer.name}(Serial: ${reportedPlayer.serial}, ID: ${reportedPlayer.id})`);
          console.log(`AllPlayers keys: ${Array.from(allPlayers.keys()).join(', ')}`);
          
          if (serverReportedPlayer && serverReporter) {
            const now = Date.now();
            const oneDayInMs = 24 * 60 * 60 * 1000;
            
            // Check if this reporter has already reported this player today
            const lastReport = serverReportedPlayer.reportedBy.find(r => r.reporterSerial === serverReporter.serial);
            
            if (!lastReport || (now - lastReport.timestamp) >= oneDayInMs) {
              console.log(`Report accepted for ${serverReportedPlayer.name}. Previous reports: ${serverReportedPlayer.reports}`);
              if (lastReport) {
                lastReport.timestamp = now;
              } else {
                serverReportedPlayer.reportedBy.push({ reporterSerial: serverReporter.serial, timestamp: now });
              }
              
              serverReportedPlayer.reports += 1;
              reportedPlayer.reports = serverReportedPlayer.reports;
              
              // Save report to DB
              try {
                const reportId = Math.random().toString(36).substr(2, 9);
                db.prepare(`
                  INSERT INTO reports (id, timestamp, reporterSerial, reporterName, reportedSerial, reportedName, reason, roomId)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                `).run(reportId, now, serverReporter.serial, reporter.name, serverReportedPlayer.serial, reportedPlayer.name, reason, roomId);
              } catch (err) {
                console.error("Failed to save report to DB:", err);
              }
              
              // Notify the reported player so their profile updates
              io.to(reportedPlayer.id).emit("player_data_update", { reports: serverReportedPlayer.reports });
              
              if (serverReportedPlayer.reports >= 10) {
                serverReportedPlayer.reports = 0; // Reset reports after ban
                reportedPlayer.reports = 0;
                serverReportedPlayer.banCount += 1;
                
                if (serverReportedPlayer.banCount >= 5) {
                  serverReportedPlayer.isPermanentBan = 1;
                  console.log(`Player ${serverReportedPlayer.name} has been permanently banned.`);
                  io.to(reportedPlayer.id).emit("banned_status", { isPermanent: true });
                } else {
                  serverReportedPlayer.banUntil = now + oneDayInMs;
                  console.log(`Player ${serverReportedPlayer.name} has been banned for 24 hours (Ban #${serverReportedPlayer.banCount}).`);
                  io.to(reportedPlayer.id).emit("banned_status", { banUntil: serverReportedPlayer.banUntil, isPermanent: false });
                }
              }
              savePlayersData();
              if (callback) callback({ success: true });
            } else {
              console.log(`Report rejected: Already reported within 24h by ${serverReporter.name}`);
              if (callback) callback({ success: false, message: 'لقد قمت بالإبلاغ عن هذا اللاعب بالفعل.' });
            }
          } else {
            console.log(`Report failed: serverReportedPlayer=${!!serverReportedPlayer}, serverReporter=${!!serverReporter}`);
            if (callback) callback({ success: false, message: 'حدث خطأ أثناء معالجة الإبلاغ.' });
          }

          const report = {
            id: Math.random().toString(36).substr(2, 9),
            timestamp: new Date().toISOString(),
            roomId,
            reporterId: reporter.id,
            reporterName: reporter.name,
            reportedPlayerId: reportedPlayer.id,
            reportedPlayerName: reportedPlayer.name,
            reason
          };
          reportsList.push(report);
          console.log(`Player ${reportedPlayer.name} (${reportedPlayer.id}) reported for: ${reason} in room ${roomId}`);
          io.to(roomId).emit("room_update", room); // Update clients to reflect reported status if needed
        }
      }
    });

    socket.on("leave_room", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (room) {
        const player = room.players.find((p: any) => p.id === socket.id);
        if (player) {
          // Remove player from room
          room.players = room.players.filter((p: any) => p.id !== socket.id);
          socket.leave(roomId);

          // If game is active OR waiting (lobby), stop the game for everyone
          if (room.gameState !== "finished") {
            if (intervals.has(roomId)) {
              clearInterval(intervals.get(roomId));
              intervals.delete(roomId);
            }
            
            if (room.gameState === "waiting") {
              socket.to(roomId).emit("opponent_left_lobby");
            } else {
              socket.to(roomId).emit("game_stopped", { reason: `غادر ${player.name} الغرفة` });
            }
            rooms.delete(roomId);
          } else {
            // If finished, just update the room for the remaining player (they might be looking at results)
            if (room.players.length === 0) {
              if (intervals.has(roomId)) {
                clearInterval(intervals.get(roomId));
                intervals.delete(roomId);
              }
              rooms.delete(roomId);
            } else {
              socket.to(roomId).emit("room_update", room);
            }
          }
        }
      }
    });

    socket.on("leave_matchmaking", () => {
      const qIndex = matchmakingQueue.findIndex(p => p.id === socket.id);
      if (qIndex !== -1) matchmakingQueue.splice(qIndex, 1);

      for (const [matchId, match] of pendingMatches.entries()) {
        if (match.p1.socket.id === socket.id || match.p2.socket.id === socket.id) {
          const oppData = match.p1.socket.id === socket.id ? match.p2 : match.p1;
          pendingMatches.delete(matchId);
          oppData.socket.emit("match_rejected");
          matchmakingQueue.unshift(oppData);
          processQueue();
          break;
        }
      }
    });

    socket.on("toggle_mute_opponent", ({ roomId, isMuted }) => {
      const room = rooms.get(roomId);
      if (room) {
        const opponent = room.players.find((p: any) => p.id !== socket.id);
        if (opponent) {
          io.to(opponent.id).emit("opponent_muted_you", isMuted);
        }
      }
    });

    socket.on("play_again", ({ roomId }) => {
      const room = rooms.get(roomId);
      if (room && room.gameState === "finished") {
        // Reset room state
        room.gameState = "waiting";
        room.timer = 60;
        room.winnerId = null;
        room.isPaused = false;
        room.pausingPlayerId = null;
        room.quickGuessTimer = 0;
        
        // Reset players state
        room.players.forEach((p: any) => {
          p.targetImage = null;
          p.hasGuessed = false;
          p.selectedCategory = null;
          p.hintCount = 0;
          p.quickGuessUsed = false;
          p.wordLengthUsed = false;
          p.timeFreezeUsed = false;
          p.spyLensUsed = false;
        });
        
        // Clear any existing intervals for this room
        if (intervals.has(roomId)) {
          clearInterval(intervals.get(roomId));
          intervals.delete(roomId);
        }
        
        startWaitingInterval(roomId);
        io.to(roomId).emit("room_update", room);
      }
    });

    socket.on("admin_get_players", (callback) => {
      const player = Array.from(allPlayers.values()).find(p => p.serial === socket.data?.serial);
      if (player?.isAdmin) {
        callback(Array.from(allPlayers.values()));
      } else {
        callback({ error: "Unauthorized" });
      }
    });

    socket.on("admin_get_reports", (callback) => {
      const player = Array.from(allPlayers.values()).find(p => p.serial === socket.data?.serial);
      if (player?.isAdmin) {
        try {
          const reports = db.prepare('SELECT * FROM reports ORDER BY timestamp DESC').all();
          callback(reports);
        } catch (err) {
          callback({ error: "Failed to fetch reports" });
        }
      } else {
        callback({ error: "Unauthorized" });
      }
    });

    socket.on("admin_update_player", ({ serial, updates }, callback) => {
      const admin = Array.from(allPlayers.values()).find(p => p.serial === socket.data?.serial);
      if (admin?.isAdmin) {
        const player = allPlayers.get(serial);
        if (player) {
          Object.assign(player, updates);
          if (updates.xp !== undefined) player.level = getLevel(updates.xp);
          savePlayersData();
          io.emit("top_players_update", getTopPlayers());
          
          // Find socket ID for this player serial to send direct update
          for (const [socketId, s] of io.sockets.sockets) {
            if (s.data?.serial === serial) {
              io.to(socketId).emit("player_data_update", player);
              break;
            }
          }
          
          callback({ success: true });
        } else {
          callback({ error: "Player not found" });
        }
      } else {
        callback({ error: "Unauthorized" });
      }
    });

    socket.on("admin_delete_player", (serial, callback) => {
      const admin = Array.from(allPlayers.values()).find(p => p.serial === socket.data?.serial);
      if (admin?.isAdmin) {
        if (allPlayers.has(serial)) {
          allPlayers.delete(serial);
          db.prepare('DELETE FROM players WHERE serial = ?').run(serial);
          io.emit("top_players_update", getTopPlayers());
          callback({ success: true });
        } else {
          callback({ error: "Player not found" });
        }
      } else {
        callback({ error: "Unauthorized" });
      }
    });

    socket.on("admin_set_admin_status", ({ serial, isAdmin, email }, callback) => {
      // This is a special event to bootstrap the first admin or manage others
      // For security, it should check if the requester is already an admin OR if it's the first one
      const admin = Array.from(allPlayers.values()).find(p => p.serial === socket.data?.serial);
      if (admin?.isAdmin || email === "adhamsabry.co@gmail.com") {
        const player = allPlayers.get(serial);
        if (player) {
          player.isAdmin = isAdmin;
          player.email = email;
          savePlayersData();
          callback({ success: true });
        } else {
          callback({ error: "Player not found" });
        }
      } else {
        callback({ error: "Unauthorized" });
      }
    });

    socket.on("set_player_serial_for_socket", (serial) => {
      socket.data = { serial };
    });

    socket.on("disconnect", () => {
      broadcastOnlineCount();
      // Remove from matchmaking queue
      const qIndex = matchmakingQueue.findIndex(p => p.id === socket.id);
      if (qIndex !== -1) matchmakingQueue.splice(qIndex, 1);

      for (const [matchId, match] of pendingMatches.entries()) {
        if (match.p1.socket.id === socket.id || match.p2.socket.id === socket.id) {
          const oppData = match.p1.socket.id === socket.id ? match.p2 : match.p1;
          pendingMatches.delete(matchId);
          oppData.socket.emit("match_rejected");
          matchmakingQueue.unshift(oppData);
          processQueue();
          break;
        }
      }

      rooms.forEach((room, roomId) => {
        const index = room.players.findIndex((p: any) => p.id === socket.id);
        if (index !== -1) {
          const leavingPlayer = room.players[index];
          room.players.splice(index, 1);
          
          if (room.gameState !== "finished") {
            if (intervals.has(roomId)) {
              clearInterval(intervals.get(roomId));
              intervals.delete(roomId);
            }
            
            if (room.gameState === "waiting") {
              socket.to(roomId).emit("opponent_left_lobby");
            } else {
              socket.to(roomId).emit("game_stopped", { reason: `انقطع اتصال ${leavingPlayer.name}` });
            }
            rooms.delete(roomId);
          } else {
            if (room.players.length === 0) {
              if (intervals.has(roomId)) {
                clearInterval(intervals.get(roomId));
                intervals.delete(roomId);
              }
              rooms.delete(roomId);
            } else {
              socket.to(roomId).emit("room_update", room);
            }
          }
        }
      });
    });
  });

  function startWaitingInterval(roomId: string) {
    if (intervals.has(roomId)) {
      clearInterval(intervals.get(roomId));
      intervals.delete(roomId);
    }

    const room = rooms.get(roomId);
    if (room) room.timer = 60;

    const interval = setInterval(() => {
      const r = rooms.get(roomId);
      if (!r) {
        clearInterval(interval);
        return;
      }

      if (r.gameState === "waiting") {
        if (r.timer > 0) {
          r.timer--;
          io.to(roomId).emit("timer_update", r.timer);
        } else {
          clearInterval(interval);
          io.to(roomId).emit("game_stopped", { reason: "انتهى الوقت! لم يتم الاتفاق على فئة." });
          rooms.delete(roomId);
        }
      } else {
        clearInterval(interval);
      }
    }, 1000);
    
    intervals.set(roomId, interval);
  }

  function startGame(roomId: string) {
    const room = rooms.get(roomId);
    if (!room) return;

    const categoryImages = CATEGORIES[room.category as keyof typeof CATEGORIES];
    const shuffled = [...categoryImages].sort(() => 0.5 - Math.random());
    
    room.players[0].targetImage = shuffled[0];
    room.players[1].targetImage = shuffled[1 % shuffled.length];
    room.players[0].hintCount = 0;
    room.players[1].hintCount = 0;
    room.players[0].quickGuessUsed = false;
    room.players[1].quickGuessUsed = false;
    
    room.gameState = "discussion";
    room.timer = 300; // 5 minutes
    room.isPaused = false;

    io.to(roomId).emit("room_update", room);
    io.to(roomId).emit("game_started"); // Signal client to start initial cooldowns

    if (intervals.has(roomId)) {
      clearInterval(intervals.get(roomId));
      intervals.delete(roomId);
    }
    
    const interval = setInterval(() => {
      if (room.isPaused) {
        if (room.quickGuessTimer > 0) {
          room.quickGuessTimer--;
        }
        
        if (room.quickGuessTimer <= 0) {
          room.isPaused = false;
          const pausingPlayerId = room.pausingPlayerId;
          room.pausingPlayerId = null;
          
          // If timer runs out, the player who paused loses
          const opponent = room.players.find((p: any) => p.id !== pausingPlayerId);
          endGame(roomId, opponent ? opponent.name : "المنافس");
        } else {
          io.to(roomId).emit("quick_guess_timer_update", room.quickGuessTimer);
        }
        return;
      }

      // Handle Time Freeze
      if (room.isFrozen) {
        if (room.freezeTimer > 0) {
          room.freezeTimer--;
          io.to(roomId).emit("freeze_timer_update", room.freezeTimer);
        } else {
          room.isFrozen = false;
          room.freezeTimer = 0;
          io.to(roomId).emit("freeze_ended");
        }
        return; // Skip main timer decrement
      }

      if (room.timer > 0) {
        room.timer--;
      }

      if (room.timer <= 0) {
        if (room.gameState === "discussion") {
          room.gameState = "guessing";
          room.timer = 30;
          io.to(roomId).emit("room_update", room);
        } else {
          if (intervals.has(roomId)) {
            clearInterval(intervals.get(roomId));
            intervals.delete(roomId);
          }
          endGame(roomId, null);
        }
      } else {
        io.to(roomId).emit("timer_update", room.timer);
      }
    }, 1000);
    
    intervals.set(roomId, interval);
  }

  function endGame(roomId: string, winnerName: string | null) {
    const room = rooms.get(roomId);
    if (room) {
      if (intervals.has(roomId)) {
        clearInterval(intervals.get(roomId));
        intervals.delete(roomId);
      }
      room.gameState = "finished";
      const winner = room.players.find((p: any) => p.name === winnerName);
      const loser = room.players.find((p: any) => p.name !== winnerName);
      
      room.winnerId = winner ? winner.id : null;

      // Calculate updates
      const updates: any = {};
      if (winner) {
        const winnerXP = 100 + (winner.streak || 0) * 10;
        winner.xp = (winner.xp || 0) + winnerXP;
        winner.streak = (winner.streak || 0) + 1;
        winner.wins = (winner.wins || 0) + 1;
        updates[winner.id] = { xp: winnerXP, streak: winner.streak, wins: winner.wins, won: true };
      }
      if (loser) {
        loser.xp = (loser.xp || 0) + 20;
        loser.streak = 0;
        updates[loser.id] = { xp: 20, streak: 0, wins: loser.wins || 0, won: false };
      }

      // Update allPlayers leaderboard
      room.players.forEach((p: any) => {
        // Find player by serial if we had it
        const player = allPlayers.get(p.serial || "");
        if (player) {
          player.xp = p.xp;
          player.level = getLevel(p.xp);
          player.wins = p.wins || 0;
        } else {
          // Fallback to name search
          for (const [serial, data] of allPlayers.entries()) {
            if (data.name === p.name) {
              data.xp = p.xp;
              data.level = getLevel(p.xp);
              data.wins = p.wins || 0;
              break;
            }
          }
        }
      });
      savePlayersData();
      io.emit("top_players_update", getTopPlayers());

      io.to(roomId).emit("game_finished", { 
        room, 
        winnerId: room.winnerId,
        updates
      });
    }
  }

  // Google OAuth Routes
  app.get("/api/auth/google/url", (req, res) => {
    const redirectUri = `${APP_URL}/api/auth/google/callback`;
    const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${GOOGLE_CLIENT_ID}&redirect_uri=${redirectUri}&response_type=code&scope=email%20profile`;
    res.json({ url });
  });

  app.get("/api/auth/google/callback", async (req, res) => {
    const { code } = req.query;
    const redirectUri = `${APP_URL}/api/auth/google/callback`;

    try {
      const tokenResponse = await axios.post("https://oauth2.googleapis.com/token", {
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      });

      const { access_token } = tokenResponse.data;
      const userResponse = await axios.get("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${access_token}` },
      });

      const { email, name, picture } = userResponse.data;

      // Check if this email is the admin email
      const isAdmin = email === "adhamsabry.co@gmail.com";

      res.send(`
        <html>
          <body>
            <script>
              window.opener.postMessage({ 
                type: 'GOOGLE_AUTH_SUCCESS', 
                user: { email: '${email}', name: '${name}', picture: '${picture}', isAdmin: ${isAdmin} } 
              }, '*');
              window.close();
            </script>
          </body>
        </html>
      `);
    } catch (error) {
      console.error("Google Auth Error:", error);
      res.status(500).send("Authentication failed");
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
} catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1); // Exit with a non-zero code to indicate failure
  }
}

startServer();
