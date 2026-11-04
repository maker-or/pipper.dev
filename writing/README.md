# writing.pipper.dev

A static site for long-form writing. `index.html` is "What is what"; its
videos are in `media/`, its fonts come from Google Fonts.

## Deploy

This folder is its own Vercel project, with `writing.pipper.dev` added as its
domain (Cloudflare already points the subdomain at Vercel):

```sh
cd writing
vercel link        # once: create or pick the "pipper-writing" project
vercel --prod
vercel domains add writing.pipper.dev   # once
```

## OG image and icons

- `og.png` (1800×945) is the "Writing :)" card, used as supplied.
- The icons are ":)" in Cedarville Cursive, `#00FF5F` on `#088139`, rendered
  from `og-source/favicon.html` at 512px (`icon.png`), then scaled with ffmpeg:

  ```sh
  ffmpeg -i icon.png -vf scale=180:180:flags=lanczos apple-touch-icon.png
  ffmpeg -i icon.png -vf scale=32:32:flags=lanczos favicon.ico
  ```
