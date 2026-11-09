# fombot-desk

Private iPhone web app for Ilian’s PAPER trading desk.

- **Live URL (after Pages enable):** https://ilianrebt-coder.github.io/fombot-desk/
- **Data:** Supabase project `zklfaarybftuzmahhsxj` via supabase-js + RLS (`owner_allowlist`)
- **Auth:** email magic link (`signInWithOtp`), redirect back to the Pages URL
- **FOMO links:** exact `coin?address=&chainId=1399811149&r=savipww&source=share_link` builders in `links.js`

## Deploy

Push to `main`. The workflow uploads this folder to GitHub Pages.

In the GitHub repo: Settings → Pages → Source = GitHub Actions.

## Local

```bash
cd site-repo
python3 -m http.server 8765 --bind 127.0.0.1
```

Open http://127.0.0.1:8765/

## Notes

- Publishable key only in the client. Never commit service/secret keys.
- Settings are read-only in the Account tab; pause/resume/mode insert into `commands`. Other knobs stay on Telegram.
- Add to Home Screen: Safari → Share → Add to Home Screen.
