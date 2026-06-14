const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname)));
app.get('/', (req,res) => res.sendFile(path.join(__dirname,'index.html')));
app.get('/index.html', (req,res) => res.sendFile(path.join(__dirname,'index.html')));

const KILL_LIMIT = 15;
let gameState = { players: {}, started: false, hostId: null, teamScores: {A:0, B:0} };
let powerUps = [];
let puIdCounter = 1;

function getSpawn() {
  const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 18;
  return { x: Math.cos(a) * r, y: 1.7, z: Math.sin(a) * r };
}

function scores() {
  return Object.values(gameState.players).map(p => ({
    id: p.id, name: p.name, kills: p.kills, deaths: p.deaths,
    isHost: p.isHost, team: p.team, prestige: p.prestige || 0
  }));
}

function assignTeam() {
  const counts = {A:0, B:0};
  Object.values(gameState.players).forEach(p => counts[p.team]++);
  return counts.A <= counts.B ? 'A' : 'B';
}

function spawnPowerUp() {
  if (!gameState.started || powerUps.length >= 6) return;
  const types = ['health','ammo','speed'];
  const type = types[Math.floor(Math.random() * 3)];
  const a = Math.random() * Math.PI * 2, r = 4 + Math.random() * 22;
  const pu = { id: puIdCounter++, type, x: Math.cos(a) * r, z: Math.sin(a) * r };
  powerUps.push(pu);
  io.emit('powerup_spawned', pu);
  setTimeout(() => {
    powerUps = powerUps.filter(p => p.id !== pu.id);
    io.emit('powerup_expired', { id: pu.id });
  }, 25000);
}

setInterval(() => spawnPowerUp(), 7000);

io.on('connection', socket => {
  console.log('+ connect', socket.id);

  socket.on('join', ({ name }) => {
    const isHost = Object.keys(gameState.players).length === 0;
    if (isHost) gameState.hostId = socket.id;
    const team = assignTeam();
    gameState.players[socket.id] = {
      id: socket.id,
      name: String(name).slice(0, 12).toUpperCase() || 'PLAYER',
      hp: 100, kills: 0, deaths: 0, prestige: 0,
      pos: getSpawn(), yaw: 0, pitch: 0, weapon: 0,
      isHost, alive: true, team,
      killStreak: 0
    };
    socket.emit('joined', { id: socket.id, isHost, players: gameState.players, started: gameState.started, powerUps });
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
    // No friendly fire
    if (target.team === shooter.team) return;
    target.hp = Math.max(0, target.hp - Math.min(damage, 9999));
    io.to(targetId).emit('take_damage', { from: socket.id, damage, hp: target.hp });
    socket.emit('hit_confirmed', { targetId, damage, isHeadshot });
    if (target.hp <= 0) {
      target.alive = false; target.deaths++; target.hp = 0;
      shooter.kills++; shooter.killStreak++;
      gameState.teamScores[shooter.team] = (gameState.teamScores[shooter.team] || 0) + 1;
      const streak = shooter.killStreak;
      io.emit('player_killed', {
        killerId: socket.id, victimId: targetId,
        killerName: shooter.name, victimName: target.name,
        streak, scores: scores(), teamScores: gameState.teamScores
      });
      if (shooter.kills >= KILL_LIMIT || gameState.teamScores[shooter.team] >= KILL_LIMIT) {
        io.emit('game_over', { winnerId: socket.id, winnerName: shooter.name, winnerTeam: shooter.team, scores: scores() });
        Object.values(gameState.players).forEach(p => { p.kills = 0; p.deaths = 0; p.hp = 100; p.alive = true; p.killStreak = 0; });
        gameState.teamScores = {A:0, B:0};
        gameState.started = false;
        return;
      }
      setTimeout(() => {
        if (!gameState.players[targetId]) return;
        const t = gameState.players[targetId];
        t.hp = 100; t.alive = true; t.killStreak = 0;
        const spawn = getSpawn(); t.pos = spawn;
        io.to(targetId).emit('respawn', { pos: spawn });
        io.emit('player_respawned', { id: targetId, pos: spawn });
      }, 3000);
    }
  });

  socket.on('grenade_explode', ({ pos }) => {
    const shooter = gameState.players[socket.id];
    if (!shooter) return;
    Object.values(gameState.players).forEach(target => {
      if (!target.alive || target.id === socket.id) return;
      if (target.team === shooter.team) return;
      const dx = target.pos.x - pos.x, dz = target.pos.z - pos.z;
      const dist = Math.sqrt(dx*dx + dz*dz);
      if (dist < 6) {
        const dmg = Math.round(80 * (1 - dist / 6));
        target.hp = Math.max(0, target.hp - dmg);
        io.to(target.id).emit('take_damage', { from: socket.id, damage: dmg, hp: target.hp });
        if (target.hp <= 0) {
          target.alive = false; target.deaths++; shooter.kills++; shooter.killStreak++;
          gameState.teamScores[shooter.team] = (gameState.teamScores[shooter.team] || 0) + 1;
          io.emit('player_killed', { killerId: socket.id, victimId: target.id, killerName: shooter.name, victimName: target.name, streak: shooter.killStreak, scores: scores(), teamScores: gameState.teamScores });
          setTimeout(() => {
            if (!gameState.players[target.id]) return;
            const t = gameState.players[target.id];
            t.hp = 100; t.alive = true; t.killStreak = 0;
            const spawn = getSpawn(); t.pos = spawn;
            io.to(t.id).emit('respawn', { pos: spawn });
            io.emit('player_respawned', { id: t.id, pos: spawn });
          }, 3000);
        }
      }
    });
    socket.broadcast.emit('grenade_exploded', { pos });
  });

  socket.on('self_damage', ({ damage }) => {
    const p = gameState.players[socket.id];
    if (!p || !p.alive || damage <= 0) return;
    p.hp = Math.max(0, p.hp - Math.min(damage, 50));
    socket.emit('take_damage', { from: socket.id, damage, hp: p.hp });
  });

  socket.on('collect_powerup', ({ id }) => {
    const pu = powerUps.find(p => p.id === id);
    if (!pu) return;
    powerUps = powerUps.filter(p => p.id !== id);
    io.emit('powerup_collected', { id, collectorId: socket.id });
    const p = gameState.players[socket.id];
    if (!p) return;
    if (pu.type === 'health') { p.hp = Math.min(150, p.hp + 50); socket.emit('take_damage', { from: null, damage: -50, hp: p.hp }); }
  });

  socket.on('railgun_beam', (data) => { socket.broadcast.emit('railgun_beam', data); });

  socket.on('chat', ({ msg }) => {
    if (!msg || !msg.trim()) return;
    const p = gameState.players[socket.id];
    if (!p) return;
    io.emit('chat', { name: p.name, msg: String(msg).slice(0, 80), team: p.team, id: socket.id });
  });

  socket.on('prestige', () => {
    const p = gameState.players[socket.id];
    if (!p) return;
    p.prestige = (p.prestige || 0) + 1;
    io.emit('scores_update', scores());
  });

  socket.on('start_game', () => {
    const p = gameState.players[socket.id];
    if (!p || !p.isHost || gameState.started) return;
    gameState.started = true;
    gameState.teamScores = {A:0,B:0};
    powerUps = [];
    io.emit('game_start');
    setTimeout(() => spawnPowerUp(), 5000);
  });

  socket.on('disconnect', () => {
    const was = gameState.players[socket.id];
    const wasHost = was?.isHost;
    delete gameState.players[socket.id];
    io.emit('player_left', { id: socket.id });
    io.emit('scores_update', scores());
    const remaining = Object.values(gameState.players);
    if (remaining.length === 0) { gameState.started = false; gameState.hostId = null; powerUps = []; return; }
    if (wasHost) { remaining[0].isHost = true; gameState.hostId = remaining[0].id; io.to(remaining[0].id).emit('you_are_host'); }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log(`UpGuns server on port ${PORT}`));
