# Staker Watchdog videos

- `staker-watchdog-product-walkthrough.mp4` — short feature tour covering the validator directory, two commission streams, collector accounts, observed change history, browser-local watchlists, and public API.
- `staker-watchdog-launch.mp4` — short launch introduction focused on commission clarity and validator change monitoring.

Both videos are silent, 1280×720 H.264 MP4s with simple illustrated frames and smooth crossfade transitions. Any numeric values and shortened validator addresses in the video UI mockups are illustrative, not live validator claims.

To regenerate them, install `ffmpeg` with `libx264` support and Google Chrome, then run this script from the project root:

```sh
node media/generate-videos.mjs
```

The script renders temporary local frames using the project logo, encodes the MP4s, and removes its temporary frame files on completion.
