const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// Dano base dos itens (mesma ordem de ITEMS no index.html):
// Baguete, Frigideira, Garrafa, Vassoura, Coquetel, Lança, Marreta, Bomba, Arma Suprema
const ITEM_DMG = [14, 20, 16, 18, 30, 28, 34, 32, 50];
const MELEE_BASE = 30;      // dano do golpe sem item
const MELEE_RANGE = 3.2;    // alcance do golpe (igual ao cliente)
const MELEE_DOT = 0.3;      // cone de acerto (igual ao cliente)
const HIT_DELAY = 150;      // ms entre o clique e o impacto (igual ao cliente)
const MAX_THROW_DMG = 80;   // teto de dano aceito para arremessos
const MAX_THROW_DIST = 60;  // distância máxima atacante→alvo aceita para arremessos

function getRoom(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = { players: {}, started: false, over: false, loot: [] };
  }
  return rooms[roomName];
}

function newPlayer(id, name) {
  return { id, name: name || 'Jogador', x: 0, y: 1.7, z: 30, rotY: 0, health: 100, alive: true, weapon: null, lastAtk: 0, dmgCount: 0, dmgWindow: 0 };
}

function validWeapon(w) {
  return Number.isInteger(w) && w >= 0 && w < ITEM_DMG.length ? w : null;
}

// Fim de partida: sobrou 1 (ou 0) vivo
function checkWinner(roomName) {
  const room = rooms[roomName];
  if (!room || !room.started || room.over) return;
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length <= 1) {
    room.over = true;
    io.to(roomName).emit('gameOver', { winner: alive[0] ? alive[0].id : null });
  }
}

// Único lugar onde a vida muda
function applyDamage(roomName, attackerId, targetId, amount, kind) {
  const room = rooms[roomName];
  if (!room || room.over) return;
  const target = room.players[targetId];
  if (!target || !target.alive || targetId === attackerId) return;
  target.health = Math.max(0, target.health - amount);
  io.to(roomName).emit('playerHit', { id: targetId, by: attackerId, health: target.health, dmg: amount, kind });
  if (target.health <= 0) {
    target.alive = false;
    io.to(roomName).emit('playerDied', { id: targetId, killer: attackerId });
    checkWinner(roomName);
  }
  io.to(roomName).emit('updatePlayers', Object.values(room.players));
}

io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  socket.on('createRoom', (data) => {
    const room = getRoom(data.room);
    if (Object.keys(room.players).length >= 8) {
      socket.emit('error', 'Sala cheia');
      return;
    }
    room.players[socket.id] = newPlayer(socket.id, data.name);
    socket.join(data.room);
    socket.emit('joined', { id: socket.id, room: data.room, players: Object.values(room.players) });
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
  });

  socket.on('joinRoom', (data) => {
    const room = rooms[data.room];
    if (!room) {
      socket.emit('error', 'Sala não existe');
      return;
    }
    if (room.started) {
      socket.emit('error', 'Partida já começou');
      return;
    }
    if (Object.keys(room.players).length >= 8) {
      socket.emit('error', 'Sala cheia');
      return;
    }
    room.players[socket.id] = newPlayer(socket.id, data.name);
    socket.join(data.room);
    socket.emit('joined', { id: socket.id, room: data.room, players: Object.values(room.players) });
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
  });

  socket.on('startGame', (data) => {
    const room = rooms[data.room];
    if (!room) return;
    const count = Object.keys(room.players).length;
    if (count < 2) {
      socket.emit('error', 'Mínimo 2 jogadores');
      return;
    }
    room.started = true;
    room.over = false;
    Object.values(room.players).forEach(p => { p.health = 100; p.alive = true; p.weapon = null; });
    io.to(data.room).emit('gameStart');
  });

  socket.on('move', (data) => {
    const room = rooms[data.room];
    if (room && room.players[socket.id]) {
      const p = room.players[socket.id];
      p.x = data.x;
      p.y = data.y;
      p.z = data.z;
      p.rotY = data.rotY || 0;
      socket.to(data.room).emit('playerMoved', {
        id: socket.id,
        x: data.x, y: data.y, z: data.z, rotY: data.rotY
      });
    }
  });

  // Golpe corpo a corpo: o SERVIDOR decide quem foi atingido (usa as posições que ele já conhece)
  socket.on('attack', (data) => {
    const roomName = data.room, room = rooms[roomName];
    if (!room || room.over || !room.players[socket.id]) return;
    const me = room.players[socket.id];
    if (!me.alive) return;
    const now = Date.now();
    if (now - me.lastAtk < 350) return;           // anti-spam
    me.lastAtk = now;
    const w = validWeapon(data.weapon);
    const dmg = MELEE_BASE + (w !== null ? ITEM_DMG[w] : 0);
    // os outros jogadores veem o golpe
    socket.to(roomName).emit('playerAttacked', { id: socket.id, attacker: socket.id, weapon: w, dmg });
    // o impacto acontece no meio da animação
    setTimeout(() => {
      const r = rooms[roomName];
      if (!r || r.over) return;
      const a = r.players[socket.id];
      if (!a || !a.alive) return;
      const fx = -Math.sin(a.rotY || 0), fz = -Math.cos(a.rotY || 0);
      Object.values(r.players).forEach(p => {
        if (p.id === a.id || !p.alive) return;
        const dx = p.x - a.x, dz = p.z - a.z, dist = Math.hypot(dx, dz);
        if (dist < MELEE_RANGE && (dx * fx + dz * fz) / (dist || 1) > MELEE_DOT) {
          applyDamage(roomName, a.id, p.id, dmg, 'melee');
        }
      });
    }, HIT_DELAY);
  });

  // Item equipado (para os outros jogadores verem o item na mão)
  socket.on('equip', (data) => {
    const room = rooms[data.room];
    if (!room || !room.players[socket.id]) return;
    const w = validWeapon(data.weapon);
    room.players[socket.id].weapon = w;
    socket.to(data.room).emit('playerEquip', { id: socket.id, weapon: w });
  });

  // Arremesso: o servidor só repassa o voo; o acerto vem do cliente do atirador (que conhece as paredes) via 'damage'
  socket.on('throw', (data) => {
    const room = rooms[data.room];
    if (!room || room.over || !room.players[socket.id] || !room.players[socket.id].alive) return;
    const w = validWeapon(data.weapon);
    if (w === null || w === 3) return;            // 3 = Vassoura não pode ser arremessada
    room.players[socket.id].weapon = null;
    socket.to(data.room).emit('thrown', {
      id: socket.id, weapon: w,
      x: data.x, y: data.y, z: data.z, dx: data.dx, dy: data.dy, dz: data.dz
    });
  });

  socket.on('lootTaken', (data) => {
    const room = rooms[data.room];
    if (!room) return;
    socket.to(data.room).emit('lootTaken', { i: data.i, by: socket.id });
  });

  // Dano de arremesso/explosão (enviado pelo atirador). Validado: teto de dano, distância e frequência.
  socket.on('damage', (data) => {
    const room = rooms[data.room];
    if (!room || room.over) return;
    const me = room.players[socket.id], target = room.players[data.target];
    if (!me || !me.alive || !target || !target.alive || target.id === me.id) return;
    const now = Date.now();
    if (now - me.dmgWindow > 1000) { me.dmgWindow = now; me.dmgCount = 0; }
    if (++me.dmgCount > 10) return;               // no máximo 10 acertos por segundo
    if (Math.hypot(me.x - target.x, me.z - target.z) > MAX_THROW_DIST) return;
    const amount = Math.min(MAX_THROW_DMG, Math.max(1, Math.round(Number(data.amount) || 0)));
    applyDamage(data.room, socket.id, target.id, amount, 'throw');
  });

  socket.on('disconnect', () => {
    console.log('Desconectou:', socket.id);
    for (const roomName in rooms) {
      const room = rooms[roomName];
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        io.to(roomName).emit('playerLeft', socket.id);
        io.to(roomName).emit('updatePlayers', Object.values(room.players));
        if (Object.keys(room.players).length === 0) delete rooms[roomName];
        else checkWinner(roomName);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Teta Tacaro online na porta', PORT));
