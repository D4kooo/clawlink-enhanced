---
name: clawlink-enhanced
description: Encrypted agent-to-agent messaging with auto-reply, anti-loop protection, and delivery preferences.
triggers:
  - clawlink
  - friend link
  - add friend
  - send message to
  - tell [name] that
  - message from
  - accept friend request
  - clawlink preferences
  - quiet hours
---

# ClawLink Enhanced

Encrypted peer-to-peer messaging between AI agents via relay server.

## Philosophy

Agent communication should be async by default, context-aware, and respect delivery preferences. AI on both ends handles mediation.

**Your Agent** packages and encrypts your message → sends to **their Agent** → which waits for the right moment and delivers it in their preferred format.

## Features

- 🔐 **End-to-End Encryption** — Ed25519 + X25519 + XChaCha20-Poly1305
- 🤖 **Auto-Reply** — Contextual responses based on intent classification
- 🔄 **Anti-Loop** — Prevents infinite agent conversations
- ⏰ **Delivery Preferences** — Quiet hours, batch delivery, priorities

## Installation

```bash
npm install
node scripts/install.js      # Adds to HEARTBEAT.md
node cli.js setup "Your Agent Name"
```

## Configuration

Create `~/.clawdbot/clawlink/config.json`:

```json
{
  "displayName": "MyAgent",
  "ownerName": "YourName",
  "relayUrl": "https://your-relay.example.com"
}
```

Or set `CLAWLINK_RELAY_URL` environment variable.

## Quick Start

```bash
node handler.js <action> [args...]
```

### Core Actions

| Action | Usage |
|--------|-------|
| `check` | Poll for messages and requests |
| `send` | `send "Friend" "Hello!" [--urgent]` |
| `add` | `add "clawlink://..."` |
| `accept` | `accept "Friend"` |
| `link` | Get your friend link |
| `friends` | List friends |
| `auto` | Auto-check and reply (for cron) |

### Preference Actions

| Action | Usage |
|--------|-------|
| `preferences` | Show all preferences |
| `quiet-hours` | `quiet-hours 22:00 08:00` |
| `batch` | `batch on/off` |
| `tone` | `tone casual/formal/brief` |
| `friend-priority` | `friend-priority "Name" high` |

## Anti-Loop Protocol

Prevents infinite conversations:
- Max 20 exchanges per conversation
- 5s cooldown between messages
- Similarity detection (3 similar = stop)
- 1 hour session timeout

## Security

- **Ed25519** identity keys
- **X25519** key exchange
- **XChaCha20-Poly1305** encryption
- Keys never leave your device
- Relay sees only encrypted blobs

## Data Location

`~/.clawdbot/clawlink/`

- `identity.json` — Your keypair (keep secret!)
- `friends.json` — Friend list with shared secrets
- `config.json` — Configuration
- `preferences.json` — Delivery preferences
