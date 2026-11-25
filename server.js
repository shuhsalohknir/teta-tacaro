const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

// ---- Editor de mapa: salva public/map.json (defina MAP_PASSWORD no servidor; sem ela a rota fica desligada) ----
const fs = require('fs');
app.post('/api/map', express.json({ limit: '1mb' }), (req, res) => {
  const pw = process.env.MAP_PASSWORD;
  if (!pw || req.get('x-map-password') !== pw) return res.status(403).json({ error: 'não autorizado' });
  const m = req.body;
  if (!Array.isArray(m) || m.length > 5000 || m.some(o => !o || typeof o.t !== 'string' || !isFinite(o.x) || !isFinite(o.z)))
    return res.status(400).json({ error: 'mapa inválido' });
  fs.writeFile(path.join(__dirname, 'map.json'), JSON.stringify(m, null, 1), err =>
    err ? res.status(500).json({ error: 'falha ao gravar' }) : res.json({ ok: true }));
});

// ---- Voz do time: servidores ICE (STUN + TURN) ----
// Sem TURN a voz falha em 4G/5G e em muitas redes (NAT restrito). Para ter voz confiável, defina no servidor:
//   TURN_URLS="turn:SEU_TURN:3478,turns:SEU_TURN:443?transport=tcp"  TURN_USER=...  TURN_CRED=...
// Se não definir, usa o relay público do OpenRelay (gratuito, mas limitado/instável).
app.get('/api/ice', (req, res) => {
  const ice = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
  if (process.env.TURN_URLS) {
    ice.push({ urls: process.env.TURN_URLS.split(',').map(u => u.trim()).filter(Boolean), username: process.env.TURN_USER || '', credential: process.env.TURN_CRED || '' });
  } else {
    ice.push({ urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' });
  }
  res.set('Access-Control-Allow-Origin', '*').json(ice);
});

const rooms = {};
const RESPAWN_MS = 15000;          // tempo caído antes de reviver (online)
// placar final: matou / morreu de cada jogador
const statsOf = room => Object.values(room.players).map(p => ({ id: p.id, name: p.name, team: p.team, kills: p.kills || 0, deaths: p.deaths || 0 }));
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
  maxHit: 80, maxHitDist: 90,       // teto de dano por acerto e distância máxima jogador→zumbi aceita
  prep: 60,                         // segundos de preparação (barricadas / subir ao telhado) antes da 1ª onda
  roofY: 5.5,                       // altura dos olhos acima da qual o jogador está no TELHADO (sniper) e os zumbis não o alcançam
  sniperHit: 170, sniperDist: 170,  // do telhado a bazuca vira sniper: dano e distância maiores são aceitos
  bossEvery: 3, bossHp: 1500, bossDmg: 26, bossRange: 2.9   // GERENTE ZUMBI: a cada 3 ondas (não conta no total de zumbis)
};
// Barricadas de caixas (modo zumbi): o servidor guarda a vida de cada caixa e retransmite colocar/reforçar/dano
const BARR = { maxSlots: 6, maxCells: 24, hp: 800, maxHit: 60, maxSpots: 32, respawnMs: 18000, stateMs: 4000 };   // hp precisa ser igual a BARR_CFG.crateHp do index.html
// Energia (disjuntor): a partida começa sem energia? (o cliente recebe isto em 'gameStart')
const POWER_START_OFF = true;
const POWER_COOLDOWN_MS = 3000;
// Eventos programados (iguais para todos): promoção relâmpago, curto-circuito, loot raro no telhado
const EVT_CFG = {
  promo: { first: [60, 80], every: [80, 115] },
  curto: { first: [95, 125], every: [110, 160] },       // só no modo batalha
  roof:  { first: 4, from: 140, every: [130, 170] },    // só no modo batalha
  graceMs: 1500                                         // folga depois que todos terminaram de carregar
};
const mulberry = a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const hashStr = str => { let h = 2166136261; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
function barrSnapshot(room) {              // estado atual de todas as caixas (vida) e de todos os pontos de caixas
  const h = {}, sp = {};
  for (const k in room.barr) if (room.barr[k] > 0) h[k] = room.barr[k];
  for (const i in room.spots) sp[i] = room.spots[i].n;
  return { h, sp };
}
function buildEvents(roomName, room) {
  const R = mulberry(hashStr(roomName + ':' + Date.now())), rr = (a, b) => a + R() * (b - a), q = [], C = EVT_CFG;
  for (let t = rr(...C.promo.first); t < 2400; t += rr(...C.promo.every)) q.push({ t, type: 'promo', seed: Math.floor(R() * 1e9) });
  if (!zombieRoom(room)) {
    for (let t = rr(...C.curto.first); t < 2400; t += rr(...C.curto.every)) q.push({ t, type: 'curto', seed: Math.floor(R() * 1e9) });
    q.push({ t: C.roof.first, type: 'roof', seed: Math.floor(R() * 1e9) });
    for (let t = C.roof.from; t < 2400; t += rr(...C.roof.every)) q.push({ t, type: 'roof', seed: Math.floor(R() * 1e9) });
  }
  q.sort((a, b) => a.t - b.t);
  room.evt = { q, began: false, t0: 0 };
}
// A cada 500 ms: dispara os eventos na hora certa (começa quando todos terminaram de carregar, no máximo 20 s)
setInterval(() => {
  const now = Date.now();
  for (const name in rooms) {
    const room = rooms[name], E = room.evt;
    if (zombieRoom(room) && room.started && !room.over && room.spots) {       // caixas: reposição nos pontos + estado completo das barricadas a cada poucos segundos
      for (const i in room.spots) { const sp = room.spots[i]; if (sp.n < sp.max && now - sp.t >= BARR.respawnMs) { sp.n++; sp.t = now; io.to(name).emit('bSpot', { i: +i, n: sp.n }); } }
      if (now - (room.barrT || 0) >= BARR.stateMs && (Object.keys(room.barr).length || Object.keys(room.spots).length)) { room.barrT = now; io.to(name).emit('bState', barrSnapshot(room)); }
    }
    if (!E || !room.started || room.over) continue;
    if (!E.began) {
      const all = Object.keys(room.players).every(id => room.ready && room.ready.has(id));
      if (!all && now - (room.startAt || now) < 20000) continue;
      E.began = true; E.t0 = now + EVT_CFG.graceMs;
    }
    const el = (now - E.t0) / 1000;
    while (E.q.length && E.q[0].t <= el) {
      const ev = E.q.shift();
      if (ev.type === 'curto') { if (!room.power || !room.power.on) continue; room.power.on = false; }   // a energia cai para todos
      io.to(name).emit('evt', { type: ev.type, seed: ev.seed });
    }
  }
}, 500);
const Z_AMMO = [3, 0, 2, 9, 1];     // itens que viram munição (mesma lista AMMO do cliente)
const zombieRoom = room => !!room && room.mode === 'zombie';
const maxPlayersOf = room => (zombieRoom(room) ? ZC.maxPlayers : MAX_PLAYERS);
function newZState(n) {
  return {
    total: ZC.total + ZC.perExtra * (n - 1), wave: ZC.wave + ZC.waveExtra * (n - 1), maxAlive: ZC.maxAlive + ZC.aliveExtra * (n - 1),
    issued: 0, kills: 0, waves: 0, waveT: ZC.waveEvery - ZC.prep, queue: [], nextId: 1,
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
  io.to(roomName).emit('gameOver', { zombie: true, win: !!win, stats: statsOf(room) });
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
    Z.began = true; Z.last = now; Z.waveT = ZC.waveEvery - ZC.prep;   // 60 s para barricar antes da 1ª onda
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
      if (ZC.bossEvery && Z.waves % ZC.bossEvery === 0) Z.queue.unshift('boss');   // GERENTE ZUMBI (fora da contagem do total)
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
  if (!z.boss && !z.crawl && z.hp > 0 && z.hp <= z.max * ZC.crawlAt) z.crawl = true;     // quase morto: se arrasta (o chefão não)
  io.to(roomName).emit('zHit', { id, hp: Math.max(0, z.hp), max: z.max, by: byId, crawl: z.crawl });
  if (z.hp <= 0) {
    Z.alive.delete(id); Z.kills++;
    if (room.players[byId]) room.players[byId].kills = (room.players[byId].kills || 0) + 1;
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
const HIT_DELAY = 200;      // ms entre o clique e o impacto com item leve (igual ao cliente)
const HIT_DELAY_HEAVY = 270;   // idem com item de duas mãos (vassoura, lança, bazuca, marreta, canhão)
const HEAVY_ITEMS = [3, 5, 6, 8, 10];
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
  return { id, name: name || 'Jogador', char: validChar(char), team: team || 0, x: 0, y: 1.7, z: 30, rotY: 0, health: 100, alive: true, weapon: null, lastAtk: 0, dmgCount: 0, dmgWindow: 0, kills: 0, deaths: 0, respawnAt: 0, spawn: null };
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
      io.to(roomName).emit('gameOver', { winner: alive[0] ? alive[0].id : null, winnerTeam: alive[0] ? alive[0].team : null, teamMode: true, stats: statsOf(room) });
    }
    return;
  }
  if (alive.length <= 1) {
    room.over = true;
    io.to(roomName).emit('gameOver', { winner: alive[0] ? alive[0].id : null, winnerTeam: null, teamMode: false, stats: statsOf(room) });
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
    target.alive = false; target.deaths = (target.deaths || 0) + 1; target.respawnAt = Date.now() + RESPAWN_MS;
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
    if (sc[0] === sc[1]) io.to(roomName).emit('gameOver', { winner: null, winnerTeam: null, teamMode: true, draw: true, timeUp: true, stats: statsOf(room) });
    else io.to(roomName).emit('gameOver', { winner: null, winnerTeam: sc[0] > sc[1] ? 0 : 1, teamMode: true, timeUp: true, stats: statsOf(room) });
  } else {
    const best = Math.max(0, ...ps.map(p => p.kills || 0)), lead = ps.filter(p => (p.kills || 0) === best);
    if (lead.length === 1) io.to(roomName).emit('gameOver', { winner: lead[0].id, winnerTeam: null, teamMode: false, timeUp: true, stats: statsOf(room) });
    else io.to(roomName).emit('gameOver', { winner: null, winnerTeam: null, teamMode: false, draw: true, timeUp: true, stats: statsOf(room) });
  }
}
function respawnSpot(room, p) { return p.spawn || SPAWNS[0]; }      // volta ao ponto onde nasceu no início
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
      ids.forEach(id => { const p = room.players[id]; p.health = 100; p.alive = true; p.weapon = null; p.team = 0; p.kills = 0; p.deaths = 0; p.respawnAt = 0; });
      room.z = newZState(count); room.hostId = ids[0];
      room.power = { on: !POWER_START_OFF, t: 0 }; room.barr = {}; room.spots = {}; room.ready = new Set(); room.startAt = Date.now(); buildEvents(data.room, room);
      io.to(data.room).emit('updatePlayers', Object.values(room.players));
      io.to(data.room).emit('gameStart', { spawns: {}, hostId: room.hostId, teamMode: false, mode: 'zombie', zTotal: room.z.total, power: room.power.on });
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
      p.health = 100; p.alive = true; p.kills = 0; p.deaths = 0; p.respawnAt = 0; p.spawn = sp; p.weapon = null; p.x = sp.x; p.z = sp.z; p.rotY = sp.ry;
      spawns[id] = sp;
    });
    room.monster = newMonster();
    room.hostId = ids[0];
    io.to(data.room).emit('updatePlayers', Object.values(room.players));
    room.endAt = Date.now() + MATCH_MS;
    room.power = { on: !POWER_START_OFF, t: 0 }; room.ready = new Set(); room.startAt = Date.now(); buildEvents(data.room, room);
    io.to(data.room).emit('gameStart', { spawns, hostId: room.hostId, teamMode, endsIn: MATCH_MS, power: room.power.on });
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

  // ==================== CARROS DIRIGÍVEIS ====================
  // Entrar no carro
  socket.on('carEnter', (data) => {
    const room = rooms[data.room];
    if (!room || room.over || !room.players[socket.id] || !room.players[socket.id].alive) return;
    if (!room.cars) room.cars = {};
    const carId = String(data.carId || 0);
    // só um motorista por carro
    if (room.cars[carId] && room.cars[carId].driver) return;
    room.cars[carId] = room.cars[carId] || { x: 0, z: 0, ry: 0, vel: 0 };
    room.cars[carId].driver = socket.id;
    socket.to(data.room).emit('carEnter', { id: socket.id, carId });
  });

  // Sair do carro
  socket.on('carExit', (data) => {
    const room = rooms[data.room];
    if (!room || !room.cars) return;
    const carId = String(data.carId || 0);
    const car = room.cars[carId];
    if (car && car.driver === socket.id) {
      car.driver = null;
      socket.to(data.room).emit('carExit', { id: socket.id, carId, x: data.x, z: data.z });
    }
  });

  // Atualização de posição do carro (só o motorista manda)
  socket.on('carUpdate', (data) => {
    const room = rooms[data.room];
    if (!room || !room.cars) return;
    const carId = String(data.carId || 0);
    const car = room.cars[carId];
    if (!car || car.driver !== socket.id) return;
    car.x = Number(data.x) || 0;
    car.z = Number(data.z) || 0;
    car.ry = Number(data.ry) || 0;
    car.vel = Number(data.vel) || 0;
    socket.to(data.room).emit('carUpdate', {
      carId, x: car.x, z: car.z, ry: car.ry, vel: car.vel, driver: socket.id
    });
  });

  // Bateu em alguém (dano + knockback)
  socket.on('carHit', (data) => {
    const room = rooms[data.room];
    if (!room || room.over || !room.players[socket.id] || !room.players[socket.id].alive) return;
    const target = room.players[data.target];
    if (!target || !target.alive || target.id === socket.id) return;
    // validação simples de distância
    if (Math.hypot(room.players[socket.id].x - target.x, room.players[socket.id].z - target.z) > 8) return;
    const amount = Math.min(35, Math.max(5, Math.round(Number(data.amount) || 12)));
    applyDamage(data.room, socket.id, target.id, amount, 'car');
    socket.to(data.room).emit('carHit', { target: data.target, by: socket.id, force: data.force || 4, ang: data.ang || 0 });
  });

  // Golpe corpo a corpo: o SERVIDOR decide quem foi atingido (usa as posições que ele já conhece)
  socket.on('attack', (data) => {
    const roomName = data.room, room = rooms[roomName];
    if (!room || room.over || !room.players[socket.id]) return;
    const me = room.players[socket.id];
    if (!me.alive) return;
    const now = Date.now();
    // anti-spam por janela (até 25 golpes/s): aceita rajadas de cliques e não perde pacotes que chegam juntos por causa da rede
    if (now - (me.atkWin || 0) > 1000) { me.atkWin = now; me.atkCount = 0; }
    if (++me.atkCount > 25) return;
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
        if (Math.abs((p.y || 1.7) - (a.y || 1.7)) > 1.8) return;   // andares diferentes (telhado / chão): o golpe não alcança
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
    }, (w !== null && HEAVY_ITEMS.includes(w)) ? HIT_DELAY_HEAVY : HIT_DELAY);
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
    const room = rooms[data.room]; if (!room) return;
    if (!room.ready) room.ready = new Set(); room.ready.add(socket.id);          // (batalha e zumbi) libera os eventos programados
    if (room.z) room.z.ready.add(socket.id);
  });
  // O host respondeu ao pedido de nascimento: o zumbi existe e todos passam a vê-lo
  socket.on('zSpawned', (data) => {
    const room = rooms[data.room], Z = room && room.z;
    if (!Z || room.hostId !== socket.id || !Z.pending.has(data.id)) return;
    const boss = Z.pending.get(data.id).kind === 'boss'; Z.pending.delete(data.id);
    const z = { id: data.id, hp: boss ? ZC.bossHp : ZC.hp, max: boss ? ZC.bossHp : ZC.hp, boss, x: Number(data.x) || 0, z: Number(data.z) || 0, crawl: false, cd: 0 };
    Z.alive.set(z.id, z);
    socket.to(data.room).emit('zSpawn', { id: z.id, x: z.x, z: z.z, ry: Number(data.ry) || 0, speed: Number(data.speed) || 2.5, boss });
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
    if ((t.y || 0) > ZC.roofY) return;                                   // quem está no telhado (sniper) os zumbis não alcançam
    if (Math.hypot(t.x - z.x, t.z - z.z) > (z.boss ? ZC.bossRange : ZC.range) + 2.5) return;
    const now = Date.now(); if (now - z.cd < ZC.atkCd) return; z.cd = now;
    applyDamage(data.room, 'zombie', t.id, z.boss ? ZC.bossDmg : Math.round(ZC.dmg * (z.crawl ? ZC.crawlDmgMul : 1)), 'zombie');
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
    const roof = (me.y || 0) > ZC.roofY;                                   // no telhado: tiro de sniper (mais forte e de mais longe)
    if (Math.hypot(me.x - z.x, me.z - z.z) > (roof ? ZC.sniperDist : ZC.maxHitDist)) return;
    zDamageZombie(data.room, z.id, Math.min(roof ? ZC.sniperHit : ZC.maxHit, Math.max(1, Math.round(Number(data.amount) || 0))), socket.id);
  });
  // Tiro da bazuca: os outros jogadores só veem o voo (o dano vem de 'zDamage')
  socket.on('zShot', (data) => {
    const room = rooms[data.room];
    if (!zombieRoom(room) || room.over || !room.players[socket.id] || !room.players[socket.id].alive) return;
    if (!Z_AMMO.includes(data.t)) return;
    socket.to(data.room).emit('zShot', { id: socket.id, t: data.t, x: data.x, y: data.y, z: data.z, dx: data.dx, dy: data.dy, dz: data.dz });
  });

  // ---- Energia: disjuntor (o cliente manda quando a pessoa termina de acionar) ----
  socket.on('powerSwitch', (data) => {
    const room = rooms[data.room];
    if (!room || !room.started || room.over || !room.power) return;
    const me = room.players[socket.id]; if (!me || !me.alive) return;
    const now = Date.now(), on = !!data.on;
    if (on === room.power.on || now - room.power.t < POWER_COOLDOWN_MS) return;
    room.power.on = on; room.power.t = now;
    socket.to(data.room).emit('powerSwitch', { on, by: socket.id });
  });

  // ---- Barricadas de caixas (modo zumbi): colocar / reforçar / dano dos zumbis (só o anfitrião, que simula os zumbis) ----
  const barrOk = (d, hostOnly) => {
    const room = rooms[d && d.room]; if (!zombieRoom(room) || !room.started || room.over || !room.barr) return null;
    const me = room.players[socket.id]; if (!me || !me.alive || (hostOnly && room.hostId !== socket.id)) return null;
    const s = d.s | 0, c = d.c | 0; if (s < 0 || s >= BARR.maxSlots || c < 0 || c >= BARR.maxCells) return null;
    return { room, k: s * 100 + c, s, c };
  };
  socket.on('bSync', (d) => {                // quem acabou de carregar pede o estado completo
    const room = rooms[d && d.room]; if (!zombieRoom(room) || !room.barr || !room.players[socket.id]) return;
    socket.emit('bState', barrSnapshot(room));
  });
  const spotOk = (d) => {
    const room = rooms[d && d.room]; if (!zombieRoom(room) || !room.started || room.over || !room.spots) return null;
    const me = room.players[socket.id]; if (!me || !me.alive) return null;
    const i = d.i | 0, max = Math.min(8, Math.max(1, d.max | 0)); if (i < 0 || i >= BARR.maxSpots) return null;
    return { room, i, max };
  };
  socket.on('bPick', (d) => {                // pegar uma caixa de um ponto: o servidor decide quem pegou a última
    const r = spotOk(d); if (!r) return;
    const sp = r.room.spots[r.i] || (r.room.spots[r.i] = { n: r.max, max: r.max, t: 0 });
    if (sp.n <= 0) { socket.emit('bDeny', { i: r.i }); socket.emit('bSpot', { i: r.i, n: 0 }); return; }
    sp.n--; sp.t = Date.now(); io.to(d.room).emit('bSpot', { i: r.i, n: sp.n });
  });
  socket.on('bPut', (d) => {                 // devolver a caixa (tecla G no coop)
    const r = spotOk(d); if (!r) return;
    const sp = r.room.spots[r.i]; if (!sp || sp.n >= sp.max) return;
    sp.n++; sp.t = Date.now(); io.to(d.room).emit('bSpot', { i: r.i, n: sp.n });
  });
  socket.on('bPlace', (d) => {
    const r = barrOk(d, false); if (!r) return;
    if ((r.room.barr[r.k] || 0) > 0) { socket.emit('bHp', { s: r.s, c: r.c, hp: r.room.barr[r.k] }); return; }   // alguém já colocou: confirma a vida
    r.room.barr[r.k] = BARR.hp; socket.to(d.room).emit('bPlace', { s: r.s, c: r.c });
  });
  socket.on('bRepair', (d) => {
    const r = barrOk(d, false); if (!r || !(r.room.barr[r.k] > 0)) return;
    r.room.barr[r.k] = BARR.hp; socket.to(d.room).emit('bRepair', { s: r.s, c: r.c });
  });
  socket.on('bHit', (d) => {
    const r = barrOk(d, true); if (!r || !(r.room.barr[r.k] > 0)) return;
    const hp = Math.max(0, r.room.barr[r.k] - Math.min(BARR.maxHit, Math.max(1, Math.round(Number(d.d) || 0))));
    r.room.barr[r.k] = hp; socket.to(d.room).emit('bHp', { s: r.s, c: r.c, hp });
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
