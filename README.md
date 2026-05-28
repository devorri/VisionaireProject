# Visionaire

Browser app for turning a video into a WebODM/OpenDroneMap reconstruction job.

The app extracts JPEG frames from a video in the browser, uploads those frames to WebODM as a task, polls task progress, and links finished assets such as `textured_model.zip`, `georeferenced_model.ply`, and `all.zip`.

## Run

```bash
npm install
npm run dev
```

Open the Vite URL, usually `http://localhost:5173`.

## WebODM

Run WebODM separately, then point the app at it.

```bash
git clone https://github.com/OpenDroneMap/WebODM
cd WebODM
./webodm.sh start
```

By default, the Vite dev server proxies `/webodm` to `http://localhost:8000`.

To use another WebODM URL:

```bash
VITE_WEBODM_URL=http://localhost:8000 npm run dev
```

On Windows PowerShell:

```powershell
$env:VITE_WEBODM_URL="http://localhost:8000"; npm run dev
```

## Notes

WebODM accepts image sets, so video is converted into still frames before upload. More frames and higher JPEG quality usually help reconstruction, but they increase upload size and processing time.

For a public deployment, put a small server between this UI and WebODM so usernames, passwords, JWTs, and CORS are handled server-side.
