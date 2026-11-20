/* map.js — Bairro (Tenda Atacado / R. Alceu Silva), baseado no print de satélite.
   Todos os DADOS estão em PIXELS do print (x p/ direita, y p/ baixo).
   PX = metros por pixel. O mundo 3D usa metros: X = x*PX, Z = y*PX.
   Uso:  GameMap.build(THREE, scene);  GameMap.groundY(X,Z);  GameMap.collide(x,z,raio)  */
(function (root) {
  const PX = 0.25;
  const B = { x0: 0, y0: 130, x1: 1080, y1: 1820 }; // área jogável (px)

  // ---------- gerador pseudo-aleatório fixo (mapa sempre igual) ----------
  let _s = 12345;
  const rnd = () => (_s = (_s * 16807) % 2147483647) / 2147483647;
  const pick = a => a[Math.floor(rnd() * a.length)];
  const WALL = [0xe8dcc0, 0xd9c7a0, 0xc9d6c4, 0xe3b9a0, 0xb8c7d9, 0xf0e6d2, 0xd8b4a0];
  const ROOF = [0xb5532f, 0xa0472a, 0xc86a3c, 0x9a3f2a];

  // fileira de casas: x,y do 1º, n casas, largura, profundidade, espaço
  function rowOf(x, y, n, w, d, gx, o) {
    o = o || {}; const a = [];
    for (let i = 0; i < n; i++) a.push({
      x: x + i * (w + gx), y, w, d, h: o.h || 3, roof: o.roof || 'pitched',
      wall: pick(WALL), roofCol: pick(ROOF),
      interior: rnd() < (o.inside === undefined ? 0.3 : o.inside), // ~30% com interior
      door: o.door || 's'
    });
    return a;
  }

  const DATA = {
    // ---- ruas (linha central + largura em px) ----
    roads: [
      { name: 'Avenida', pts: [[-60, 1055], [500, 1040], [1140, 1005]], w: 175 },
      { name: 'Rua principal', pts: [[450, 100], [450, 980]], w: 50 },
      { name: 'R. Aristeu Rodrigues da Silva', pts: [[-60, 280], [1140, 280]], w: 40 },
      { name: 'Rua oeste', pts: [[-60, 445], [450, 445]], w: 36 },
      { name: 'R. Alceu Silva', pts: [[450, 520], [1140, 520]], w: 36 },
      { name: 'R. Arnaldo Marques Carreiro', pts: [[450, 685], [1140, 685]], w: 36 },
      { name: 'Viela', pts: [[-60, 735], [450, 735]], w: 30 }
    ],
    // ---- terrenos: t = tipo, r = [x,y,w,h] ou c = [x,y,raio] ----
    lots: [
      { t: 'asphalt', r: [635, 1125, 330, 170] },   // estacionamento do Tenda
      { t: 'dirt', r: [368, 1150, 272, 670] },       // pátio de carros
      { t: 'water', c: [360, 505, 38] },             // lagoa / terreno baldio
      { t: 'dirt', r: [620, 790, 85, 100] },         // terreno baldio com entulho
      { t: 'weeds', r: [90, 1270, 230, 95] },        // mato alto
      { t: 'concrete', r: [150, 480, 100, 60] },     // quadra
      { t: 'forest', r: [830, 800, 250, 140] },
      { t: 'forest', r: [945, 1300, 135, 520] },
      { t: 'forest', r: [685, 1660, 260, 160] }
    ],
    // ---- relevo: montinhos (h>0) e depressões (h<0), em metros ----
    mounds: [
      { x: 650, y: 840, r: 45, h: 2.5 },
      { x: 210, y: 1310, r: 70, h: 1.8 },
      { x: 500, y: 1700, r: 60, h: 2.2 },
      { x: 980, y: 870, r: 60, h: 3 },
      { x: 880, y: 1760, r: 90, h: 4 },
      { x: 360, y: 505, r: 40, h: -0.7 }
    ],
    // ---- buracos na rua (x, y, raio px) ----
    holes: [
      [120, 1060, 12], [210, 1050, 10], [330, 1085, 14], [430, 1030, 9], [690, 1040, 12], [800, 1065, 10], [930, 1020, 13],
      [452, 350, 10], [448, 600, 12], [452, 800, 10], [447, 900, 9],
      [700, 520, 9], [900, 685, 10], [200, 735, 8], [120, 445, 9], [300, 280, 10], [800, 280, 9], [600, 685, 8]
    ],
    // ---- construções (x,y = canto sup. esq.; w,d em px; h em metros) ----
    buildings: [].concat(
      rowOf(20, 140, 8, 45, 55, 6, { door: 's' }),
      rowOf(20, 205, 8, 45, 50, 6, { door: 'n' }),
      rowOf(20, 330, 8, 40, 50, 6),
      rowOf(10, 560, 8, 42, 50, 6),
      rowOf(150, 640, 5, 48, 55, 5, { door: 'n' }),
      rowOf(30, 770, 3, 70, 60, 10),
      rowOf(30, 860, 3, 70, 70, 10, { door: 'n' }),
      [{ x: 330, y: 760, w: 95, d: 80, h: 7, roof: 'flat', wall: 0x9a9fa5, interior: true, door: 'e', doorW: 4 }],
      [{ x: 485, y: 715, w: 105, d: 100, h: 5, roof: 'pitched', wall: 0xe8dcc0, roofCol: 0xb5532f, interior: true, door: 'w', doorW: 2.4 }],
      rowOf(485, 140, 10, 50, 55, 6),
      rowOf(485, 205, 10, 50, 50, 6, { door: 'n' }),
      // prédios (apartamentos)
      [{ x: 490, y: 400, w: 60, d: 95, h: 12, roof: 'flat', wall: 0xd9c7b0 }, { x: 590, y: 400, w: 60, d: 95, h: 12, roof: 'flat', wall: 0xcdb9a0 },
       { x: 695, y: 400, w: 60, d: 95, h: 12, roof: 'flat', wall: 0xd9c7b0 }, { x: 830, y: 420, w: 70, d: 75, h: 12, roof: 'flat', wall: 0xcdb9a0 },
       { x: 830, y: 560, w: 70, d: 90, h: 12, roof: 'flat', wall: 0xd9c7b0 }, { x: 990, y: 400, w: 70, d: 95, h: 12, roof: 'flat', wall: 0xcdb9a0 },
       { x: 990, y: 560, w: 70, d: 90, h: 12, roof: 'flat', wall: 0xd9c7b0 }, { x: 700, y: 720, w: 60, d: 85, h: 12, roof: 'flat', wall: 0xcdb9a0 },
       { x: 850, y: 720, w: 60, d: 80, h: 12, roof: 'flat', wall: 0xd9c7b0 }, { x: 990, y: 725, w: 65, d: 80, h: 12, roof: 'flat', wall: 0xcdb9a0 }],
      rowOf(485, 570, 5, 50, 60, 6),
      [{ x: 780, y: 740, w: 45, d: 55, h: 3, roof: 'pitched', wall: 0xe3b9a0, roofCol: 0xa0472a, interior: true, door: 's' }],
      // churrasqueira
      [{ x: 40, y: 1170, w: 110, d: 80, h: 4, roof: 'pitched', wall: 0xf0e6d2, roofCol: 0x9a3f2a, interior: true, door: 's', doorW: 3 }],
      // conjunto de prédios (baixo-esquerda)
      rowOf(10, 1400, 3, 100, 70, 12, { h: 9, inside: 0, roof: 'flat' }),
      rowOf(10, 1520, 3, 100, 70, 12, { h: 9, inside: 0, roof: 'flat' }),
      rowOf(10, 1640, 3, 100, 70, 12, { h: 9, inside: 0, roof: 'flat' }),
      rowOf(10, 1745, 3, 100, 70, 12, { h: 9, inside: 0, roof: 'flat' }),
      // Tenda Atacado
      [{ x: 685, y: 1295, w: 250, d: 355, h: 11, roof: 'flat', wall: 0xd5d5d0, interior: true, door: 'n', doorW: 7, shelves: true },
       { x: 605, y: 1175, w: 55, d: 110, h: 8, roof: 'flat', wall: 0xb7b7b2 }]
    ),
    spawn: [800, 1215] // em frente ao Tenda
  };

  // ---------- altura do terreno ----------
  function groundY(X, Z) {
    const x = X / PX, y = Z / PX; let h = 0;
    for (const m of DATA.mounds) {
      const d2 = ((x - m.x) ** 2 + (y - m.y) ** 2) / (m.r * m.r);
      if (d2 < 1) h += m.h * (1 - d2) * (1 - d2);
    }
    for (const p of DATA.holes) {
      const d2 = ((x - p[0]) ** 2 + (y - p[1]) ** 2) / (p[2] * p[2]);
      if (d2 < 1) h -= 0.5 * (1 - d2) * (1 - d2);
    }
    return h;
  }

  // ---------- colisão (círculo x caixas) ----------
  const colliders = []; // [x0,z0,x1,z1] em metros
  function collide(x, z, r) {
    x = Math.min(Math.max(x, B.x0 * PX + 1), B.x1 * PX - 1);
    z = Math.min(Math.max(z, B.y0 * PX + 1), B.y1 * PX - 1);
    for (let it = 0; it < 2; it++) for (const c of colliders) {
      if (x < c[0] - r || x > c[2] + r || z < c[1] - r || z > c[3] + r) continue;
      const nx = Math.max(c[0], Math.min(x, c[2])), nz = Math.max(c[1], Math.min(z, c[3]));
      const dx = x - nx, dz = z - nz, d = Math.hypot(dx, dz);
      if (d >= r) continue;
      if (d < 1e-6) { // centro dentro da caixa: empurra pela borda mais próxima
        const l = x - c[0], rr = c[2] - x, t = z - c[1], b = c[3] - z, m = Math.min(l, rr, t, b);
        if (m === l) x = c[0] - r; else if (m === rr) x = c[2] + r; else if (m === t) z = c[1] - r; else z = c[3] + r;
      } else { x = nx + dx / d * r; z = nz + dz / d * r; }
    }
    return { x, z };
  }

  // ---------- construção 3D ----------
  function build(THREE, scene) {
    colliders.length = 0; _s = 777;
    const g = new THREE.Group(); scene.add(g);
    const mats = {};
    const mat = c => mats[c] || (mats[c] = new THREE.MeshLambertMaterial({ color: c, flatShading: true }));
    const box = (x0, z0, x1, z1, y0, y1, c) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat(c));
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); g.add(m); return m;
    };
    const solid = (x0, z0, x1, z1, h, c) => { box(x0, z0, x1, z1, 0, h, c); colliders.push([x0, z0, x1, z1]); };

    // chão base (além das montanhas)
    const far = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), mat(0x4a6b3a));
    far.rotation.x = -Math.PI / 2; far.position.set(540 * PX, -0.4, 975 * PX); g.add(far);

    // --- terreno com cores por vértice ---
    const col = c => new THREE.Color(c);
    const C = { grass: col(0x5f8a45), dirt: col(0x9b7b55), asphalt: col(0x3b3d40), concrete: col(0x9a9a95),
      water: col(0x3b6e8f), weeds: col(0x6f8f3a), forest: col(0x3f6a35), hole: col(0x1f2022) };
    const segD = (px, py, a, b) => {
      const vx = b[0] - a[0], vy = b[1] - a[1];
      const t = Math.max(0, Math.min(1, ((px - a[0]) * vx + (py - a[1]) * vy) / (vx * vx + vy * vy)));
      return Math.hypot(px - a[0] - t * vx, py - a[1] - t * vy);
    };
    const STEP = 5, M = 20;
    const tx0 = B.x0 - M, ty0 = B.y0 - M, tw = B.x1 - B.x0 + 2 * M, th = B.y1 - B.y0 + 2 * M;
    const geo = new THREE.PlaneGeometry(tw * PX, th * PX, Math.round(tw / STEP), Math.round(th / STEP));
    geo.rotateX(-Math.PI / 2); geo.translate((tx0 + tw / 2) * PX, 0, (ty0 + th / 2) * PX);
    const pos = geo.attributes.position, colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const X = pos.getX(i), Z = pos.getZ(i), x = X / PX, y = Z / PX;
      pos.setY(i, groundY(X, Z));
      let c = C.grass;
      for (const l of DATA.lots) {
        const inside = l.r ? (x >= l.r[0] && x <= l.r[0] + l.r[2] && y >= l.r[1] && y <= l.r[1] + l.r[3])
                           : Math.hypot(x - l.c[0], y - l.c[1]) <= l.c[2];
        if (inside) c = C[l.t];
      }
      let onRoad = false;
      for (const r of DATA.roads) for (let k = 0; k < r.pts.length - 1; k++)
        if (segD(x, y, r.pts[k], r.pts[k + 1]) <= r.w / 2) onRoad = true;
      if (onRoad) c = C.asphalt;
      for (const p of DATA.holes) if (Math.hypot(x - p[0], y - p[1]) < p[2] * 0.75) c = C.hole;
      const j = 0.92 + 0.16 * Math.abs(Math.sin(x * 12.9898 + y * 78.233));
      colors[i * 3] = c.r * j; colors[i * 3 + 1] = c.g * j; colors[i * 3 + 2] = c.b * j;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();
    g.add(new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true })));

    // --- paredes com porta ---
    function wallSegs(X0, Z0, X1, Z1, t, door, dw) {
      const s = [], cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
      const H = (x0, x1, z, gap) => gap ? s.push([x0, z - t / 2, cx - dw / 2, z + t / 2], [cx + dw / 2, z - t / 2, x1, z + t / 2]) : s.push([x0, z - t / 2, x1, z + t / 2]);
      const V = (z0, z1, x, gap) => gap ? s.push([x - t / 2, z0, x + t / 2, cz - dw / 2], [x - t / 2, cz + dw / 2, x + t / 2, z1]) : s.push([x - t / 2, z0, x + t / 2, z1]);
      H(X0, X1, Z0, door === 'n'); H(X0, X1, Z1, door === 's'); V(Z0, Z1, X0, door === 'w'); V(Z0, Z1, X1, door === 'e');
      return s;
    }

    for (const b of DATA.buildings) {
      const X0 = b.x * PX, Z0 = b.y * PX, X1 = (b.x + b.w) * PX, Z1 = (b.y + b.d) * PX, h = b.h, cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
      if (!b.interior) solid(X0, Z0, X1, Z1, h, b.wall);
      else {
        const dw = b.doorW || 1.6;
        wallSegs(X0, Z0, X1, Z1, 0.3, b.door, dw).forEach(s => solid(s[0], s[1], s[2], s[3], h, b.wall));
        box(X0, Z0, X1, Z1, 0, 0.06, b.shelves ? 0xbdbdb5 : 0x8a6a4a); // piso
        if (b.shelves) { // gôndolas do mercado
          for (let x = X0 + 8, i = 0; x < X1 - 8; x += 7, i++) {
            const c = i % 2 ? 0x2e7d32 : 0xc9a27a;
            solid(x, Z0 + 12, x + 1.2, cz - 3, 2.2, c); solid(x, cz + 3, x + 1.2, Z1 - 12, 2.2, c);
          }
        } else if (X1 - X0 > 5) { // divisória com passagem + mesa
          const px = X0 + (X1 - X0) * 0.62;
          solid(px - 0.1, Z0, px + 0.1, cz - 0.8, h, 0xe8e0cf); solid(px - 0.1, cz + 0.8, px + 0.1, Z1, h, 0xe8e0cf);
          solid(X0 + 1.5, cz - 0.6, X0 + 2.7, cz + 0.6, 0.8, 0x6b4a2b);
        }
      }
      // telhado
      if (b.roof === 'flat') box(X0 - 0.1, Z0 - 0.1, X1 + 0.1, Z1 + 0.1, h, h + 0.3, b.shelves ? 0xbfbfb8 : 0x8d8d88);
      else {
        const rh = 1.9, m = new THREE.Mesh(new THREE.ConeGeometry(0.7071, 1, 4), mat(b.roofCol || 0xa0472a));
        m.rotation.y = Math.PI / 4; m.scale.set((X1 - X0) * 1.08, rh, (Z1 - Z0) * 1.08);
        m.position.set(cx, h + rh / 2, cz); g.add(m);
      }
    }

    // --- carros do pátio ---
    const cars = [], carCols = [0xb0b0b0, 0x222222, 0x8a1c1c, 0xe0e0e0, 0x2a4a8a, 0x9a7b2a, 0x3a3a3a];
    for (let i = 0; i < 17; i++) { if (i % 5 === 4) continue; // corredores
      for (let y = 1180; y < 1790; y += 24) { if (rnd() < 0.08) continue;
        const x = 385 + i * 14 + (rnd() - 0.5) * 2, yy = y + (rnd() - 0.5) * 3;
        if (x > 520 && x < 565 && yy > 1450) continue; // trilha
        cars.push([x * PX, yy * PX]);
      } }
    const cm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.8, 1.4, 4.5), new THREE.MeshLambertMaterial({ flatShading: true }), cars.length);
    const dm = new THREE.Object3D(), cc = new THREE.Color();
    cars.forEach((p, i) => {
      dm.position.set(p[0], groundY(p[0], p[1]) + 0.7, p[1]); dm.rotation.y = (rnd() - 0.5) * 0.15; dm.updateMatrix();
      cm.setMatrixAt(i, dm.matrix); cm.setColorAt(i, cc.setHex(pick(carCols)));
      colliders.push([p[0] - 0.9, p[1] - 2.25, p[0] + 0.9, p[1] + 2.25]);
    });
    g.add(cm);

    // --- árvores nas áreas de mata ---
    const trees = [];
    for (const l of DATA.lots) if (l.t === 'forest') {
      const n = Math.round(l.r[2] * l.r[3] / 900);
      for (let i = 0; i < n; i++) trees.push([(l.r[0] + rnd() * l.r[2]) * PX, (l.r[1] + rnd() * l.r[3]) * PX, 0.8 + rnd() * 0.8]);
    }
    const tr = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.2, 0.3, 2, 5), mat(0x5a3d22), trees.length);
    const cr = new THREE.InstancedMesh(new THREE.ConeGeometry(1.6, 4.5, 6), mat(0x2f5f2c), trees.length);
    trees.forEach((t, i) => {
      const y = groundY(t[0], t[1]);
      dm.rotation.set(0, 0, 0); dm.scale.set(t[2], t[2], t[2]);
      dm.position.set(t[0], y + t[2], t[1]); dm.updateMatrix(); tr.setMatrixAt(i, dm.matrix);
      dm.position.set(t[0], y + 2 * t[2] + 2.2 * t[2], t[1]); dm.updateMatrix(); cr.setMatrixAt(i, dm.matrix);
      colliders.push([t[0] - 0.4, t[1] - 0.4, t[0] + 0.4, t[1] + 0.4]);
    });
    g.add(tr, cr);

    // --- montanhas em volta (limite do mapa) ---
    const mc = [0x4f6b3f, 0x5d6b45, 0x6b6a5a, 0x486042];
    const mount = (x, y) => {
      const r = (80 + rnd() * 40) * PX, h = 18 + rnd() * 24;
      const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 7), mat(pick(mc)));
      m.position.set(x * PX, h / 2 - 1, y * PX); m.rotation.y = rnd() * 6; g.add(m);
    };
    for (let x = -100; x <= B.x1 + 100; x += 60) { mount(x, B.y0 - 45); mount(x, B.y1 + 45); }
    for (let y = B.y0; y <= B.y1; y += 60) { mount(B.x0 - 45, y); mount(B.x1 + 45, y); }
    return g;
  }

  root.GameMap = { PX, bounds: B, DATA, build, groundY, collide, colliders,
    spawn: { x: DATA.spawn[0] * PX, z: DATA.spawn[1] * PX } };
})(typeof window !== 'undefined' ? window : globalThis);
