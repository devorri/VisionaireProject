Backend options — WebODM vs OpenDroneMap (ODM)

Overview

- WebODM: web UI + API wrapper around OpenDroneMap. Easy to use from this app because it exposes a REST API (default at http://localhost:8000 when run locally). WebODM itself is open-source and can be run locally via the project scripts or Docker.
- OpenDroneMap (ODM): the processing engine. Usually used via WebODM or directly via command-line/Docker. If you prefer no UI and direct processing, use ODM.

Option A — Run WebODM (recommended if you want a web UI)

1. Clone the WebODM repo and start using the provided script (recommended):

```bash
# clone WebODM and start the stack (Linux/macOS/WSL)
git clone https://github.com/OpenDroneMap/WebODM.git
cd WebODM
./webodm.sh start
```

This will start the WebODM server and services on ports including `8000` by default. After it's up, set the app to use it by running the dev server with the environment variable:

```bash
# start Vite dev server with WebODM URL
set VITE_WEBODM_URL=http://localhost:8000
npm run dev
```

2. Quick connectivity check (once WebODM is running):

```bash
curl http://localhost:8000/api/version/
# or open http://localhost:8000 in a browser
```

Option B — Run ODM (no Web UI)

1. Run ODM in Docker for direct processing. Example (process local images directory):

```bash
# run ODM container (replace /path/to/images with your images folder)
docker run --rm -it -v /path/to/images:/datasets/code opendronemap/odm --project-path /datasets --images /datasets/code
```

2. Integrating with this app: ODM does not provide the same Web API as WebODM. To use the app you can:
- Run WebODM (wraps ODM) — easiest; or
- Create a small local wrapper service that accepts image uploads and calls ODM CLI/Docker, then returns results. I can scaffold such a wrapper if you want.

Notes and next steps

- If you want me to configure the app to target an existing WebODM instance, I can update `vite.config.ts` defaults and add a `.env` example.
- If you want a wrapper to call ODM directly, I can scaffold a minimal Express server that accepts image uploads and invokes ODM Docker.

Choose:
- "WebODM" — I'll add `.env.example` and a short `docker-compose` or startup hint and update the app's API checks.
- "ODM-wrapper" — I'll scaffold a minimal Express wrapper that the app can POST images to, which will call ODM Docker.
- "Both" — I'll add both options (shorter scaffolds).

Server (Express) quick start

1. Install server dependencies and `ffmpeg` on your machine (Ubuntu example):

```bash
sudo apt update && sudo apt install -y ffmpeg
npm install express multer fs-extra axios form-data cors
```

2. Run the gateway server from the project root:

```bash
node server.js
# or with npm script
npm run server
```

The gateway listens on port `5000` by default and forwards frames to the local NodeODM engine at `http://localhost:3000`.

Frontend notes

- The React app now includes a "Send to Local NodeODM" button which uploads the raw video to `http://localhost:5000/api/process-video` and polls `http://localhost:3000` for processing status.
- Configure custom endpoints with the environment variables `VITE_GATEWAY_URL` and `VITE_NODEODM_URL`.
