const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function getRoom(roomName) {
  if (!rooms[roomName]) {
    rooms[roomName] = { players: {}, started: false, loot: [] };
  }
  return rooms[roomName];
}

io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  socket.on('createRoom', (data) => {
    const room = getRoom(data.room);
    if (Object.keys(room.players).length >= 8) {
      socket.emit('error', 'Sala cheia');
      return;
    }
    room.players[socket.id] = {
      id: socket.id,
      name: data.name || 'Jogador',
      x: 0, y: 1.7, z: 30,
      health: 100,
      alive: true
    };
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
    room.players[socket.id] = {
      id: socket.id,
      name: data.name || 'Jogador',
      x: 0, y: 1.7, z: 30,
      health: 100,
      alive: true
    };
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
    io.to(data.room).emit('gameStart');
  });

  socket.on('move', (data) => {
    const room = rooms[data.room];
    if (room && room.players[socket.id]) {
      room.players[socket.id].x = data.x;
      room.players[socket.id].y = data.y;
      room.players[socket.id].z = data.z;
      room.players[socket.id].rotY = data.rotY || 0;
      socket.to(data.room).emit('playerMoved', {
        id: socket.id,
        x: data.x, y: data.y, z: data.z, rotY: data.rotY
      });
    }
  });

  socket.on('attack', (data) => {
    const room = rooms[data.room];
    if (!room || !room.players[socket.id]) return;
    socket.to(data.room).emit('playerAttacked', {
      attacker: socket.id,
      weapon: data.weapon,
      dmg: data.dmg
    });
  });

  socket.on('lootTaken', (data) => {
    const room = rooms[data.room];
    if (!room) return;
    socket.to(data.room).emit('lootTaken', { i: data.i, by: socket.id });
  });

  socket.on('damage', (data) => {
    const room = rooms[data.room];
    if (!room || !room.players[data.target]) return;
    const target = room.players[data.target];
    if (!target.alive) return;
    target.health -= data.amount || 25;
    if (target.health <= 0) {
      target.alive = false;
      target.health = 0;
      io.to(data.room).emit('playerDied', { id: data.target, killer: socket.id });
    }
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
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
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Teta Tacaro online na porta', PORT));
