import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";
const $ = (s) => document.querySelector(s);
const ROOM_KEY = "challenger:room";
const NAMES_KEY = "challenger:names";

// ---------- Stockage ----------

// Mode local : tout reste dans le navigateur de cet appareil.
function localStore() {
  const KEY = "challenger:games";
  const read = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const listeners = new Set();
  const write = (games) => {
    try { localStorage.setItem(KEY, JSON.stringify(games)); } catch {}
    listeners.forEach((cb) => cb(games));
  };
  const edit = (id, fn) => write(read().map((g) => (g.id === id ? fn({ ...g }) : g)));
  window.addEventListener("storage", (e) => e.key === KEY && listeners.forEach((cb) => cb(read())));

  return {
    subscribe(cb) { listeners.add(cb); cb(read()); },
    add(g) {
      const now = Date.now();
      write([{ ...g, id: crypto.randomUUID(), s1: 0, s2: 0, createdAt: now, updatedAt: now }, ...read()]);
    },
    bump(id, i, delta) {
      edit(id, (g) => {
        g[`s${i}`] = Math.max(0, (g[`s${i}`] || 0) + delta);
        g.updatedAt = Date.now();
        return g;
      });
    },
    reset(id) { edit(id, (g) => ({ ...g, s1: 0, s2: 0, updatedAt: Date.now() })); },
    remove(id) { write(read().filter((g) => g.id !== id)); },
  };
}

// Mode Firebase : les scores sont partagés en temps réel entre appareils.
async function firebaseStore(room) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fs = await import(`${base}/firebase-firestore.js`);
  const db = fs.initializeFirestore(initializeApp(firebaseConfig), {
    localCache: fs.persistentLocalCache(), // fonctionne aussi hors-ligne
  });
  const col = fs.collection(db, "rooms", room, "games");
  const ref = (id) => fs.doc(col, id);
  const ts = (v) => (v && v.toMillis ? v.toMillis() : v || Date.now());

  return {
    subscribe(cb) {
      fs.onSnapshot(
        fs.query(col, fs.orderBy("createdAt", "desc")),
        (snap) => cb(snap.docs.map((d) => {
          const g = d.data({ serverTimestamps: "estimate" });
          return { ...g, id: d.id, createdAt: ts(g.createdAt), updatedAt: ts(g.updatedAt) };
        })),
        (err) => showError(err),
      );
    },
    add(g) {
      return fs.addDoc(col, { ...g, s1: 0, s2: 0, createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
    },
    bump(id, i, delta) {
      // increment() évite de perdre un point si vous cliquez en même temps.
      return fs.updateDoc(ref(id), { [`s${i}`]: fs.increment(delta), updatedAt: fs.serverTimestamp() });
    },
    reset(id) { return fs.updateDoc(ref(id), { s1: 0, s2: 0, updatedAt: fs.serverTimestamp() }); },
    remove(id) { return fs.deleteDoc(ref(id)); },
  };
}

// ---------- Interface ----------

let store;
let games = [];
const prevScores = new Map();

function showBanner(html, error = false) {
  const b = $("#mode-banner");
  b.innerHTML = html;
  b.classList.toggle("error", error);
  b.hidden = false;
}

function showError(err) {
  console.error(err);
  const hint = err?.code === "permission-denied"
    ? "Accès refusé : vérifie les règles Firestore (voir README)."
    : "Impossible de joindre Firebase. Vérifie la config dans firebase-config.js.";
  showBanner(`⚠️ ${hint}`, true);
}

function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  const m = Math.round(s / 60);
  if (m < 60) return `il y a ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `il y a ${h} h`;
  const d = Math.round(h / 24);
  return d === 1 ? "hier" : `il y a ${d} jours`;
}

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, "");
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  n.append(...children);
  return n;
}

function render() {
  const main = $("#games");
  main.replaceChildren(...games.map(renderGame));
  $("#empty").hidden = games.length > 0;
}

function renderGame(g) {
  const lead = g.s1 === g.s2 ? 0 : g.s1 > g.s2 ? 1 : 2;
  const prev = prevScores.get(g.id);
  prevScores.set(g.id, [g.s1, g.s2]);

  const player = (i) => {
    const score = g[`s${i}`] || 0;
    const scoreEl = el("div", { class: "score" }, String(score));
    if (prev && prev[i - 1] !== score) scoreEl.classList.add("bump");
    return el("div", { class: `player${lead === i ? " leader" : ""}`, "data-i": i },
      el("div", { class: "name" }, g[`p${i}`]),
      scoreEl,
      el("div", { class: "btns" },
        el("button", { class: "minus", "aria-label": `Retirer un point à ${g[`p${i}`]}`, disabled: score <= 0,
          onclick: () => store.bump(g.id, i, -1) }, "−"),
        el("button", { class: "plus", "aria-label": `Un point pour ${g[`p${i}`]}`,
          onclick: () => point(g, i) }, "+1"),
      ),
    );
  };

  return el("article", { class: "game" },
    el("div", { class: "game-head" },
      el("h2", {}, g.name),
      el("button", { class: "menu", "aria-label": "Options", onclick: () => gameMenu(g) }, "⋯"),
    ),
    el("div", { class: "players" }, player(1), player(2)),
    el("div", { class: "game-foot" }, `Dernière modif ${timeAgo(g.updatedAt)}`),
  );
}

let toastTimer;
let undo = null;
function point(g, i) {
  store.bump(g.id, i, 1);
  undo = () => store.bump(g.id, i, -1);
  $("#toast-text").textContent = `+1 pour ${g[`p${i}`]} 🥜`;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; undo = null; }, 4000);
}
$("#toast-undo").addEventListener("click", () => {
  undo?.();
  undo = null;
  $("#toast").hidden = true;
});

const menu = $("#menu-dialog");
let menuGame = null;
function gameMenu(g) {
  menuGame = g;
  $("#menu-title").textContent = g.name;
  menu.showModal();
}
$("#menu-reset").addEventListener("click", () => {
  if (menuGame && confirm(`Remettre « ${menuGame.name} » à 0 – 0 ?`)) store.reset(menuGame.id);
  menu.close();
});
$("#menu-delete").addEventListener("click", () => {
  if (menuGame && confirm(`Supprimer « ${menuGame.name} » ? C'est définitif.`)) store.remove(menuGame.id);
  menu.close();
});
menu.querySelector("[data-close]").addEventListener("click", () => menu.close());

// Dialogue « Nouveau jeu »
const dialog = $("#game-dialog");
const form = $("#game-form");
$("#add-btn").addEventListener("click", () => {
  form.reset();
  try {
    const [p1, p2] = JSON.parse(localStorage.getItem(NAMES_KEY)) || [];
    form.p1.value = p1 || "";
    form.p2.value = p2 || "";
  } catch {}
  dialog.showModal();
  form.name.focus();
});
dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());
form.addEventListener("submit", (e) => {
  e.preventDefault();
  const g = { name: form.name.value.trim(), p1: form.p1.value.trim(), p2: form.p2.value.trim() };
  if (!g.name || !g.p1 || !g.p2) return;
  try { localStorage.setItem(NAMES_KEY, JSON.stringify([g.p1, g.p2])); } catch {}
  store.add(g);
  dialog.close();
});

// Rafraîchit les « il y a X min »
setInterval(() => games.length && render(), 60_000);

// ---------- Démarrage ----------

function getRoom() {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("code");
  if (fromHash) {
    try { localStorage.setItem(ROOM_KEY, fromHash); } catch {}
    history.replaceState(null, "", location.pathname);
    return fromHash;
  }
  try { return localStorage.getItem(ROOM_KEY); } catch { return null; }
}

function askRoom() {
  return new Promise((resolve) => {
    $("#room-screen").hidden = false;
    $("#add-btn").hidden = true;
    $("#room-random").addEventListener("click", () => {
      const a = new Uint8Array(9);
      crypto.getRandomValues(a);
      $("#room-input").value = btoa(String.fromCharCode(...a)).replace(/[+/=]/g, "x");
    });
    $("#room-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const code = $("#room-input").value.trim();
      if (code.length < 8) return;
      try { localStorage.setItem(ROOM_KEY, code); } catch {}
      $("#room-screen").hidden = true;
      $("#add-btn").hidden = false;
      resolve(code);
    });
  });
}

async function start() {
  if (!firebaseConfig.apiKey) {
    store = localStore();
    showBanner("📱 Mode local : les scores restent sur cet appareil. Configure Firebase pour les partager (voir README).");
  } else {
    const room = getRoom() || (await askRoom());
    try {
      store = await firebaseStore(room);
    } catch (err) {
      showError(err);
      return;
    }
    const share = $("#share-btn");
    share.hidden = false;
    share.addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#code=${encodeURIComponent(room)}`;
      try {
        if (navigator.share) await navigator.share({ title: "Challenger", url });
        else { await navigator.clipboard.writeText(url); alert("Lien copié ! Envoie-le à ta moitié."); }
      } catch {}
    });
  }
  store.subscribe((list) => { games = list; render(); });
}

start();
