const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));

const KILL_LIMIT = 15;
let gameState = { players: {}, started: false, hostId: null };

function getSpawn() {
  const a = Math.random() * Math.PI * 2;
  const r = 8 + Math.random() * 18;
  return { x: Math.cos(a) * r, y: 1.7, z: Math.sin(a) * r };
}

function scores() {
  return Object.values(gameState.players).map(p => ({
    id: p.id, name: p.name, kills: p.kills, deaths: p.deaths, isHost: p.isHost
  }));
}

io.on('connection', socket => {
  console.log('+ connect', socket.id);

  socket.on('join', ({ name }) => {
    const isHost = Object.keys(gameState.players).length === 0;
    if (isHost) gameState.hostId = socket.id;
    gameState.players[socket.id] = {
      id: socket.id,
      name: String(name).slice(0, 12).toUpperCase() || 'PLAYER',
      hp: 100, kills: 0, deaths: 0,
      pos: getSpawn(), yaw: 0, pitch: 0, weapon: 0,
      isHost, alive: true
    };
    socket.emit('joined', {
      id: socket.id, isHost,
      players: gameState.players,
      started: gameState.started
    });
    socket.broadcast.emit('player_joined', gameState.players[socket.id]);
    io.emit('scores_update', scores());
  });

  socket.on('position', ({ pos, yaw, pitch, weapon }) => {
    const p = gameState.players[socket.id];
    if (!p) return;
    p.pos = pos; p.yaw = yaw; p.pitch = pitch; p.weapon = weapon;
    socket.broadcast.emit('player_moved', { id: socket.id, pos, yaw, pitch, weapon });
  });

  socket.on('shoot', ({ targetId, damage, isHeadshot, weapon }) => {
    const target = gameState.players[targetId];
    const shooter = gameState.players[socket.id];
    if (!target || !shooter || !target.alive) return;
    target.hp = Math.max(0, target.hp - Math.min(damage, 300));
    io.to(targetId).emit('take_damage', { from: socket.id, damage, hp: target.hp });
    socket.emit('hit_confirmed', { targetId, damage, isHeadshot });
    if (target.hp <= 0) {
      target.alive = false;
      target.deaths++;
      shooter.kills++;
      io.emit('player_killed', {
        killerId: socket.id, victimId: targetId,
        killerName: shooter.name, victimName: target.name,
        scores: scores()
      });
      if (shooter.kills >= KILL_LIMIT) {
        io.emit('game_over', { winnerId: socket.id, winnerName: shooter.name, scores: scores() });
        Object.values(gameState.players).forEach(p => { p.kills = 0; p.deaths = 0; p.hp = 100; p.alive = true; });
        gameState.started = false;
        return;
      }
      setTimeout(() => {
        if (!gameState.players[targetId]) return;
        const p = gameState.players[targetId];
        p.hp = 100; p.alive = true;
        const spawn = getSpawn();
        p.pos = spawn;
        io.to(targetId).emit('respawn', { pos: spawn });
        io.emit('player_respawned', { id: targetId, pos: spawn });
      }, 3000);
    }
  });

  socket.on('self_damage', ({ damage }) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive) return;
    p.hp = Math.max(0, p.hp - Math.min(damage, 50));
    socket.emit('take_damage', { from: socket.id, damage, hp: p.hp });
  });

  socket.on('start_game', () => {
    const p = gameState.players[socket.id];
    if (!p || !p.isHost || gameState.started) return;
    if (Object.keys(gameState.players).length < 1) return;
    gameState.started = true;
    io.emit('game_start');
  });

  socket.on('disconnect', () => {
    console.log('- disconnect', socket.id);
    const was = gameState.players[socket.id];
    const wasHost = was?.isHost;
    delete gameState.players[socket.id];
    io.emit('player_left', { id: socket.id });
    io.emit('scores_update', scores());
    const remaining = Object.values(gameState.players);
    if (remaining.length === 0) { gameState.started = false; gameState.hostId = null; return; }
    if (wasHost) {
      remaining[0].isHost = true;
      gameState.hostId = remaining[0].id;
      io.to(remaining[0].id).emit('you_are_host');
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`PO.VP server running on port ${PORT}`));
