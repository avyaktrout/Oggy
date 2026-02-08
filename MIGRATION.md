# Oggy Migration Guide

How to migrate a locally-trained Oggy onto the hosted instance at `oggy-v1.com`.

## Prerequisites

- Your local Oggy instance is running at `localhost:3001`
- The admin has added your email to the hosted instance allowlist
- You have `curl` available (or PowerShell on Windows)

## Step 1: Export your local Oggy

On your **local** machine, export your trained Oggy data. The default local user_id is `oggy`:

```bash
curl -s "http://localhost:3001/v0/migration/export?user_id=oggy" -o oggy-bundle.json
```

This creates a JSON bundle containing:
- All domain knowledge (learned patterns, category rules, distinction rules)
- Learning state (current scale and difficulty level)
- Expenses
- Memory cards
- Inquiry preferences

Check the export stats to make sure it looks right:
```bash
# Linux/Mac
python3 -c "import sys,json; d=json.load(open('oggy-bundle.json')); print(json.dumps(d['stats'], indent=2))"

# Windows PowerShell
Get-Content oggy-bundle.json | python -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['stats'], indent=2))"
```

You should see counts for domain_knowledge, expenses, and memory_cards.

## Step 2: Get access to the hosted instance

Ask the admin to add your email to the allowlist. The admin does this from the hosted site's admin panel, or via API:

```bash
# Admin runs this (logged in with their session):
curl -X POST https://oggy-v1.com/v0/auth/add-user \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: <admin-csrf-token>" \
  -b "oggy_session=<admin-session>" \
  -d '{"email": "you@example.com", "display_name": "Your Name"}'
```

## Step 3: Log in and get your session

1. **Request a magic link:**
```bash
curl -X POST https://oggy-v1.com/v0/auth/request-magic-link \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com"}'
```

2. **Click the link** in your email to activate your session. Your browser will have the `oggy_session` cookie set automatically.

3. **Get your CSRF token** (needed for the import POST):

Open your browser's developer tools (F12) on the Oggy site, go to the Console tab, and run:
```javascript
fetch('/v0/auth/me').then(r => r.json()).then(d => console.log('CSRF token:', d.csrf_token))
```

Or via curl (you'll need your session cookie value from the browser):
```bash
curl -s -b "oggy_session=<your-session>" https://oggy-v1.com/v0/auth/me
```

## Step 4: Import your Oggy bundle

Upload your exported bundle to the hosted instance. The import endpoint automatically assigns all data to your authenticated user:

```bash
# Linux/Mac:
curl -X POST https://oggy-v1.com/v0/migration/import \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: <your-csrf-token>" \
  -b "oggy_session=<your-session>" \
  -d "{\"bundle\": $(cat oggy-bundle.json)}"
```

```powershell
# Windows PowerShell:
$bundle = Get-Content oggy-bundle.json -Raw
$body = '{"bundle": ' + $bundle + '}'
Invoke-RestMethod -Uri "https://oggy-v1.com/v0/migration/import" `
  -Method POST `
  -ContentType "application/json" `
  -Headers @{ "x-csrf-token"="<your-csrf-token>" } `
  -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) `
  -WebSession $session
```

**Note:** The bundle can be large (10MB+). The import may take a few seconds.

The response tells you what was imported:
```json
{
  "success": true,
  "imported": {
    "domain_knowledge": 10557,
    "expenses": 5,
    "memory_cards": 1102,
    "learning_state": true,
    "errors": []
  },
  "message": "Imported 10557 knowledge entries, 5 expenses, 1102 memory cards. Level: S2 L5"
}
```

## Step 5: Verify

Visit `https://oggy-v1.com` in your browser. You should see your Oggy's level displayed on the chat page. Try categorizing an expense to confirm your Oggy has its learned knowledge.

You can also check the export endpoint to verify your data on the hosted instance:
```bash
curl -s -b "oggy_session=<your-session>" https://oggy-v1.com/v0/migration/export | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d['stats'], indent=2))"
```

When logged in, the `user_id` is automatically set from your session — you don't need to specify it.

## What gets migrated

| Data | Migrated | Notes |
|------|----------|-------|
| Domain knowledge | Yes | All learned patterns, rules, training data |
| Category distinction rules | Yes | Part of domain knowledge |
| Learning state (S/L level) | Yes | Your Oggy keeps its level |
| Expenses | Yes | All active expenses |
| Memory cards | Yes | All active memory cards |
| Inquiry preferences | Yes | Suggestion settings |
| Benchmark results | No | Instance-specific test records |
| Auth sessions | No | You get a new session on the hosted instance |

## Notes

- **Import is additive**: it won't delete existing data, only add new entries. Duplicate domain knowledge entries (same content_hash) are skipped.
- **User isolation**: after import, your data is scoped to your user_id. Other tenants cannot see it.
- **Observer**: once imported, opt in to Observer (`PUT /v0/observer/config` with `share_learning: true`) to participate in federated learning with other tenants.
- **Re-migration**: you can export and import again at any time. Duplicates are handled gracefully.
- **Bundle size**: a well-trained Oggy can produce a 10-20MB export file. This is normal.
