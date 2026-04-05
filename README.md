### Run the apps

Build all packages and apps first, then start the web app and API server in separate terminals.

1. **Build** (from the repo root):

```bash
npm run build
```

2. **Start the web app** (terminal 1):

```bash
npm run start:web
```

3. **Start the API server** (terminal 2):

```bash
npm run start:server
```

- Web app: [http://localhost:3000](http://localhost:3000)
- API server: [http://localhost:3001](http://localhost:3001)

### Live deployment

- **Frontend (Netlify):** [https://lambent-griffin-2247b1.netlify.app/recorder](https://lambent-griffin-2247b1.netlify.app/recorder)
- **Backend API (Railway):** [https://server-production-bab9.up.railway.app/](https://server-production-bab9.up.railway.app/)

For the deployed web app, `NEXT_PUBLIC_SERVER_URL` should match the Railway API base URL above (no trailing slash is fine for the env value).

### AssemblyAI API key

Merged recordings are transcribed and speaker-labeled on the **API server** via [AssemblyAI](https://www.assemblyai.com/). You need an API key in the server environment:

- Set **`ASSEMBLYAI_API_KEY`** in `apps/server/.env` or the **repository root** `.env` (the server loads both). Restart the API after you change it.

If this variable is missing, audio files are still saved, but the `.txt` transcript stays a placeholder instead of real text, and speaker diarization does not run.
