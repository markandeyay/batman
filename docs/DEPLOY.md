# Deploying Batman to Fly.io (spec Section 17, Option B)

Batman must run on an always-on host for real use and judging: if the host sleeps, check-ins stop. The server is one Node process with outbound connections only, so no ports, domains, or public URLs are needed.

## One-time setup
1. Create a Fly.io account (browser) and install the CLI: `winget install Fly-io.flyctl`.
2. `fly auth login`
3. `fly apps create batman-safety` (or change `app` in fly.toml to a free name).
4. `fly volumes create batman_data --size 1 --region iad --yes`
5. Load secrets from your local .env without printing them: `fly secrets import < .env`
   (this sends the values to Fly's encrypted secret store; they are never baked into the image).

## Deploy
`fly deploy --ha=false`

`--ha=false` keeps exactly ONE machine (spec 8.1). Two running copies, including your laptop, would double-reply to every text.

## Operate
- Logs: `fly logs`
- Status: `fly status`
- Restart: `fly machine restart`
- Stop the laptop copy before deploying: never run `pnpm dev` locally against the same Photon project while the Fly machine is up.
- Database: SQLite at the DATABASE_PATH from .env (a relative path like ./data/batman.sqlite resolves under /app/data) on the `batman_data` volume. It survives restarts and deploys.
