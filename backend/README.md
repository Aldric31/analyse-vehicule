# Backend - Analyse Véhicule

Backend Node.js pour l'analyse factuelle de véhicules de collection via l'API Claude.

## Prérequis

1. Node.js 18+
2. Compte Anthropic avec clé API

## Installation locale

```bash
cd backend
npm install
```

## Configuration

Créer un fichier `.env` :

```
ANTHROPIC_API_KEY=sk-ant-votre-cle-api
```

## Lancer en local

```bash
npm start
```

Le serveur démarre sur http://localhost:3000

## Déploiement sur Railway (gratuit)

1. Créer un compte sur https://railway.app
2. Cliquer sur "New Project" > "Deploy from GitHub repo"
3. Connecter votre repository GitHub
4. Sélectionner le dossier `backend`
5. Ajouter la variable d'environnement `ANTHROPIC_API_KEY`
6. Railway génère une URL (ex: `https://votre-app.railway.app`)

## Après déploiement

Modifier `API_URL` dans `index.html` :

```javascript
const API_URL = 'https://votre-app.railway.app/api/analyze';
```

Puis mettre à jour GitHub Pages.
