# 🏆 Challenger

Compteur de scores pour nos petits défis à deux (« T'as une tache, pistache », etc.).

- Créer un jeu entre 2 personnes
- +1 / −1 à tout moment, avec un bouton « Annuler » si on s'est trompé
- Les scores sont synchronisés en temps réel entre nos deux téléphones (Firebase)

Site statique (HTML/CSS/JS, sans build), hébergé sur GitHub Pages.

## 1. Créer la base Firebase (gratuit, ~5 min)

1. Va sur <https://console.firebase.google.com> → **Créer un projet** (nom : `challenger`, Google Analytics inutile).
2. Menu **Build → Firestore Database** → **Créer une base de données** → choisis une région en Europe (ex. `eur3`) → mode **production**.
3. Onglet **Règles** : remplace tout par le contenu de [`firestore.rules`](firestore.rules) → **Publier**.
4. Roue ⚙️ **Paramètres du projet** → section « Vos applications » → icône **`</>`** (Web) → nom `challenger` → **Enregistrer**.
5. Copie l'objet `firebaseConfig` affiché dans [`firebase-config.js`](firebase-config.js).

> Ces valeurs ne sont pas secrètes. Ce qui protège vos scores, c'est le **code secret** choisi dans l'app : sans lui, impossible de lire ou modifier vos jeux.

## 2. Mettre en ligne (GitHub Pages)

Dans le dépôt GitHub : **Settings → Pages → Source : Deploy from a branch → `main` / `(root)`**.
Le site est en ligne au bout d'une minute environ sur `https://<ton-pseudo>.github.io/challenger/`.

## 3. Sur les téléphones

1. Ouvre le site → choisis (ou génère) un **code secret**.
2. Appuie sur 🔗 pour envoyer le lien à l'autre personne : il contient le code, elle tombe directement sur vos jeux.
3. Safari → Partager → **Sur l'écran d'accueil** pour l'utiliser comme une vraie app.

Sans config Firebase, l'app fonctionne en **mode local** : les scores restent sur un seul appareil.

## Tester en local

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>.
