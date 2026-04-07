# Railway Workflow

This backend now has a local Railway CLI installed as a dev dependency, so we can use the `npm run ...` commands in `package.json` instead of relying on a global install.

## First-time setup

From `C:\Users\steph\Documents\Playground 2\5starflow\backend`:

```powershell
npm run railway:login
npm run railway:whoami
npm run railway:link
```

What this does:

- `railway:login` starts Railway CLI auth. `--browserless` is used because it works better inside terminal-first workflows.
- `railway:link` links this backend directory to the correct Railway project, environment, and service.

Once linked, Railway stores local link metadata so later commands know which service to target.

## Logs

After linking:

```powershell
npm run railway:status
npm run railway:service:status
npm run railway:logs
npm run railway:logs:latest
npm run railway:http-logs
```

What each one is for:

- `railway:status`: current linked project/environment status
- `railway:service:status`: deployment status for linked services
- `railway:logs`: live streaming app logs
- `railway:logs:latest`: last 200 lines from the latest deployment
- `railway:http-logs`: last 200 HTTP logs from the latest deployment

Useful direct examples:

```powershell
npx railway logs --since 1h
npx railway logs --lines 100 --filter "@level:error"
npx railway logs --http --status ">=400" --lines 100
```

## Deploys

When we want to push code to Railway from this backend directory:

```powershell
npm run railway:deploy
```

CI-style build/deploy output:

```powershell
npm run railway:deploy:ci
```

## Git Push Workflow

The git remote is already configured:

```powershell
git remote -v
```

Recommended flow for my updates:

```powershell
git checkout -b codex/<short-task-name>
git status
git add .
git commit -m "<message>"
git push -u origin HEAD
```

Notes:

- Git username/email are already configured locally on this machine.
- Pushing still depends on GitHub auth being available on the machine. If `git push` prompts for auth, we will need to complete that once and then future pushes should be straightforward.
