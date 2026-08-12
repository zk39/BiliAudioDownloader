[简体中文](README.zh-CN.md) | [English](README.en-US.md) | [How to get your cookies](HowToGetUrAuthToken.md)

# BiliAudioDownloader

A CLI tool to download Bilibili videos as **audio (mp3)** or **HD video (mp4)**. Works on a single video, a collection (season), or an **uploader's entire video list**.

---

## Install

```bash
npm i -g bili-audio-downloader
```

Then run `bad` in your terminal:

```bash
bad
```

> `ffmpeg` is bundled via `ffmpeg-static` — no separate install needed.

---

## Quick start

On launch it first asks for the **download type**, then for the link:

```
下载类型?  [1] 仅音频(默认)   [2] 视频(自动合并为 mp4) :
Enter the video/collection URL (or q/quit to exit):
```

- `1` (or just Enter) = **audio only**, converted to mp3.
- `2` = **video**, auto-merged into mp4 with ffmpeg after download.

Then paste a link and press Enter. Type `q` to quit.

---

## Supported links

**Single video:**
```
https://www.bilibili.com/video/BV1UBmUBqEDe
```

**Collection (season):**
```
https://space.bilibili.com/1437582453/lists/1235710?type=season
```

**Uploader's page (download ALL of their videos):**
```
https://space.bilibili.com/313580179/upload/video
```
Collections and uploader pages show a menu first: `[1] Preview list`  `[2] Download all`.

---

## Do I need a cookie?

| Download type | Cookie needed? |
|---|---|
| **Single video/song → audio** | **No** — works right away |
| **Video (for 1080P HD)** | **Yes** (login); without it you get 480P max |
| **Collection / uploader list** | **Yes** (the list API is risk-controlled) |

- The tool only asks for a cookie when you pick **video** and none is loaded (you can press Enter to skip → 480P only).
- See [How to get your cookies](HowToGetUrAuthToken.md). It **must contain `SESSDATA`** (HttpOnly — copy the whole `Cookie` header from F12 → Network → request headers; `document.cookie` won't include it).

### Quality tiers (Bilibili's rules — same for every tool)

- Not logged in (guest): up to **480P**
- Logged in: up to **1080P**
- Premium (大会员): **1080P60 / 4K / HDR**

The tool automatically picks the **highest quality your account can access**.

### Cookies expire

- `bili_ticket` (3 days): **auto-refreshed** by the tool.
- `SESSDATA`: nominally ~6 months, but Bilibili **rotates it periodically** (can be days). When it dies, video drops to 480P or lists fail with "风控 (-352)". Just paste a fresh cookie.

---

## Output location

A `downloads` folder is created in your **current directory**:

- Audio → `downloads/` (collections/uploaders get a subfolder named after the collection / uploader)
- Video → `downloads/video/` (same subfolder scheme)

**Resume:** re-downloading the same collection/uploader **skips files that already exist**, fetching only what's missing or previously failed.

---

## FAQ

**Video looks blurry / only 480P?**
Not logged in or cookie expired. Paste a full cookie containing `SESSDATA` in video mode. The tool prints a `画质诊断` line; `isLogin=false` means the cookie is stale.

**Long video slow / stuck?**
Downloads use **parallel segmented download** (6 segments + per-segment retry); the progress bar shows `downloaded/total + speed`. Bilibili throttles per connection, so parallel connections add up bandwidth.

**Bangumi / episodes (`bangumi/play/epXXXX`) won't download?**
Those are PGC content with a different structure — not supported yet.

**What happens on failure?**
Failed items in a collection/uploader download are saved to `failed_downloads.json`, with an option to retry.
