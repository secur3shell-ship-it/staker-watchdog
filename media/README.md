# Staker Watchdog videos

- `staker-watchdog-product-walkthrough.mp4` (~19 s) — to-the-point tour in six scenes: overview, validator directory with both commissions, validator profile and collector accounts, change history, watchlist and alert preferences, and the phone layout. Plain crossfades.
- `staker-watchdog-launch.mp4` (~18 s) — launch cut: intro card, full-bleed product shots with caption panels, a live-figures card, phone layout, and closing card, with slow push-in/pull-out motion and varied transitions.

Both are silent 1280×720 H.264 MP4s built only from still frames joined by transitions. Every product frame is a real screenshot of the running dashboard on finalized mainnet data, so addresses, stakes, and the figures on the launch stats card (validators tracked, custom collector accounts, delinquent count) are those of the capture date stamped on that card.

## Regenerating

Requires Google Chrome and `ffmpeg` with `libx264`, `xfade`, and `zoompan`. From the project root:

```sh
node media/generate-videos.mjs
```

The script starts the app on port 3456 against the configured database, waits for a fresh sync, captures desktop (1280 px) and phone (390 px) screenshots through Chrome's DevTools protocol, composes the captioned frames, encodes both MP4s into `media/`, and deletes its temporary files. To film an already-running instance instead, set `BASE_URL`, for example `BASE_URL=http://127.0.0.1:3000 node media/generate-videos.mjs`. Re-run it whenever the UI changes so the videos stay accurate.
