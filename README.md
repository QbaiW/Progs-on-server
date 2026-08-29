# Progs-on-server

## Runtime data transfer

Runtime JSON data is intentionally kept outside Git in `server-data\from-server`.
Double-click `SYNC-SERVER-DATA.cmd` to choose a direction, or use:

- `PULL-SERVER-DATA.cmd`: copy the server data to the local `server-data\from-server` folder.
- `PUSH-SERVER-DATA.cmd`: copy that local folder to the server.

To update website code on the server, use the repository deploy script instead of
the data transfer commands:

```bash
cd /www/wwwroot/qe-star-bottle
bash shared-board/deploy-server.sh
```

The four core files (`notes.json`, `favorites.json`, `activity.json`, and `owner-devices.json`) are always transferred. Feature data is transferred when present: `love-stars-messages.json`, `wrong-counter.json`, `portal-settings.json`, and `portal-activity.json`. `settings.json` and `.env` are never transferred by this tool because they contain server-specific credentials and configuration.

Pulling backs up the previous local folder under `server-data\backups`. Pushing creates a timestamped backup under `/var/backups/qe-star-bottle` on the server before replacing data, then restarts PM2 and checks `/api/health`.
