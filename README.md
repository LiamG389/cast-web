# Cast Web

Cast Web is a local web remote for Google Cast receivers. Run the helper on a Mac or Raspberry Pi, then open it from a phone or computer on the same network. The helper discovers receivers and scans video pages for playable links. Use the built-in Big Buck Bunny sample to check a receiver before scanning a site.

## Run on macOS

Install Node.js 24 and FFmpeg, then run these commands from the project folder.

```sh
npm ci
PLAYWRIGHT_BROWSERS_PATH="$PWD/.browser-cache" npx playwright install --only-shell chromium
npm start
```

Open [localhost:3000](http://localhost:3000) on the Mac, or use the LAN address printed by the helper on your phone. If macOS asks whether Terminal or Node can access the local network, allow it so the helper can discover receivers.

To choose a persistent storage folder, create it before starting the helper.

```sh
mkdir -p "$PWD/remux"
CAST_MEDIA_DIR="$PWD/remux" npm start
```

## Run with Docker on Linux or Raspberry Pi

Use a 64-bit Linux installation with Docker Engine and the Compose plugin. The image includes FFmpeg and headless Chromium. Compose uses host networking for receiver discovery. The service runs as UID 1000 and needs write access to the media directory.

```sh
mkdir -p remux
docker compose up -d --build
docker compose logs --tail=100 cast-web
```

Open the helper's LAN address on port **3080**. To use an external drive, create the destination on the mounted drive and put this setting in a local `.env` file before starting Compose.

```dotenv
CAST_REMUX_DIR=/path/to/mounted/drive/cast-web/remux
```

The destination must already exist. Mount the drive before starting the container. Keep the helper on a trusted LAN since browsers that can reach it can also control playback.

## Cast videos

1. Pick a receiver at the top of the page.
2. Paste a video page or a direct `.m3u8` link and choose **Find videos**.
3. Choose a result and press **Cast**.

Under **Settings → HLS playback**, choose **MP4 remux** or **Direct HLS** for each receiver name. MP4 remux is the default for HLS. It copies the video, encodes stereo AAC audio when present, and can start playback while the helper prepares the rest of the file. Direct HLS sends the original playlist to the receiver. You can also use **… → Cast HLS directly** on an HLS result for a one-off test.

Completed MP4s appear in **Remuxes** and expire after three days of inactivity. **Open MP4** plays the helper's copy in a browser during a cast. The helper stores resume positions in `resume.csv` and receiver settings in `device-settings.json`, both in the media directory.

>[!IMPORTANT]
> **IT IS SUGGESTED YOU USE DIRECT HLS!!!**: Remuxing requires additional (though not a lot) resources and storage on the server side. Only use remuxing if your Chromecast *does not* support the video HLS format. Aka. Only use it if you try direct HLS and it doesn't work. 

## Troubleshooting

- Start with Big Buck Bunny. If a cast fails, use **Copy diagnostics** and check the helper logs for the receiver address and the stage that timed out.
- Compare the address in the logs with the address shown by the TV if its IP changes.
- If direct HLS fails on a receiver, try MP4 remux for that device.
- If Chromium is missing, repeat the installation command with the same `PLAYWRIGHT_BROWSERS_PATH`.

## Run tests

```sh
npm ci
npm test
```

The automated tests use simulated receivers. Use the Big Buck Bunny sample to check discovery and playback on real hardware.


