'use strict';
// PixelSynth: secuenciador chiptune de 4 canales con Web Audio.
const PASOS = 16, FILAS = 8;
const ESCALAS = {
  'Pentatónica menor': [0, 3, 5, 7, 10],
  'Pentatónica mayor': [0, 2, 4, 7, 9],
  'Menor natural': [0, 2, 3, 5, 7, 8, 10],
  'Dórica': [0, 2, 3, 5, 7, 9, 10],
  'Mayor': [0, 2, 4, 5, 7, 9, 11],
  'Frigia': [0, 1, 3, 5, 7, 8, 10],
};
const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const PISTAS = [
  { id: 'p1', nombre: 'PULSO 1', sub: 'lead · onda cuadrada', c: '#ff2e88', tipo: 'nota', oct: 5, onda: 'square', dur: .9 },
  { id: 'p2', nombre: 'PULSO 2', sub: 'arpegio · pulso 25 %', c: '#22e6ff', tipo: 'nota', oct: 4, onda: 'pulso', dur: .5 },
  { id: 'tri', nombre: 'TRIÁNGULO', sub: 'bajo', c: '#ffe14d', tipo: 'nota', oct: 2, onda: 'triangle', dur: 1.6 },
  { id: 'ruido', nombre: 'RUIDO', sub: 'batería', c: '#3dff8a', tipo: 'bateria', filas: ['BOMBO', 'CAJA', 'HAT', 'HAT ABIERTO'] },
];

const estado = {
  bpm: 128, swing: 0, escala: 'Pentatónica menor', tono: 9,
  grilla: {}, vol: { p1: .7, p2: .5, tri: .8, ruido: .7 }, mute: {},
};
PISTAS.forEach(p => estado.grilla[p.id] = Array.from({ length: p.filas ? p.filas.length : FILAS }, () => Array(PASOS).fill(0)));

const $ = s => document.querySelector(s);
let ctx, master, analizador, ondaPulso, bufRuido;
let tocando = false, paso = 0, proximo = 0, timer = null;

// ---------- audio ----------
function prepararAudio(c) {
  const m = c.createGain(); m.gain.value = .55;
  const comp = c.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
  m.connect(comp); comp.connect(c.destination);
  // pulso 25 %: serie de Fourier
  const n = 64, re = new Float32Array(n), im = new Float32Array(n);
  for (let k = 1; k < n; k++) im[k] = 2 / (k * Math.PI) * Math.sin(k * Math.PI * .25);
  const pulso = c.createPeriodicWave(re, im);
  const b = c.createBuffer(1, c.sampleRate, c.sampleRate), d = b.getChannelData(0);
  let lfsr = 1; // ruido de registro de desplazamiento, como las consolas de 8 bits
  for (let i = 0; i < d.length; i++) { const bit = (lfsr ^ (lfsr >> 1)) & 1; lfsr = (lfsr >> 1) | (bit << 14); d[i] = (lfsr & 1) ? .9 : -.9; }
  return { m, comp, pulso, ruido: b };
}

function iniciar() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  const a = prepararAudio(ctx);
  master = a.m; ondaPulso = a.pulso; bufRuido = a.ruido;
  analizador = ctx.createAnalyser(); analizador.fftSize = 1024; a.comp.connect(analizador);
  dibujarOsc();
}

function frecuencia(pista, fila) {
  const esc = ESCALAS[estado.escala];
  const grado = fila % esc.length, oct = Math.floor(fila / esc.length);
  const midi = 12 * (pista.oct + 1 + oct) + estado.tono + esc[grado];
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function nombreNota(pista, fila) {
  const esc = ESCALAS[estado.escala];
  const st = estado.tono + esc[fila % esc.length];
  return NOTAS[st % 12] + (pista.oct + Math.floor(fila / esc.length) + Math.floor(st / 12));
}

function tocarNota(c, destino, pista, fila, t, seg, pulsoW) {
  const o = c.createOscillator(), g = c.createGain();
  if (pista.onda === 'pulso') o.setPeriodicWave(pulsoW); else o.type = pista.onda;
  o.frequency.value = frecuencia(pista, fila);
  if (pista.id === 'p1') { // vibrato corto
    const l = c.createOscillator(), lg = c.createGain(); l.frequency.value = 6; lg.gain.value = 4;
    l.connect(lg); lg.connect(o.frequency); l.start(t + .08); l.stop(t + seg * pista.dur + .05);
  }
  const v = estado.vol[pista.id] * (pista.id === 'tri' ? .5 : .16), fin = t + seg * pista.dur;
  g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(v, t + .005);
  g.gain.setValueAtTime(v * .8, fin - .02); g.gain.linearRampToValueAtTime(0, fin);
  o.connect(g); g.connect(destino); o.start(t); o.stop(fin + .02);
}

function tocarBateria(c, destino, fila, t, ruido) {
  const v = estado.vol.ruido;
  if (fila === 0) { // bombo: barrido de triángulo
    const o = c.createOscillator(), g = c.createGain(); o.type = 'triangle';
    o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(40, t + .12);
    g.gain.setValueAtTime(v, t); g.gain.exponentialRampToValueAtTime(.001, t + .2);
    o.connect(g); g.connect(destino); o.start(t); o.stop(t + .22); return;
  }
  const s = c.createBufferSource(), g = c.createGain(), f = c.createBiquadFilter();
  s.buffer = ruido;
  const largo = [0, .14, .04, .22][fila];
  f.type = fila === 1 ? 'bandpass' : 'highpass'; f.frequency.value = fila === 1 ? 1800 : 7000;
  s.playbackRate.value = fila === 1 ? .6 : 1;
  g.gain.setValueAtTime(v * (fila === 1 ? .7 : .35), t); g.gain.exponentialRampToValueAtTime(.001, t + largo);
  s.connect(f); f.connect(g); g.connect(destino); s.start(t, Math.random() * .5); s.stop(t + largo + .02);
}

function programarPaso(c, destino, i, t, seg, pulsoW, ruido) {
  PISTAS.forEach(p => {
    if (estado.mute[p.id]) return;
    estado.grilla[p.id].forEach((fila, f) => {
      if (!fila[i]) return;
      if (p.tipo === 'bateria') tocarBateria(c, destino, f, t, ruido);
      else tocarNota(c, destino, p, f, t, seg, pulsoW);
    });
  });
}

function duracionPaso() { return 60 / estado.bpm / 4; }

function programador() {
  while (proximo < ctx.currentTime + .12) {
    const seg = duracionPaso();
    const t = proximo + (paso % 2 ? seg * estado.swing / 100 : 0);
    programarPaso(ctx, master, paso, t, seg, ondaPulso, bufRuido);
    const p = paso, retraso = (t - ctx.currentTime) * 1000;
    setTimeout(() => marcar(p), Math.max(0, retraso));
    proximo += seg; paso = (paso + 1) % PASOS;
  }
}

function play() {
  iniciar(); ctx.resume();
  tocando = !tocando;
  $('#play').classList.toggle('on', tocando);
  $('#play').textContent = tocando ? '■ STOP' : '▶ PLAY';
  if (tocando) { paso = 0; proximo = ctx.currentTime + .05; timer = setInterval(programador, 25); }
  else { clearInterval(timer); marcar(-1); }
}

// ---------- interfaz ----------
let pintando = null;
function construir() {
  const main = $('#pistas'); main.innerHTML = '';
  PISTAS.forEach(p => {
    const div = document.createElement('section'); div.className = 'pista'; div.style.setProperty('--c', p.c);
    div.innerHTML = `<h2>${p.nombre} <small>${p.sub}</small><button class="mute" data-p="${p.id}">MUTE</button>
      <label>VOL <input type="range" min="0" max="1" step=".05" value="${estado.vol[p.id]}" data-v="${p.id}"></label></h2>`;
    const r = document.createElement('div'); r.className = 'rejilla';
    const n = estado.grilla[p.id].length;
    for (let f = n - 1; f >= 0; f--) {
      const e = document.createElement('div'); e.className = 'fila-n'; e.dataset.p = p.id; e.dataset.f = f;
      e.textContent = p.filas ? p.filas[f] : nombreNota(p, f); r.appendChild(e);
      for (let i = 0; i < PASOS; i++) {
        const c = document.createElement('div');
        c.className = 'celda' + (i % 4 === 0 && i ? ' g4' : '') + (estado.grilla[p.id][f][i] ? ' on' : '');
        c.dataset.p = p.id; c.dataset.f = f; c.dataset.i = i; r.appendChild(c);
      }
    }
    div.appendChild(r); main.appendChild(div);
  });
  main.querySelectorAll('.mute').forEach(b => {
    b.classList.toggle('on', !!estado.mute[b.dataset.p]);
    b.onclick = () => { estado.mute[b.dataset.p] = !estado.mute[b.dataset.p]; b.classList.toggle('on'); };
  });
  main.querySelectorAll('[data-v]').forEach(i => i.oninput = () => estado.vol[i.dataset.v] = +i.value);
}

function etiquetas() {
  document.querySelectorAll('.fila-n').forEach(e => {
    const p = PISTAS.find(x => x.id === e.dataset.p);
    if (!p.filas) e.textContent = nombreNota(p, +e.dataset.f);
  });
}

function celdaDesde(ev) {
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  return el && el.classList.contains('celda') ? el : null;
}
function aplicar(c, valor) {
  const { p, f, i } = c.dataset;
  if (estado.grilla[p][f][i] === valor) return;
  estado.grilla[p][f][i] = valor; c.classList.toggle('on', !!valor);
  if (valor && ctx && !tocando) { // vista previa
    const pista = PISTAS.find(x => x.id === p);
    if (pista.tipo === 'bateria') tocarBateria(ctx, master, +f, ctx.currentTime, bufRuido);
    else tocarNota(ctx, master, pista, +f, ctx.currentTime, .15, ondaPulso);
  }
}
document.addEventListener('pointerdown', ev => {
  const c = celdaDesde(ev); if (!c) return;
  iniciar(); ev.preventDefault();
  pintando = estado.grilla[c.dataset.p][c.dataset.f][c.dataset.i] ? 0 : 1;
  aplicar(c, pintando);
});
document.addEventListener('pointermove', ev => { if (pintando === null) return; const c = celdaDesde(ev); if (c) aplicar(c, pintando); });
document.addEventListener('pointerup', () => { if (pintando !== null) { pintando = null; guardarHash(); } });

function marcar(i) {
  document.querySelectorAll('.celda.paso').forEach(c => c.classList.remove('paso'));
  if (i >= 0) document.querySelectorAll(`.celda[data-i="${i}"]`).forEach(c => c.classList.add('paso'));
}

function dibujarOsc() {
  const cv = $('#osc'), g = cv.getContext('2d'), datos = new Uint8Array(analizador.fftSize);
  (function cuadro() {
    analizador.getByteTimeDomainData(datos);
    g.fillStyle = 'rgba(5,5,10,.5)'; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#3dff8a'; g.lineWidth = 2; g.shadowColor = '#3dff8a'; g.shadowBlur = 8; g.beginPath();
    for (let x = 0; x < cv.width; x++) {
      const v = datos[Math.floor(x / cv.width * datos.length)] / 128 - 1;
      const y = cv.height / 2 + v * cv.height * .45;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke(); requestAnimationFrame(cuadro);
  })();
}

// ---------- guardar y compartir ----------
function codificar() {
  let bits = '';
  PISTAS.forEach(p => estado.grilla[p.id].forEach(f => f.forEach(v => bits += v)));
  let bytes = '';
  for (let i = 0; i < bits.length; i += 8) bytes += String.fromCharCode(parseInt(bits.slice(i, i + 8).padEnd(8, '0'), 2));
  const esc = Object.keys(ESCALAS).indexOf(estado.escala);
  return `${estado.bpm}.${estado.swing}.${esc}.${estado.tono}.` + btoa(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function decodificar(s) {
  const [bpm, swing, esc, tono, b64] = s.split('.');
  if (!b64) return false;
  const bytes = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
  let bits = ''; for (const ch of bytes) bits += ch.charCodeAt(0).toString(2).padStart(8, '0');
  let k = 0;
  PISTAS.forEach(p => estado.grilla[p.id].forEach(f => { for (let i = 0; i < PASOS; i++) f[i] = +bits[k++] || 0; }));
  Object.assign(estado, { bpm: +bpm || 128, swing: +swing || 0, escala: Object.keys(ESCALAS)[+esc] || estado.escala, tono: +tono || 0 });
  return true;
}
function guardarHash() { history.replaceState(null, '', '#' + codificar()); }

function aviso(t) { const a = $('#aviso'); a.textContent = t; a.classList.add('ver'); setTimeout(() => a.classList.remove('ver'), 1800); }

// ---------- patrones ----------
function limpiar() { PISTAS.forEach(p => estado.grilla[p.id].forEach(f => f.fill(0))); }
function demo() {
  limpiar();
  const G = estado.grilla;
  [[0, 4], [2, 3], [4, 5], [6, 4], [8, 7], [10, 6], [11, 5], [12, 4], [14, 2]].forEach(([i, f]) => G.p1[f][i] = 1);
  for (let i = 0; i < 16; i++) G.p2[[0, 2, 4, 2][i % 4]][i] = 1;
  [[0, 0], [3, 0], [6, 0], [8, 3], [11, 3], [14, 2]].forEach(([i, f]) => G.tri[f][i] = 1);
  [0, 4, 8, 10, 12].forEach(i => G.ruido[0][i] = 1);
  [4, 12].forEach(i => G.ruido[1][i] = 1);
  for (let i = 0; i < 16; i += 2) G.ruido[2][i] = 1;
  G.ruido[3][14] = 1;
}
function azar() {
  limpiar();
  const G = estado.grilla;
  let f = 2;
  for (let i = 0; i < 16; i++) if (Math.random() < .55) { f = Math.max(0, Math.min(7, f + Math.round((Math.random() - .5) * 4))); G.p1[f][i] = 1; }
  const acorde = [0, 2, 4];
  for (let i = 0; i < 16; i++) if (Math.random() < .7) G.p2[acorde[i % 3] + (i >= 8 ? 1 : 0)][i] = 1;
  const raiz = [0, 3, 4, 2][Math.floor(Math.random() * 4)];
  for (let i = 0; i < 16; i += 2) if (Math.random() < .75) G.tri[i < 8 ? 0 : raiz][i] = 1;
  [0, 8].forEach(i => G.ruido[0][i] = 1); if (Math.random() < .6) G.ruido[0][10] = 1;
  [4, 12].forEach(i => G.ruido[1][i] = 1);
  for (let i = 0; i < 16; i++) if (Math.random() < .6) G.ruido[2][i] = 1;
}

// ---------- WAV ----------
async function exportarWav() {
  const vueltas = 4, seg = duracionPaso(), largo = vueltas * PASOS * seg + 1;
  const sr = 44100, off = new OfflineAudioContext(1, Math.ceil(largo * sr), sr);
  const a = prepararAudio(off);
  for (let v = 0; v < vueltas; v++) for (let i = 0; i < PASOS; i++) {
    const t = (v * PASOS + i) * seg + (i % 2 ? seg * estado.swing / 100 : 0) + .01;
    programarPaso(off, a.m, i, t, seg, a.pulso, a.ruido);
  }
  const buf = await off.startRendering(), d = buf.getChannelData(0);
  const dv = new DataView(new ArrayBuffer(44 + d.length * 2));
  const w = (o, s) => [...s].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); dv.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVEfmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, d.length * 2, true);
  for (let i = 0; i < d.length; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
  const url = URL.createObjectURL(new Blob([dv], { type: 'audio/wav' }));
  const l = document.createElement('a'); l.href = url; l.download = 'pixelsynth.wav'; l.click();
  aviso('WAV listo');
}

// ---------- arranque ----------
function controles() {
  const esc = $('#escala'); Object.keys(ESCALAS).forEach(k => esc.add(new Option(k, k)));
  const ton = $('#tono'); NOTAS.forEach((n, i) => ton.add(new Option(n, i)));
  const sync = () => {
    $('#bpm').value = estado.bpm; $('#bpmv').textContent = estado.bpm;
    $('#swing').value = estado.swing; $('#swingv').textContent = estado.swing + '%';
    esc.value = estado.escala; ton.value = estado.tono;
  };
  sync();
  $('#bpm').oninput = e => { estado.bpm = +e.target.value; sync(); guardarHash(); };
  $('#swing').oninput = e => { estado.swing = +e.target.value; sync(); guardarHash(); };
  esc.onchange = () => { estado.escala = esc.value; etiquetas(); guardarHash(); };
  ton.onchange = () => { estado.tono = +ton.value; etiquetas(); guardarHash(); };
  $('#play').onclick = play;
  $('#demo').onclick = () => { demo(); construir(); guardarHash(); };
  $('#azar').onclick = () => { azar(); construir(); guardarHash(); };
  $('#borrar').onclick = () => { limpiar(); construir(); guardarHash(); };
  $('#compartir').onclick = () => { guardarHash(); navigator.clipboard?.writeText(location.href).then(() => aviso('Enlace copiado'), () => aviso('Copia la URL')); };
  $('#wav').onclick = exportarWav;
  return sync;
}

const TECLAS = 'asdfghjk';
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'SELECT' || e.repeat) return;
  if (e.code === 'Space') { e.preventDefault(); play(); return; }
  const f = TECLAS.indexOf(e.key.toLowerCase());
  if (f >= 0) { iniciar(); ctx.resume(); tocarNota(ctx, master, PISTAS[0], f, ctx.currentTime, .25, ondaPulso); }
});

if (!(location.hash.length > 1 && decodificar(location.hash.slice(1)))) demo();
controles();
construir();
