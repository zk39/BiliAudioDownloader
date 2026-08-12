 
[简体中文](docs/README.zh-CN.md) | [English](docs/README.en-US.md) | [About How to get your cookies/如何获得你的cookie](docs/HowToGetUrAuthToken.md)
 

# BiliAudioDownloader

下载 Bilibili 音频

## 项目介绍

这个项目的核心功能就是把 B 站视频转成音频。

~~目的是为了让本人上下班路上可以有ai东雪莲的曲子听~~

## 技术和已有功能

可以下载单个视频/音频以及合集音频(1080p视频需要cookie)

用的 TypeScript，关于解析 HTML 的部分是源自于 BV1yyN1eMEgj 这个视频的灵感。

不确定 B 站的检测机制，所以下载并发数设置默认为 3，如果下载失败会将失败的数据存起来然后重新下载。

### 关于 FFmpeg 和路径

程序运行后会在当前路径下自动创建一个 `downloads` 文件夹，下载的音频会保存在里面。如果输入链接为 B 站合集，则所有音频会存在 downloads 文件夹下新建一个合集名的文件夹。

**如果你使用 FFmpeg：**
- 下载的 m4a 格式会自动转码成 mp3 格式
- Release 里已经自带了一个 FFmpeg，开箱即用
- 如果需要自己下载 FFmpeg，可以去这里：https://github.com/eugeneware/ffmpeg-static/releases

**如果你不用 FFmpeg：**
- 也能正常下载，电脑可以正常播放
- 但是文件默认是视频格式（虽然只有音轨）
- 可能有些播放器（比如爱国者和月光宝盒）会无法播放

建议还是用 FFmpeg，这样下载的 mp3 文件兼容性更好～

---

## 使用教程


### 0. 你得有nodejs环境 然后
```
 npm i bili-audio-downloader
```
 

Link example:
=======
再然后输入 bad 在命令行中

<img width="1238" height="944" alt="image" src="https://github.com/user-attachments/assets/f73b887c-fc1a-4d31-b797-88b1e21fc56a" />


### 1. 找到你的 cookie 并粘贴它

请查看"[如何获得你的cookie](docs/HowToGetUrAuthToken.md)"页面来获取你的 B 站 Cookie

<img width="600" alt="image" src="https://github.com/user-attachments/assets/ac526053-0ca8-4df3-8a85-ff5ba139e0b7" />

### 2. 复制链接并点击回车

**单个视频链接示例：**
>>>>>>> 386c152527f9bb78c2adb485246faf2810178bad

```
https://www.bilibili.com/video/BV1UBmUBqEDe/?spm_id_from=333.337.search-card.all.click
```
<<<<<<< HEAD

<img width="1736" height="1030" alt="image" src="https://github.com/user-attachments/assets/98912072-91c2-42c6-9136-f0b431e5d667" />

Or
Copy the collection link, paste it, and click Enter
Link example:
=======

<img width="600" alt="image" src="https://github.com/user-attachments/assets/98912072-91c2-42c6-9136-f0b431e5d667" />

**或者使用合集链接：**

复制合集链接，粘贴它，然后点击回车

合集链接示例：

```
https://space.bilibili.com/1437582453/lists/1235710?type=season
```
 

  <img width="1904" height="1482" alt="image" src="https://github.com/user-attachments/assets/6ffc1d17-4dbe-469f-9717-74491dd02fe9" />
=======
>>>>>>> 386c152527f9bb78c2adb485246faf2810178bad

<img width="600" alt="image" src="https://github.com/user-attachments/assets/6ffc1d17-4dbe-469f-9717-74491dd02fe9" />

<img width="600" alt="image" src="https://github.com/user-attachments/assets/127d6e8a-5783-43fa-b22a-4afbfb511f64" />
