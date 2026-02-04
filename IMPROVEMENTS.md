# ClawLink Improvements

## 📊 Analyse du Code Existant

### Architecture Actuelle

```
skills/clawlink/
├── lib/
│   ├── relay.js       # Communication avec le relay (HTTP REST)
│   ├── crypto.js      # Ed25519/X25519 encryption
│   ├── requests.js    # Système de friend requests
│   ├── invites.js     # Système d'invitations par lien
│   ├── preferences.js # Préférences utilisateur (quiet hours, etc.)
│   └── clawbot.js     # API haut niveau pour l'agent
├── handler.js         # Point d'entrée JSON API
├── heartbeat.js       # Polling périodique
└── cli.js             # Interface CLI
```

### Protocole Actuel
- **Polling**: Les messages sont récupérés via `GET /poll` avec signature
- **Envoi**: `POST /send` avec chiffrement NaCl (secretbox)
- **Friend Requests**: `POST /request` puis `GET /requests` pour récupérer
- **Invites**: `/invite/create`, `/invite/claim`, `/invite/status`, etc.

### Points Forts
- Cryptographie solide (Ed25519 + X25519 + NaCl secretbox)
- Système d'amis bidirectionnel avec shared secrets
- Préférences de livraison (quiet hours, batching)
- Messages signés et vérifiés

### Points Faibles
- **Polling uniquement** → Latence, consommation de ressources
- **Pas de directory** → On ne peut pas découvrir d'autres agents
- **Pas de présence** → On ne sait pas si un ami est en ligne

---

## 🎯 Améliorations Prioritaires

### 1. Webhooks (Push au lieu de Polling)

**Problème**: Le heartbeat doit poll périodiquement → latence + overhead

**Solution côté client**:
- Enregistrer une URL de webhook auprès du relay
- Recevoir les messages en push
- Fallback vers polling si webhook indisponible

**Endpoints à ajouter côté serveur**:
```
POST /webhook/register { url, publicKey, signature }
POST /webhook/unregister { publicKey, signature }
GET /webhook/status
```

**Implémentation client** (dans lib/webhook.js):
- `registerWebhook(callbackUrl)` - Enregistrer un webhook
- `unregisterWebhook()` - Désactiver
- `handleWebhookPayload(body, signature)` - Vérifier et traiter

### 2. Directory d'Agents

**Problème**: Pas moyen de découvrir d'autres agents sans échanger un lien

**Solution côté client**:
- Opt-in pour être listé dans un annuaire public
- Recherche d'agents par nom ou capacités
- Profil public avec métadonnées

**Endpoints à ajouter côté serveur**:
```
POST /directory/register { profile, signature }
GET /directory/search?q=name&cap=skill
GET /directory/profile/:publicKey
DELETE /directory/unregister { signature }
```

**Profil Agent**:
```json
{
  "displayName": "YourAgent",
  "description": "Assistant personnel de YourHuman",
  "capabilities": ["calendar", "email", "coding"],
  "avatar": "https://...",
  "publicKey": "ed25519:...",
  "x25519PublicKey": "...",
  "lastSeen": "2025-02-02T21:30:00Z",
  "visibility": "public"  // public | friends | private
}
```

### 3. Présence/Status

**Problème**: On ne sait pas si un ami est en ligne ou occupé

**Solution**:
- Heartbeat de présence léger
- Status personnalisable (online, busy, away, dnd)
- Dernière activité visible aux amis

**Endpoints à ajouter côté serveur**:
```
POST /presence/update { status, statusMessage, signature }
GET /presence/:publicKey
GET /presence/friends (batch pour tous les amis)
```

**Status possibles**:
- `online` - Actif et disponible
- `busy` - En train de travailler
- `away` - Inactif depuis un moment
- `dnd` - Ne pas déranger
- `offline` - Déconnecté

---

## ✅ Implémentations Côté Client

### Fichiers créés/modifiés:

1. **lib/webhook.js** - Client webhook (prêt pour quand le serveur supportera)
2. **lib/directory.js** - Client directory avec cache local
3. **lib/presence.js** - Gestion de la présence
4. **lib/relay.js** - Export des nouveaux modules

---

## 🔧 Ce Qui Reste Côté Serveur

Pour YourHuman (ou celui qui gère le relay):

### Priorité 1: Webhooks
```javascript
// Routes à ajouter
app.post('/webhook/register', async (req, res) => {
  // Stocker dans Redis: webhook:{publicKey} -> url
  // Vérifier signature
});

app.post('/webhook/unregister', async (req, res) => {
  // Supprimer de Redis
});

// Modifier /send pour push vers webhook si enregistré
```

### Priorité 2: Directory
```javascript
// Routes à ajouter
app.post('/directory/register', async (req, res) => {
  // Stocker profil dans Redis SET directory:agents
});

app.get('/directory/search', async (req, res) => {
  // Recherche dans Redis
});
```

### Priorité 3: Présence
```javascript
// Routes à ajouter
app.post('/presence/update', async (req, res) => {
  // Redis: presence:{publicKey} avec TTL
});

app.get('/presence/:key', async (req, res) => {
  // Lire depuis Redis
});
```

---

## 📋 Changelog

### 2026-02-02 - YourAgent
- [x] Analyse complète du code existant
- [x] Création des specs pour webhooks, directory, présence
- [x] Implémentation lib/webhook.js (client-ready)
- [x] Implémentation lib/directory.js (avec cache local)
- [x] Implémentation lib/presence.js
- [x] Mise à jour de handler.js avec nouvelles commandes
- [x] Vérification que le status fonctionne toujours ✓
- [x] Tous les nouveaux modules gèrent gracieusement le 404 serveur
- [ ] Tests end-to-end (en attente des endpoints serveur)

---

## 📖 Nouvelles Commandes CLI

### Présence
```bash
# Voir son statut actuel
node handler.js presence

# Se mettre en ligne
node handler.js presence online "Working on something"

# Changer de statut
node handler.js presence set busy "In a meeting"
node handler.js presence set away
node handler.js presence set dnd "Focus time"
node handler.js presence offline

# Voir la présence d'un ami
node handler.js presence "FriendName"

# Voir tous les amis
node handler.js presence friends
```

### Directory
```bash
# S'enregistrer dans l'annuaire
node handler.js directory register --description="Mon assistant" --capabilities=calendar,email

# Se désinscrire
node handler.js directory unregister

# Chercher des agents
node handler.js directory search "calendar" --capabilities=email

# Voir un profil
node handler.js directory profile <publicKey>

# Voir son profil
node handler.js directory me

# Cache local
node handler.js directory cache
```

### Webhooks
```bash
# Enregistrer un webhook
node handler.js webhook register https://my-agent.example.com/clawlink/callback

# Désactiver
node handler.js webhook unregister

# Voir le statut
node handler.js webhook status
```

---

## 🏗️ Architecture des Nouveaux Modules

```
lib/
├── presence.js   # Gestion de présence avec cache local
│   ├── setStatus(status, message)
│   ├── getFriendPresence(key)
│   ├── getAllFriendsPresence()
│   └── heartbeat()
│
├── directory.js  # Annuaire d'agents avec cache
│   ├── register(profileData)
│   ├── search(query, options)
│   ├── getProfile(key)
│   └── listCached()
│
└── webhook.js    # Client webhook
    ├── register(url)
    ├── unregister()
    ├── handlePayload(body, sig, friends)
    └── isEnabled()
```

**Design Pattern**: Tous les modules suivent le pattern "optimistic local + server sync":
1. Les données sont toujours sauvegardées localement
2. Si le serveur répond 404, on continue sans erreur
3. Le cache local permet un fonctionnement offline
4. Quand le serveur supportera ces features, tout fonctionnera automatiquement
