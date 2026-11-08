import { firebaseConfig } from "./firebase-config.js";

const FIREBASE_VERSION = "10.12.2";
const ROOM_KEY = "challenger:room";
const NAMES_KEY = "challenger:names";
const MAX_PLAYERS = 12;
const $ = (s) => document.querySelector(s);
const newId = () => Math.random().toString(36).slice(2, 8);

// ---------- Modèle de jeu ----------
// Un jeu : { name, players: [{id, name}], points: {id: n}, sets: {id: n}, setsMode, setTarget }
// En mode manches, « points » = points de la manche en cours, « sets » = manches gagnées.

// Lit un jeu, y compris l'ancien format à 2 joueurs (p1, p2, s1, s2).
function normalize(raw, id) {
  const g = {
    id,
    name: raw.name || "Jeu",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    setsMode: !!raw.setsMode,
    setTarget: Number.isInteger(raw.setTarget) && raw.setTarget > 0 ? raw.setTarget : 3,
    order: typeof raw.order === "number" ? raw.order : null,
    players: [],
    points: {},
    sets: {},
  };
  if (Array.isArray(raw.players)) {
    g.players = raw.players.map((p) => ({ id: String(p.id), name: String(p.name) }));
    for (const p of g.players) {
      g.points[p.id] = raw.points?.[p.id] || 0;
      g.sets[p.id] = raw.sets?.[p.id] || 0;
    }
  } else {
    g.players = [{ id: "p1", name: raw.p1 || "Joueur 1" }, { id: "p2", name: raw.p2 || "Joueur 2" }];
    g.points = { p1: raw.s1 || 0, p2: raw.s2 || 0 };
    g.sets = { p1: 0, p2: 0 };
  }
  return g;
}

const serialize = (g) => ({
  name: g.name,
  players: g.players,
  points: g.points,
  sets: g.sets,
  setsMode: g.setsMode,
  setTarget: g.setTarget,
  order: g.order,
});

// Position dans la liste : plus petit = plus haut. Sans ordre choisi, le plus récent en haut.
const sortKey = (g) => (g.order ?? -g.createdAt);
const sortGames = (list) => list.sort((a, b) => sortKey(a) - sortKey(b));

const playerName = (g, pid) => g.players.find((p) => p.id === pid)?.name ?? "?";
const scoreLine = (g, map) => g.players.map((p) => map[p.id] || 0).join(" – ");

// Chaque action modifie le jeu et renvoie les lignes d'historique à enregistrer.
const actions = {
  point(g, pid, delta) {
    const before = g.points[pid] || 0;
    const after = Math.max(0, before + delta);
    if (after === before) return { events: [] };
    const beforePoints = { ...g.points };
    g.points[pid] = after;
    const name = playerName(g, pid);
    const events = [{ type: "point", playerId: pid, delta, text: `${delta > 0 ? "+1" : "−1"} ${name}` }];
    let wonSet = false;
    if (g.setsMode && delta > 0 && after >= g.setTarget) {
      wonSet = true;
      const score = scoreLine(g, g.points);
      g.sets[pid] = (g.sets[pid] || 0) + 1;
      for (const p of g.players) g.points[p.id] = 0;
      events.push({ type: "set", playerId: pid, delta: 1, text: `🏆 ${name} gagne la manche (${score})` });
    }
    return { events, wonSet, beforePoints };
  },

  // Annule un +1 (et la manche qu'il a fait gagner, le cas échéant).
  undoPoint(g, pid, prev) {
    const name = playerName(g, pid);
    if (prev.wonSet) {
      g.sets[pid] = Math.max(0, (g.sets[pid] || 0) - 1);
      for (const p of g.players) g.points[p.id] = prev.beforePoints[p.id] || 0;
      return { events: [{ type: "undo", playerId: pid, delta: -1, text: `↩︎ Annulé : manche de ${name}` }] };
    }
    g.points[pid] = Math.max(0, (g.points[pid] || 0) - 1);
    return { events: [{ type: "undo", playerId: pid, delta: -1, text: `↩︎ Annulé : +1 ${name}` }] };
  },

  reset(g) {
    for (const p of g.players) { g.points[p.id] = 0; g.sets[p.id] = 0; }
    return { events: [{ type: "reset", text: "Scores remis à zéro" }] };
  },

  // next : { name, setsMode, setTarget, players: [{id, name, points, sets, isNew}] }
  edit(g, next) {
    const events = [];
    const log = (text) => events.push({ type: "edit", text });

    if (next.name !== g.name) { log(`Jeu renommé : « ${g.name} » → « ${next.name} »`); g.name = next.name; }

    const keep = new Set(next.players.map((p) => p.id));
    for (const p of g.players) {
      if (!keep.has(p.id)) {
        log(`Joueur retiré : ${p.name}`);
        delete g.points[p.id];
        delete g.sets[p.id];
      }
    }

    const players = [];
    for (const np of next.players) {
      const old = g.players.find((p) => p.id === np.id);
      if (!old) {
        log(`Joueur ajouté : ${np.name}`);
      } else if (old.name !== np.name) {
        log(`${old.name} s'appelle maintenant ${np.name}`);
      }
      players.push({ id: np.id, name: np.name });
      const oldPts = g.points[np.id] || 0;
      const oldSets = g.sets[np.id] || 0;
      if (old && np.points !== oldPts) log(`Correction : ${np.name} ${oldPts} → ${np.points} point${np.points > 1 ? "s" : ""}`);
      if (old && next.setsMode && np.sets !== oldSets) log(`Correction : ${np.name} ${oldSets} → ${np.sets} manche${np.sets > 1 ? "s" : ""}`);
      g.points[np.id] = np.points;
      g.sets[np.id] = next.setsMode ? np.sets : oldSets;
    }
    g.players = players;

    if (next.setsMode !== g.setsMode) {
      log(next.setsMode ? `Mode manches activé (${next.setTarget} points par manche)` : "Mode manches désactivé");
    } else if (next.setsMode && next.setTarget !== g.setTarget) {
      log(`Manches en ${next.setTarget} points (avant : ${g.setTarget})`);
    }
    g.setsMode = next.setsMode;
    g.setTarget = next.setTarget;
    return { events };
  },
};

// Nettoie une ligne d'historique (Firestore refuse les champs undefined).
const cleanEvent = (e, n) => {
  const out = { type: e.type, text: e.text, n };
  if (e.playerId) out.playerId = e.playerId;
  if (e.delta) out.delta = e.delta;
  return out;
};

// ---------- Stockage ----------

// Mode local : tout reste dans le navigateur de cet appareil.
function localStore() {
  const KEY = "challenger:games";
  const evKey = (id) => `challenger:events:${id}`;
  const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const listeners = new Set();
  const historyListeners = new Map();
  const games = () => sortGames(load(KEY, []).map((r) => normalize(r, r.id)));
  const notify = () => listeners.forEach((cb) => cb(games()));
  const notifyHistory = (id) => historyListeners.get(id)?.forEach((cb) => cb(load(evKey(id), [])));
  const addEvents = (id, events) => {
    const now = Date.now();
    const list = [...events.map((e, i) => ({ ...cleanEvent(e, i), at: now })).reverse(), ...load(evKey(id), [])];
    save(evKey(id), list.slice(0, 500));
    notifyHistory(id);
  };
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) notify();
    else if (e.key?.startsWith("challenger:events:")) notifyHistory(e.key.slice(18));
  });

  return {
    subscribe(cb) { listeners.add(cb); cb(games()); },
    async create(g) {
      const id = crypto.randomUUID();
      const now = Date.now();
      save(KEY, [{ ...serialize(g), id, createdAt: now, updatedAt: now }, ...load(KEY, [])]);
      addEvents(id, [{ type: "create", text: `Jeu créé : ${g.players.map((p) => p.name).join(", ")}` }]);
      notify();
    },
    async apply(id, fn) {
      const raws = load(KEY, []);
      const i = raws.findIndex((r) => r.id === id);
      if (i < 0) throw new Error("Ce jeu n'existe plus.");
      const g = normalize(raws[i], id);
      const res = fn(g);
      if (!res.events.length && !res.save) return res;
      raws[i] = { ...serialize(g), id, createdAt: raws[i].createdAt, updatedAt: Date.now() };
      save(KEY, raws);
      if (res.events.length) addEvents(id, res.events);
      notify();
      return res;
    },
    async remove(id) {
      save(KEY, load(KEY, []).filter((r) => r.id !== id));
      try { localStorage.removeItem(evKey(id)); } catch {}
      notify();
    },
    history(id, cb) {
      if (!historyListeners.has(id)) historyListeners.set(id, new Set());
      historyListeners.get(id).add(cb);
      cb(load(evKey(id), []));
      return () => historyListeners.get(id).delete(cb);
    },
  };
}

// Mode Firebase : les scores sont partagés en temps réel entre appareils.
async function firebaseStore(room) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fs = await import(`${base}/firebase-firestore.js`);
  const db = fs.initializeFirestore(initializeApp(firebaseConfig), {
    localCache: fs.persistentLocalCache(),
  });
  const col = fs.collection(db, "rooms", room, "games");
  const events = (id) => fs.collection(db, "rooms", room, "games", id, "events");
  const ms = (v) => (v && v.toMillis ? v.toMillis() : typeof v === "number" ? v : Date.now());

  return {
    subscribe(cb) {
      fs.onSnapshot(
        fs.query(col, fs.orderBy("createdAt", "desc")),
        (snap) => cb(sortGames(snap.docs.map((d) => {
          const g = normalize(d.data({ serverTimestamps: "estimate" }), d.id);
          return { ...g, createdAt: ms(g.createdAt), updatedAt: ms(g.updatedAt) };
        }))),
        (err) => showError(err),
      );
    },
    async create(g) {
      const ref = fs.doc(col);
      const batch = fs.writeBatch(db);
      batch.set(ref, { ...serialize(g), createdAt: fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
      batch.set(fs.doc(events(ref.id)), {
        ...cleanEvent({ type: "create", text: `Jeu créé : ${g.players.map((p) => p.name).join(", ")}` }, 0),
        at: fs.serverTimestamp(),
      });
      await batch.commit();
    },
    // Transaction : lit le jeu, applique l'action et écrit l'historique d'un seul coup,
    // pour ne rien perdre si vous marquez un point en même temps.
    apply(id, fn) {
      const ref = fs.doc(col, id);
      return fs.runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("Ce jeu n'existe plus.");
        const raw = snap.data();
        const g = normalize(raw, id);
        const res = fn(g);
        if (!res.events.length && !res.save) return res;
        tx.set(ref, { ...serialize(g), createdAt: raw.createdAt ?? fs.serverTimestamp(), updatedAt: fs.serverTimestamp() });
        res.events.forEach((e, n) => tx.set(fs.doc(events(id)), { ...cleanEvent(e, n), at: fs.serverTimestamp() }));
        return res;
      });
    },
    async remove(id) {
      const snap = await fs.getDocs(events(id));
      const batch = fs.writeBatch(db);
      snap.docs.slice(0, 450).forEach((d) => batch.delete(d.ref));
      batch.delete(fs.doc(col, id));
      await batch.commit();
    },
    history(id, cb) {
      return fs.onSnapshot(
        fs.query(events(id), fs.orderBy("at", "desc"), fs.limit(300)),
        (snap) => cb(snap.docs.map((d) => {
          const e = d.data({ serverTimestamps: "estimate" });
          return { ...e, at: ms(e.at) };
        })),
        (err) => showError(err),
      );
    },
  };
}

// ---------- Messages ----------

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
    : err?.code === "unavailable" || err?.code === "failed-precondition"
      ? "Pas de connexion : réessaie quand tu auras du réseau."
      : err?.message || "Impossible de joindre Firebase.";
  toast(`⚠️ ${hint}`);
}

let toastTimer;
let undoFn = null;
function toast(text, onUndo = null) {
  $("#toast-text").textContent = text;
  $("#toast-undo").hidden = !onUndo;
  undoFn = onUndo;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; undoFn = null; }, onUndo ? 5000 : 4000);
}
$("#toast-undo").addEventListener("click", () => {
  const fn = undoFn;
  undoFn = null;
  $("#toast").hidden = true;
  fn?.();
});

const run = (p) => Promise.resolve(p).catch(showError);

// ---------- Affichage ----------

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
  $("#games").replaceChildren(...games.map((g, i) => renderGame(g, i)));
  $("#empty").hidden = games.length > 0;
}

function renderGame(g, index) {
  const main = g.setsMode ? g.sets : g.points;
  const values = g.players.map((p) => main[p.id] || 0);
  const best = Math.max(...values);
  const leaders = values.filter((v) => v === best).length;
  const prev = prevScores.get(g.id) || {};
  const now = {};

  const player = (p, idx) => {
    const big = main[p.id] || 0;
    const pts = g.points[p.id] || 0;
    const key = `${big}/${pts}`;
    now[p.id] = key;
    const bigEl = el("div", { class: "score" }, String(big));
    if (prev[p.id] && prev[p.id] !== key) bigEl.classList.add("bump");
    return el("div", { class: `player c${idx % 6}${leaders === 1 && big === best && best > 0 ? " leader" : ""}` },
      el("div", { class: "name" }, p.name),
      bigEl,
      g.setsMode ? el("div", { class: "sub" }, `${pts} / ${g.setTarget} pts`) : "",
      el("div", { class: "btns" },
        el("button", { class: "minus", "aria-label": `Retirer un point à ${p.name}`, disabled: pts <= 0,
          onclick: () => run(store.apply(g.id, (x) => actions.point(x, p.id, -1))) }, "−"),
        el("button", { class: "plus", "aria-label": `Un point pour ${p.name}`,
          onclick: () => point(g, p) }, "+1"),
      ),
    );
  };

  const players = g.players.map(player);
  prevScores.set(g.id, now);
  const cols = g.players.length === 3 ? "n3" : "";

  return el("article", { class: "game" },
    el("div", { class: "game-head" },
      el("div", {},
        el("h2", {}, g.name),
        g.setsMode ? el("div", { class: "mode" }, `Manches en ${g.setTarget} point${g.setTarget > 1 ? "s" : ""}`) : "",
      ),
      el("div", { class: "head-btns" },
        index > 0 ? el("button", { class: "icon", "aria-label": "Monter ce jeu", title: "Monter", onclick: () => moveUp(index) }, "⬆️") : "",
        el("button", { class: "icon", "aria-label": "Historique", title: "Historique", onclick: () => openHistory(g) }, "🕘"),
        el("button", { class: "icon", "aria-label": "Réglages", title: "Réglages", onclick: () => openGameDialog(g) }, "⚙️"),
      ),
    ),
    el("div", { class: `players ${cols}` }, ...players),
    el("div", { class: "game-foot" }, `Dernière modif ${timeAgo(g.updatedAt)}`),
  );
}

// Échange la place du jeu avec celui du dessus.
function moveUp(index) {
  const a = games[index];
  const b = games[index - 1];
  if (!a || !b) return;
  let ka = sortKey(a);
  let kb = sortKey(b);
  if (ka === kb) ka += 1;
  const setOrder = (g, order) => store.apply(g.id, (x) => { x.order = order; return { events: [], save: true }; });
  run(Promise.all([setOrder(a, kb), setOrder(b, ka)]));
}

async function point(g, p) {
  try {
    const res = await store.apply(g.id, (x) => actions.point(x, p.id, 1));
    const text = res.wonSet ? `🏆 Manche pour ${p.name} !` : `+1 pour ${p.name}`;
    toast(text, () => run(store.apply(g.id, (x) => actions.undoPoint(x, p.id, res))));
  } catch (err) {
    showError(err);
  }
}

// ---------- Fenêtre création / réglages ----------

const dialog = $("#game-dialog");
const form = $("#game-form");
const rows = $("#player-rows");
let editing = null; // jeu en cours de réglage, ou null pour une création

function playerRow(p = {}) {
  const isNew = !p.id;
  const row = el("div", { class: "player-row", "data-id": p.id || newId(), "data-new": isNew ? "1" : null },
    el("input", { class: "p-name", required: true, maxlength: 20, value: p.name || "", placeholder: "Prénom", "aria-label": "Prénom" }),
    el("input", { class: "p-points col-score", type: "number", min: 0, max: 9999, inputmode: "numeric", value: p.points ?? 0, "aria-label": "Points" }),
    el("input", { class: "p-sets col-score col-sets", type: "number", min: 0, max: 9999, inputmode: "numeric", value: p.sets ?? 0, "aria-label": "Manches" }),
    el("button", { type: "button", class: "remove", "aria-label": "Retirer ce joueur", onclick: () => { row.remove(); syncRows(); } }, "×"),
  );
  return row;
}

function syncRows() {
  const n = rows.children.length;
  rows.querySelectorAll(".remove").forEach((b) => (b.disabled = n <= 2));
  $("#add-player").hidden = n >= MAX_PLAYERS;
}

function syncSetsMode() {
  dialog.classList.toggle("sets-on", form.setsMode.checked);
}

function openGameDialog(g = null) {
  editing = g;
  form.reset();
  dialog.classList.toggle("editing", !!g);
  $("#game-dialog-title").textContent = g ? "Réglages" : "Nouveau jeu";
  $("#game-submit").textContent = g ? "Enregistrer" : "Créer";
  rows.replaceChildren();
  if (g) {
    form.name.value = g.name;
    form.setsMode.checked = g.setsMode;
    form.setTarget.value = g.setTarget;
    g.players.forEach((p) => rows.append(playerRow({ ...p, points: g.points[p.id], sets: g.sets[p.id] })));
  } else {
    let names = [];
    try { names = JSON.parse(localStorage.getItem(NAMES_KEY)) || []; } catch {}
    if (names.length < 2) names = [names[0] || "", names[1] || ""];
    names.forEach((name) => rows.append(playerRow({ name })));
  }
  syncRows();
  syncSetsMode();
  dialog.showModal();
  if (!g) form.name.focus();
}

$("#add-btn").addEventListener("click", () => openGameDialog());
$("#add-player").addEventListener("click", () => {
  const row = playerRow();
  rows.append(row);
  syncRows();
  row.querySelector(".p-name").focus();
});
form.setsMode.addEventListener("change", syncSetsMode);
dialog.querySelector("[data-close]").addEventListener("click", () => dialog.close());

const int = (v, min, max) => Math.min(max, Math.max(min, parseInt(v, 10) || 0));

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const players = [...rows.children].map((r) => ({
    id: r.dataset.id,
    isNew: r.dataset.new === "1",
    name: r.querySelector(".p-name").value.trim(),
    points: int(r.querySelector(".p-points").value, 0, 9999),
    sets: int(r.querySelector(".p-sets").value, 0, 9999),
  }));
  const next = {
    name: form.name.value.trim(),
    setsMode: form.setsMode.checked,
    setTarget: int(form.setTarget.value, 1, 99),
    players,
  };
  if (!next.name || players.length < 2 || players.some((p) => !p.name)) return;

  if (editing) {
    const id = editing.id;
    run(store.apply(id, (g) => actions.edit(g, next)));
  } else {
    try { localStorage.setItem(NAMES_KEY, JSON.stringify(players.map((p) => p.name))); } catch {}
    run(store.create({
      order: games.length ? Math.min(...games.map(sortKey)) - 1 : null,
      name: next.name,
      setsMode: next.setsMode,
      setTarget: next.setTarget,
      players: players.map((p) => ({ id: p.id, name: p.name })),
      points: Object.fromEntries(players.map((p) => [p.id, 0])),
      sets: Object.fromEntries(players.map((p) => [p.id, 0])),
    }));
  }
  dialog.close();
});

$("#reset-game").addEventListener("click", () => {
  if (!editing || !confirm(`Remettre tous les scores de « ${editing.name} » à zéro ?`)) return;
  run(store.apply(editing.id, actions.reset));
  dialog.close();
});
$("#delete-game").addEventListener("click", () => {
  if (!editing || !confirm(`Supprimer « ${editing.name} » et son historique ? C'est définitif.`)) return;
  run(store.remove(editing.id));
  dialog.close();
});

// ---------- Historique ----------

const historyDialog = $("#history-dialog");
let stopHistory = null;

function dayLabel(ms) {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Aujourd'hui";
  if (same(d, yesterday)) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long",
    year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

function renderHistory(list) {
  const box = $("#history-list");
  if (!list.length) {
    box.replaceChildren(el("p", { class: "empty" }, "Rien pour l'instant."));
    return;
  }
  const sorted = [...list].sort((a, b) => b.at - a.at || (b.n || 0) - (a.n || 0));
  const out = [];
  let day = null;
  for (const e of sorted) {
    const label = dayLabel(e.at);
    if (label !== day) { day = label; out.push(el("div", { class: "day" }, label)); }
    const kind = e.type === "point" ? (e.delta > 0 ? "plus" : "minus") : e.type;
    out.push(el("div", { class: `event ${kind}` },
      el("time", {}, new Date(e.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })),
      el("span", {}, e.text),
    ));
  }
  box.replaceChildren(...out);
}

function openHistory(g) {
  $("#history-title").textContent = g.name;
  $("#history-list").replaceChildren();
  stopHistory?.();
  stopHistory = store.history(g.id, renderHistory);
  historyDialog.showModal();
}
historyDialog.querySelector("[data-close]").addEventListener("click", () => historyDialog.close());
historyDialog.addEventListener("close", () => { stopHistory?.(); stopHistory = null; });

// Ferme une fenêtre en touchant le fond
for (const d of [dialog, historyDialog]) {
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
}

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
  const local = !firebaseConfig.apiKey || new URLSearchParams(location.search).has("local");
  if (local) {
    store = localStore();
    showBanner("📱 Mode local : les scores restent sur cet appareil.");
  } else {
    const room = getRoom() || (await askRoom());
    try {
      store = await firebaseStore(room);
    } catch (err) {
      showBanner("⚠️ Impossible de charger Firebase. Vérifie ta connexion.", true);
      console.error(err);
      return;
    }
    const share = $("#share-btn");
    share.hidden = false;
    share.addEventListener("click", async () => {
      const url = `${location.origin}${location.pathname}#code=${encodeURIComponent(room)}`;
      try {
        if (navigator.share) await navigator.share({ title: "Challenger", url });
        else { await navigator.clipboard.writeText(url); toast("Lien copié ! Envoie-le aux autres joueurs."); }
      } catch {}
    });
  }
  store.subscribe((list) => { games = list; render(); });
}

start();
