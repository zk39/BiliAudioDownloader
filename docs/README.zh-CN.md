[简体中文](README.zh-CN.md) | [English](README.en-US.md) | [如何获得你的 cookie](HowToGetUrAuthToken.md)

# BiliAudioDownloader

把 B 站视频下载成**音频(mp3)**或**高清视频(mp4)**的命令行工具。支持单个视频、合集、以及**整个 UP 主的全部投稿**。

~~核心目的是为了让本人上下班路上能听 ai 东雪莲的曲子~~

---

## 安装

```bash
npm i -g bili-audio-downloader
```

装好后在终端输入 `bad` 启动:

```bash
bad
```

> `ffmpeg` 已通过 `ffmpeg-static` 自动内置,无需另装。

---

## 快速上手

启动后会先问你**下载类型**,再让你粘贴链接:

```
下载类型?  [1] 仅音频(默认)   [2] 视频(自动合并为 mp4) :
Enter the video/collection URL (or q/quit to exit):
```

- 输 `1`(或直接回车)= **仅音频**,转成 mp3。
- 输 `2` = **视频**,下载后自动用 ffmpeg 合并成 mp4。

然后粘贴链接回车即可。输 `q` 退出。

---

## 支持的链接

**单个视频:**
```
https://www.bilibili.com/video/BV1UBmUBqEDe
```

**合集:**
```
https://space.bilibili.com/1437582453/lists/1235710?type=season
```

**UP 主主页(下载该 UP 主全部投稿):**
```
https://space.bilibili.com/313580179/upload/video
```
合集和主页会先显示菜单:`[1] 预览列表`  `[2] 全部下载`。

---

## 要不要 cookie?

| 下载类型 | 是否需要 cookie |
|---|---|
| **单个视频 / 单曲 → 音频** | **不需要**,直接下 |
| **视频(想要 1080P 高清)** | **需要**(登录态);不给则最高只有 480P |
| **合集 / UP 主主页(列表)** | **需要**(列表接口有风控) |

- 选「视频」且当前没 cookie 时,程序才会提示你粘贴 cookie(可回车跳过,只下 480P)。
- 怎么拿 cookie 见 [如何获得你的 cookie](HowToGetUrAuthToken.md)。**必须包含 `SESSDATA`**(它是 HttpOnly,要从浏览器 F12 → Network → 请求头 Cookie 整行复制,不能用 `document.cookie`)。

### 画质档位(B 站规则,对所有工具都一样)

- 未登录(游客):最高 **480P**
- 登录:最高 **1080P**
- 大会员:**1080P60 / 4K / HDR**

程序会自动选账号能拿到的**最高画质**。

### cookie 会过期

- `bili_ticket`(3 天):**程序自动续**,不用管。
- `SESSDATA`:名义半年,但 B 站会**不定期轮换**(可能几天)。一旦失效,视频会掉回 480P,或合集/主页报「风控(-352)」。这时重新粘一份新 cookie 即可。

---

## 输出位置

程序在**当前目录**下创建 `downloads` 文件夹:

- 音频 → `downloads/`(合集/主页会建以 合集名 / UP主名 命名的子文件夹)
- 视频 → `downloads/video/`(同样按 合集名 / UP主名 分子文件夹)

**断点续传:** 同一个合集/UP主重复下载时,已存在的文件会自动**跳过**,只补没下的或上次失败的。

---

## 常见问题

**下的视频很糊/只有 480P?**
没登录或 cookie 失效。选视频模式时粘贴含 `SESSDATA` 的完整 cookie。程序会打印 `画质诊断` 行,`isLogin=false` 就是 cookie 失效了。

**长视频下载慢/卡住?**
已用**多段并发下载**(6 段并行 + 每段重试),进度条会显示 `已下/总量 + 速度`。B 站按单连接限速,并发能叠加带宽。

**番剧 / 剧集(`bangumi/play/epXXXX`)下不了?**
这类是 PGC 内容,结构不同,暂不支持。

**下载失败会怎样?**
合集/主页下载失败的条目会存到 `failed_downloads.json`,可选择重试。
