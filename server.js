const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, 'public')));

// ---- Editor de mapa: salva public/map.json (defina MAP_PASSWORD no servidor; sem ela a rota fica desligada) ----
const fs = require('fs');
app.post('/api/map', express.json({ limit: '1mb' }), (req, res) => {
  const pw = process.env.MAP_PASSWORD;
  if (!pw || req.get('x-map-password') !== pw) return res.status(403).json({ error: 'não autorizado' });
  const m = req.body;
  if (!Array.isArray(m) || m.length > 5000 || m.some(o => !o || typeof o.t !== 'string' || !isFinite(o.x) || !isFinite(o.z)))
    return res.status(400).json({ error: 'mapa inválido' });
  fs.writeFile(path.join(__dirname, 'public', 'map.json'), JSON.stringify(m, null, 1), err =>
    err ? res.status(500).json({ error: 'falha ao gravar' }) : res.json({ ok: true }));
});

const rooms = {};
const RESPAWN_MS = 10000;          // tempo caído antes de reviver (online)
const MATCH_MS = 10 * 60 * 1000;   // duração máxima da partida online

// ---------------------------------------------------------------------------
// MODO ATAQUE ZUMBI COOPERATIVO (até 6 jogadores)
// O servidor guarda: vida dos zumbis, cronograma das ondas, dano nos jogadores e fim de jogo.
// O anfitrião (host) só SIMULA o movimento dos zumbis (como no Homem Congelado) e manda as posições.
// Ajuste tudo aqui em ZC (os números de vida/dano valem para os dois lados).
// ---------------------------------------------------------------------------
const ZC = {
  maxPlayers: 6,
  total: 50, perExtra: 15,          // zumbis na partida = total + perExtra por jogador extra
  wave: 6, waveExtra: 2,            // zumbis por onda = wave + waveExtra por jogador extra
  waveEvery: 25, firstDelay: 3,     // segundos
  bonusEvery: 3, bonusCount: 4,     // a cada N mortos surgem N zumbis em pontos aleatórios
  maxAlive: 20, aliveExtra: 4,      // zumbis ao mesmo tempo = maxAlive + aliveExtra por jogador extra
  hp: 140, dmg: 8, range: 1.5, crawlAt: .25, crawlDmgMul: .7,
  atkCd: 800,                       // ms mínimos entre dois golpes do mesmo zumbi
  maxHit: 80, maxHitDist: 90        // teto de dano por acerto e distância máxima jogador→zumbi aceita
};
const Z_AMMO = [3, 0, 2, 9, 1];     // itens que viram munição (mesma lista AMMO do cliente)
const zombieRoom = room => !!room && room.mode === 'zombie';
const maxPlayersOf = room => (zombieRoom(room) ? ZC.maxPlayers : MAX_PLAYERS);
function newZState(n) {
  return {
    total: ZC.total + ZC.perExtra * (n - 1), wave: ZC.wave + ZC.waveExtra * (n - 1), maxAlive: ZC.maxAlive + ZC.aliveExtra * (n - 1),
    issued: 0, kills: 0, waves: 0, waveT: ZC.waveEvery - ZC.firstDelay, queue: [], nextId: 1,
    alive: new Map(), pending: new Map(), last: Date.now(), progT: 0,
    ready: new Set(), began: false, startAt: Date.now()      // as ondas só começam quando todos terminam de carregar (máx. 20 s)
  };
}
function zEnqueue(Z, kind, n) {
  n = Math.max(0, Math.min(n, Z.total - Z.issued));
  for (let i = 0; i < n; i++) Z.queue.push(kind);
  Z.issued += n; return n;
}
function zEnd(roomName, win) {
  const room = rooms[roomName]; if (!room || room.over) return;
  room.over = true;
  io.to(roomName).emit('gameOver', { zombie: true, win: !!win });
}
function checkZombieLose(roomName) {
  const room = rooms[roomName]; if (!room || !room.started || room.over || !room.z) return;
  const ps = Object.values(room.players);
  if (ps.length && ps.every(p => !p.alive)) zEnd(roomName, false);
}
// Volta os requisitos de nascimento para a fila (host trocou ou não respondeu)
function zRequeuePending(Z) {
  const kinds = [...Z.pending.values()].map(p => p.kind);
  Z.pending.clear(); Z.queue.unshift(...kinds);
}
function zTick(roomName, room, now) {
  const Z = room.z; if (!Z || !room.started || room.over) return;
  if (!Z.began) {
    const all = Object.keys(room.players).every(id => Z.ready.has(id));
    if (!all && now - Z.startAt < 20000) { Z.last = now; return; }
    Z.began = true; Z.last = now; Z.waveT = ZC.waveEvery - ZC.firstDelay;
    room.endAt = now + MATCH_MS; io.to(roomName).emit('matchTime', { endsIn: MATCH_MS });   // 10 minutos de partida
  }
  const dt = Math.min(1, (now - Z.last) / 1000); Z.last = now;
  // ondas
  if (Z.issued < Z.total) {
    Z.waveT += dt;
    if (Z.waveT >= ZC.waveEvery) {
      Z.waveT = 0; Z.waves++;
      const n = zEnqueue(Z, 'outside', Z.wave);
      if (n) io.to(roomName).emit('zWave', { n: Z.waves, count: n });
    }
  }
  // entrega os nascimentos ao anfitrião (ele escolhe o ponto e simula)
  const host = room.hostId && room.players[room.hostId] ? room.hostId : null;
  for (const [id, p] of Z.pending) if (now - p.t > 3000) { Z.pending.delete(id); Z.queue.unshift(p.kind); }   // o host não respondeu
  while (host && Z.queue.length && Z.alive.size + Z.pending.size < Z.maxAlive && Z.pending.size < 6) {
    const kind = Z.queue.shift(), id = Z.nextId++;
    Z.pending.set(id, { kind, t: now });
    io.to(host).emit('zSpawnReq', { id, kind });
  }
  // progresso para o HUD (1x por segundo)
  Z.progT += dt;
  if (Z.progT >= 1) {
    Z.progT = 0;
    io.to(roomName).emit('zProgress', {
      kills: Z.kills, issued: Z.issued, total: Z.total, alive: Z.alive.size + Z.pending.size + Z.queue.length,
      waveIn: Z.issued >= Z.total ? -1 : Math.max(0, Math.ceil(ZC.waveEvery - Z.waveT)),
      players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, health: p.health, alive: p.alive }))
    });
  }
}
function zDamageZombie(roomName, id, amount, byId) {
  const room = rooms[roomName], Z = room && room.z; if (!Z || room.over) return;
  const z = Z.alive.get(id); if (!z) return;
  z.hp -= amount;
  if (!z.crawl && z.hp > 0 && z.hp <= z.max * ZC.crawlAt) z.crawl = true;     // quase morto: se arrasta
  io.to(roomName).emit('zHit', { id, hp: Math.max(0, z.hp), max: z.max, by: byId, crawl: z.crawl });
  if (z.hp <= 0) {
    Z.alive.delete(id); Z.kills++;
    io.to(roomName).emit('zDead', { id, by: byId });
    if (Z.kills % ZC.bonusEvery === 0) { const n = zEnqueue(Z, 'random', ZC.bonusCount); if (n) io.to(roomName).emit('zBonus', { n }); }
    if (Z.kills >= Z.total) setTimeout(() => zEnd(roomName, true), 1200);
  }
}
setInterval(() => { const now = Date.now(); for (const name in rooms) { const r = rooms[name]; if (zombieRoom(r)) zTick(name, r, now); } }, 200);

// Dano base dos itens (mesma ordem de ITEMS no index.html):
// Baguete, Frigideira, Garrafa, Vassoura, Coquetel, Lança, Marreta, Bomba, Arma Suprema, Presunto, Canhão de Presunto
const ITEM_DMG = [14, 20, 16, 18, 30, 28, 34, 32, 50, 26, 24];
const MELEE_BASE = 30;      // dano do golpe sem item
const MELEE_RANGE = 3.2;    // alcance do golpe (igual ao cliente)
const MELEE_DOT = 0.3;      // cone de acerto (igual ao cliente)
const HIT_DELAY = 150;      // ms entre o clique e o impacto (igual ao cliente)
const MAX_THROW_DMG = 80;   // teto de dano aceito para arremessos
const MAX_THROW_DIST = 60;  // distância máxima atacante→alvo aceita para arremessos

// Pontos de nascimento (jogador 1 e 2 em cantos opostos, 3 e 4 também…). ry = direção do olhar (0 = -Z, π = +Z)
const SPAWNS = [
  { x: -24, z: 36, ry: 0 },        // fora, entrada esquerda
  { x: 34, z: -33, ry: Math.PI },  // doca (canto oposto)
  { x: 24, z: 36, ry: 0 },         // fora, saída direita
  { x: -34, z: -33, ry: Math.PI }, // estoque, lado das câmaras (oposto ao anterior)
  { x: 30, z: 18, ry: 0 },
  { x: -30, z: 18, ry: 0 },
  { x: 6, z: -34, ry: Math.PI },
  { x: 0, z: 20, ry: 0 }
];

// Homem Congelado (simulado pelo anfitrião; o servidor guarda vida/posição e valida os danos)
const FREEZER = { x1: -68, x2: -48, z1: -64, z2: -46 };
const MONSTER_HP = 600;
const inFreezer = (x, z) => x > FREEZER.x1 && x < FREEZER.x2 && z > FREEZER.z1 && z < FREEZER.z2;
function newMonster() { return { x: -58, z: -60, rotY: 0, hp: MONSTER_HP, max: MONSTER_HP, awake: false, dead: false, cd: {} }; }
function damageMonster(roomName, amount, byId) {
  const r = rooms[roomName], m = r && r.monster;
  if (!m || !m.awake || m.dead) return;
  if (inFreezer(m.x, m.z)) { io.to(byId).emit('monsterImmune'); return; }   // invulnerável na ala de congelados
  m.hp = Math.max(0, m.hp - amount);
  io.to(roomName).emit('monsterHit', { hp: m.hp, max: m.max });
  if (m.hp <= 0) { m.dead = true; io.to(roomName).emit('monsterDead'); }
}

function getRoom(roomName, mode) {
  if (!rooms[roomName]) {
    rooms[roomName] = { players: {}, started: false, over: false, loot: [], hostId: null, monster: newMonster(), mode: mode === 'zombie' ? 'zombie' : 'versus', z: null };
  }
  return rooms[roomName];
}

const CHARS = ['businessman', 'adventurer', 'witch'];
const MAX_PLAYERS = 8, MAX_PER_TEAM = 4;
const validChar = c => (CHARS.includes(c) ? c : CHARS[0]);
const teamCount = (room, t) => Object.values(room.players).filter(p => p.team === t).length;
// novo jogador entra no time com menos gente (0 = Azul, 1 = Vermelho)
const pickTeam = room => (teamCount(room, 0) <= teamCount(room, 1) ? 0 : 1);

function newPlayer(id, name, char, team) {
  return { id, name: name || 'Jogador', char: validChar(char), team: team || 0, x: 0, y: 1.7, z: 30, rotY: 0, health: 100, alive: true, weapon: null, lastAtk: 0, dmgCount: 0, dmgWindow: 0, kills: 0, respawnAt: 0 };
}

function validWeapon(w) {
  return Number.isInteger(w) && w >= 0 && w < ITEM_DMG.length ? w : null;
}

// Fim de partida: sobrou 1 (ou 0) vivo
function checkWinner(roomName) {
  const room = rooms[roomName];
  if (!room || !room.started || room.over) return;
  if (zombieRoom(room)) { checkZombieLose(roomName); return; }       // no modo zumbi só perde quando TODOS caem
  const alive = Object.values(room.players).filter(p => p.alive);
  if (room.teamMode) {
    // vence o último time com alguém vivo
    const teams = new Set(alive.map(p => p.team));
    if (teams.size <= 1) {
      room.over = true;
      io.to(roomName).emit('gameOver', { winner: alive[0] ? alive[0].id : null, winnerTeam: alive[0] ? alive[0].team : null, teamMode: true });
    }
    return;
  }
  if (alive.length <= 1) {
    room.over = true;
    io.to(roomName).emit('gameOver', { winner: alive[0] ? alive[0].id : null, winnerTeam: null, teamMode: false });
  }
}

// Único lugar onde a vida muda
function applyDamage(roomName, attackerId, targetId, amount, kind) {
  const room = rooms[roomName];
  if (!room || room.over) return;
  const target = room.players[targetId];
  if (!target || !target.alive || targetId === attackerId) return;
  // fogo amigo desligado: jogadores do mesmo time não se machucam
  const attacker = room.players[attackerId];
  if (room.teamMode && attacker && attacker.team === target.team) return;
  target.health = Math.max(0, target.health - amount);
  io.to(roomName).emit('playerHit', { id: targetId, by: attackerId, health: target.health, dmg: amount, kind });
  if (target.health <= 0) {
    target.alive = false; target.respawnAt = Date.now() + RESPAWN_MS;
    if (attacker && !zombieRoom(room)) attacker.kills = (attacker.kills || 0) + 1;
    io.to(roomName).emit('playerDied', { id: targetId, killer: attackerId, respawnIn: RESPAWN_MS / 1000 });
    checkWinner(roomName);
  }
  io.to(roomName).emit('updatePlayers', Object.values(room.players));
}

// Fim por tempo (10 min): modo zumbi = derrota; batalha = vence quem tiver mais abates (empate = empate)
function endByTime(roomName, room) {
  if (zombieRoom(room)) { zEnd(roomName, false); return; }
  room.over = true;
  const ps = Object.values(room.players);
  if (room.teamMode) {
    const sc = [0, 0]; ps.forEach(p => { sc[p.team] += p.kills || 0; });
    if (sc[0] === sc[1]) io.to(roomName).emit('gameOver', { winner: null, winnerTeam: null, teamMode: true, draw: true, timeUp: true });
    else io.to(roomName).emit('gameOver', { winner: null, winnerTeam: sc[0] > sc[1] ? 0 : 1, teamMode: true, timeUp: true });
  } else {
    const best = Math.max(0, ...ps.map(p => p.kills || 0)), lead = ps.filter(p => (p.kills || 0) === best);
    if (lead.length === 1) io.to(roomName).emit('gameOver', { winner: lead[0].id, winnerTeam: null, teamMode: false, timeUp: true });
    else io.to(roomName).emit('gameOver', { winner: null, winnerTeam: null, teamMode: false, draw: true, timeUp: true });
  }
}
function respawnSpot(room, p) {
  const pool = room.teamMode ? SPAWNS.filter((_, i) => i % 2 === p.team) : SPAWNS;
  return pool[(Math.random() * pool.length) | 0];
}
// A cada 250 ms: revive quem passou 10 s caído e encerra a partida quando o tempo acaba
setInterval(() => {
  const now = Date.now();
  for (const name in rooms) {
    const room = rooms[name];
    if (!room.started || room.over) continue;
    if (room.endAt && now >= room.endAt) { endByTime(name, room); continue; }
    let changed = false;
    for (const p of Object.values(room.players)) {
      if (p.alive || !p.respawnAt || now < p.respawnAt) continue;
      p.alive = true; p.health = 100; p.respawnAt = 0; changed = true;
      if (zombieRoom(room)) io.to(name).emit('zRevive', { id: p.id });
      else {
        const sp = respawnSpot(room, p); p.x = sp.x; p.z = sp.z; p.rotY = sp.ry;
        io.to(name).emit('playerRespawn', { id: p.id, x: sp.x, z: sp.z, ry: sp.ry });
      }
    }
    if (changed) io.to(name).emit('updatePlayers', Object.values(room.players));
  }
}, 250);

io.on('connection', (socket) => {
  console.log('Conectado:', socket.id);

  socket.on('createRoom', (data) => {
    const room = getRoom(data.room, data.mode);
    if (room.started) { socket.emit('error', 'Partida já começou'); return; }
    if (Object.keys(room.players).length >= maxPlayersOf(room)) {
      socket.emit('error', 'Sala cheia');
      return;
    }
    room.players[socket.id] = newPlayer(socket.id, data.name, data.char, zombieRoom(room) ? 0 : pickTeam(room));
    socket.join(data.room);
    socket.emit('joined', { id: socket.id, room: data.room, mode: room.mode, players: Object.values(room.players) });
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
    if (Object.keys(room.players).length >= maxPlayersOf(room)) {
      socket.emit('error', 'Sala cheia');
      return;
    }
    room.players[socket.id] = newPlayer(socket.id, data.name, data.char, zombieRoom(room) ? 0 : pickTeam(room));
    socket.join(data.room);
    socket.emit('joined', { id: socket.id, room: data.room, mode: room.mode, players: Object.values(room.players) });
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
  });

  // Lobby: escolher personagem
  socket.on('setChar', (data) => {
    const room = rooms[data.room];
    if (!room || room.started || !room.players[socket.id]) return;
    room.players[socket.id].char = validChar(data.char);
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
  });

  // Lobby: trocar de time (máx. 4 por time)
  socket.on('setTeam', (data) => {
    const room = rooms[data.room];
    if (!room || room.started || !room.players[socket.id] || zombieRoom(room)) return;
    const t = data.team === 1 ? 1 : 0, me = room.players[socket.id];
    if (me.team === t) return;
    if (teamCount(room, t) >= MAX_PER_TEAM) { socket.emit('error', 'Esse time já está cheio (4)'); return; }
    me.team = t;
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
  });

  socket.on('startGame', (data) => {
    const room = rooms[data.room];
    if (!room || room.started) return;
    const ids = Object.keys(room.players), count = ids.length;
    if (zombieRoom(room)) {                       // ATAQUE ZUMBI COOPERATIVO: 1 a 6 jogadores, todos no mesmo time
      if (count < 1) return;
      room.started = true; room.over = false; room.teamMode = false;
      ids.forEach(id => { const p = room.players[id]; p.health = 100; p.alive = true; p.weapon = null; p.team = 0; p.kills = 0; p.respawnAt = 0; });
      room.z = newZState(count); room.hostId = ids[0];
      io.to(data.room).emit('updatePlayers', Object.values(room.players));
      io.to(data.room).emit('gameStart', { spawns: {}, hostId: room.hostId, teamMode: false, mode: 'zombie', zTotal: room.z.total });
      return;
    }
    if (count < 2) {
      socket.emit('error', 'Mínimo 2 jogadores');
      return;
    }
    // 3+ jogadores = times (cada time precisa de ao menos 1); 2 jogadores = duelo 1x1
    const teamMode = count > 2;
    if (teamMode && (teamCount(room, 0) === 0 || teamCount(room, 1) === 0)) {
      socket.emit('error', 'Cada time precisa de ao menos 1 jogador');
      return;
    }
    room.started = true;
    room.over = false;
    room.teamMode = teamMode;
    const spawns = {}, used = [0, 0];
    ids.forEach((id, i) => {
      const p = room.players[id];
      // time Azul nasce nos cantos pares (sul), time Vermelho nos ímpares (norte)
      const si = teamMode ? (p.team + 2 * used[p.team]++) : i;
      const sp = SPAWNS[si % SPAWNS.length];
      p.health = 100; p.alive = true; p.kills = 0; p.respawnAt = 0; p.weapon = null; p.x = sp.x; p.z = sp.z; p.rotY = sp.ry;
      spawns[id] = sp;
    });
    room.monster = newMonster();
    room.hostId = ids[0];
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
    room.endAt = Date.now() + MATCH_MS;
    io.to(data.room).emit('gameStart', { spawns, hostId: room.hostId, teamMode, endsIn: MATCH_MS });
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
    if (zombieRoom(room)) return;                 // no modo zumbi o dano vem dos eventos 'zDamage'
    // o impacto acontece no meio da animação
    setTimeout(() => {
      const r = rooms[roomName];
      if (!r || r.over) return;
      const a = r.players[socket.id];
      if (!a || !a.alive) return;
      const fx = -Math.sin(a.rotY || 0), fz = -Math.cos(a.rotY || 0);
      Object.values(r.players).forEach(p => {
        if (p.id === a.id || !p.alive) return;
        if (r.teamMode && p.team === a.team) return;   // sem fogo amigo
        const dx = p.x - a.x, dz = p.z - a.z, dist = Math.hypot(dx, dz);
        if (dist < MELEE_RANGE && (dx * fx + dz * fz) / (dist || 1) > MELEE_DOT) {
          applyDamage(roomName, a.id, p.id, dmg, 'melee');
        }
      });
      const mo = r.monster;
      if (mo && mo.awake && !mo.dead) {
        const dx = mo.x - a.x, dz = mo.z - a.z, dist = Math.hypot(dx, dz);
        if (dist < MELEE_RANGE + .4 && (dx * fx + dz * fz) / (dist || 1) > MELEE_DOT) damageMonster(roomName, dmg, a.id);
      }
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
    if (w !== 6 && w !== 10) room.players[socket.id].weapon = null;   // 6 = Bazuca, 10 = Canhão de Presunto: continuam na mão
    socket.to(data.room).emit('thrown', {
      id: socket.id, weapon: w,
      x: data.x, y: data.y, z: data.z, dx: data.dx, dy: data.dy, dz: data.dz
    });
  });

  // ---- Homem Congelado ----
  socket.on('monsterWake', (data) => {
    const room = rooms[data.room];
    if (!room || room.hostId !== socket.id || room.monster.awake || room.monster.dead) return;
    room.monster.awake = true;
    socket.to(data.room).emit('monsterWake');
  });
  socket.on('monsterSim', (data) => {
    const room = rooms[data.room];
    if (!room || room.hostId !== socket.id || !room.monster.awake || room.monster.dead) return;
    const m = room.monster;
    m.x = Number(data.x) || 0; m.z = Number(data.z) || 0; m.rotY = Number(data.rotY) || 0;
    socket.to(data.room).emit('monsterState', { x: m.x, z: m.z, rotY: m.rotY, atk: data.atk | 0 });
  });
  socket.on('monsterAttack', (data) => {
    const room = rooms[data.room];
    if (!room || room.over || room.hostId !== socket.id) return;
    const m = room.monster, t = room.players[data.target];
    if (!m.awake || m.dead || !t || !t.alive) return;
    if (Math.hypot(t.x - m.x, t.z - m.z) > 5) return;
    const now = Date.now();
    if (now - (m.cd[t.id] || 0) < 700) return;
    m.cd[t.id] = now;
    applyDamage(data.room, 'monster', t.id, Math.min(35, Math.max(1, Math.round(Number(data.amount) || 25))), 'monster');
  });
  socket.on('monsterDamage', (data) => {      // arremesso/explosão do atirador
    const room = rooms[data.room];
    if (!room || room.over) return;
    const me = room.players[socket.id], m = room.monster;
    if (!me || !me.alive || !m.awake || m.dead) return;
    if (Math.hypot(me.x - m.x, me.z - m.z) > 60) return;
    damageMonster(data.room, Math.min(MAX_THROW_DMG, Math.max(1, Math.round(Number(data.amount) || 0))), socket.id);
  });

  // ---- Modo zumbi cooperativo ----
  socket.on('zReady', (data) => {                // o jogador terminou de carregar o mapa
    const room = rooms[data.room]; if (room && room.z) room.z.ready.add(socket.id);
  });
  // O host respondeu ao pedido de nascimento: o zumbi existe e todos passam a vê-lo
  socket.on('zSpawned', (data) => {
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.hostId !== socket.id || !Z.pending.has(data.id)) return;
    Z.pending.delete(data.id);
    const z = { id: data.id, hp: ZC.hp, max: ZC.hp, x: Number(data.x) || 0, z: Number(data.z) || 0, crawl: false, cd: 0 };
    Z.alive.set(z.id, z);
    socket.to(data.room).emit('zSpawn', { id: z.id, x: z.x, z: z.z, ry: Number(data.ry) || 0, speed: Number(data.speed) || 2.5 });
  });
  socket.on('zSpawnFail', (data) => {            // o host não achou lugar livre: volta para a fila
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.hostId !== socket.id) return;
    const p = Z.pending.get(data.id); if (!p) return;
    Z.pending.delete(data.id); Z.queue.unshift(p.kind);
  });
  // Posições de todos os zumbis (só o host manda): ~10x por segundo
  socket.on('zSim', (data) => {
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.hostId !== socket.id || !Array.isArray(data.z) || data.z.length > 200) return;
    const out = [];
    for (const a of data.z) {
      if (!Array.isArray(a)) continue;
      const z = Z.alive.get(a[0]); if (!z) continue;
      z.x = Number(a[1]) || 0; z.z = Number(a[2]) || 0;
      out.push([a[0], z.x, z.z, Number(a[3]) || 0, a[4] | 0]);
    }
    socket.to(data.room).emit('zSim', { z: out });
  });
  // O host diz que um zumbi acertou um jogador; o servidor confere distância e intervalo
  socket.on('zAttack', (data) => {
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.over || room.hostId !== socket.id) return;
    const z = Z.alive.get(data.id), t = room.players[data.target];
    if (!z || !t || !t.alive) return;
    if (Math.hypot(t.x - z.x, t.z - z.z) > ZC.range + 2.5) return;
    const now = Date.now(); if (now - z.cd < ZC.atkCd) return; z.cd = now;
    applyDamage(data.room, 'zombie', t.id, Math.round(ZC.dmg * (z.crawl ? ZC.crawlDmgMul : 1)), 'zombie');
  });
  // Qualquer jogador acertou um zumbi (projétil ou golpe)
  socket.on('zDamage', (data) => {
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.over) return;
    const me = room.players[socket.id], z = Z.alive.get(data.id);
    if (!me || !me.alive || !z) return;
    const now = Date.now();
    if (now - me.dmgWindow > 1000) { me.dmgWindow = now; me.dmgCount = 0; }
    if (++me.dmgCount > 15) return;                                           // no máximo 15 acertos por segundo
    if (Math.hypot(me.x - z.x, me.z - z.z) > ZC.maxHitDist) return;
    zDamageZombie(data.room, z.id, Math.min(ZC.maxHit, Math.max(1, Math.round(Number(data.amount) || 0))), socket.id);
  });
  // Tiro da bazuca: os outros jogadores só veem o voo (o dano vem de 'zDamage')
  socket.on('zShot', (data) => {
    const room = rooms[data.room];
    if (!zombieRoom(room) || room.over || !room.players[socket.id] || !room.players[socket.id].alive) return;
    if (!Z_AMMO.includes(data.t)) return;
    socket.to(data.room).emit('zShot', { id: socket.id, t: data.t, x: data.x, y: data.y, z: data.z, dx: data.dx, dy: data.dy, dz: data.dz });
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
    if (zombieRoom(room)) return;                 // cooperativo: sem dano entre jogadores
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
        else {
          if (room.hostId === socket.id) {
            room.hostId = Object.keys(room.players)[0]; io.to(roomName).emit('monsterHost', { id: room.hostId });
            if (room.z) zRequeuePending(room.z);        // o novo host assume os zumbis que já existem
          }
          checkWinner(roomName);
        }
      }
    }
  });

  // ---- Voz do time (WebRTC signaling) ----
  // O cliente envia { to, type, sdp/candidate, from } e o servidor só retransmite para o destinatário.
  socket.on('voiceSignal', (data) => {
    if (!data || !data.to || !data.from) return;
    // Encontra a sala do remetente e verifica se o destinatário está na mesma sala e no mesmo time
    let senderRoom = null, senderTeam = null, targetTeam = null;
    for (const roomName in rooms) {
      const room = rooms[roomName];
      if (room.players[socket.id]) {
        senderRoom = roomName;
        senderTeam = room.players[socket.id].team;
        if (room.players[data.to]) targetTeam = room.players[data.to].team;
        break;
      }
    }
    if (!senderRoom || targetTeam === null || senderTeam !== targetTeam) return;  // só mesmo time
    // retransmite com o from correto
    data.from = socket.id;
    io.to(data.to).emit('voiceSignal', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Teta Tacaro online na porta', PORT));
