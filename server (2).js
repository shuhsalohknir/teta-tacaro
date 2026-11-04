const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, 'public')));

const players = {};
const MAX_PLAYERS = 8;

io.on('connection', (socket) => {
  console.log('Jogador conectado:', socket.id);

  socket.on('join', (data) => {
    if (Object.keys(players).length >= MAX_PLAYERS) {
      socket.emit('lobbyFull');
      return;
    }

    players[socket.id] = {
      id: socket.id,
      name: data.name || 'Jogador',
      x: 0,
      y: 1.7,
      z: 30,
      health: 100,
      stats: { enemies: 0, employees: 0, customers: 0 },
      inventory: {},
      alive: true
    };

    socket.emit('joined', { id: socket.id, players: Object.values(players) });
    io.emit('playerJoined', players[socket.id]);
    io.emit('updatePlayers', Object.values(players));
  });

  socket.on('move', (pos) => {
    if (players[socket.id]) {
      players[socket.id].x = pos.x;
      players[socket.id].y = pos.y;
      players[socket.id].z = pos.z;
      players[socket.id].rotY = pos.rotY || 0;
      socket.broadcast.emit('playerMoved', {
        id: socket.id,
        x: pos.x,
        y: pos.y,
        z: pos.z,
        rotY: pos.rotY
      });
    }
  });

  socket.on('attack', (data) => {
    if (!players[socket.id] || !players[socket.id].alive) return;
    io.emit('playerAttacked', { attacker: socket.id, target: data.target });
  });

  socket.on('damage', (data) => {
    if (players[data.target] && players[data.target].alive) {
      players[data.target].health -= data.amount || 25;
      if (players[data.target].health <= 0) {
        players[data.target].alive = false;
        players[data.target].health = 0;
        if (players[socket.id]) {
          players[socket.id].stats.enemies++;
        }
        io.emit('playerDied', { id: data.target, killer: socket.id });
      }
      io.emit('updatePlayers', Object.values(players));
    }
  });

  socket.on('loot', (item) => {
    if (players[socket.id]) {
      players[socket.id].inventory[item] = (players[socket.id].inventory[item] || 0) + 1;
      socket.broadcast.emit('itemTaken', { id: socket.id, item });
    }
  });

  socket.on('disconnect', () => {
    console.log('Jogador saiu:', socket.id);
    delete players[socket.id];
    io.emit('playerLeft', socket.id);
    io.emit('updatePlayers', Object.values(players));
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Servidor Teta Tacaro rodando na porta', PORT);
});
