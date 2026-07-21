#!/usr/bin/env node
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import * as crypto from 'crypto';
import pLimit from 'p-limit';
import cliProgress from 'cli-progress';

// chalk 需要特殊处理以兼容 pkg
let chalk: any;
try {
	chalk = require('chalk');
} catch (error) {
	// 如果导入失败，使用简单的替代品
	chalk = {
		green: (text: string) => text,
		red: (text: string) => text,
		yellow: (text: string) => text,
		blue: (text: string) => text,
		cyan: (text: string) => text,
		gray: (text: string) => text,
		white: (text: string) => text,
		magenta: (text: string) => text,
		bold: { cyan: (text: string) => text }
	};
}

// 动态导入 ffmpeg-static
let ffmpegPath: string = 'ffmpeg';
try {
	ffmpegPath = require('ffmpeg-static') as string;
} catch (error) {
	// 如果没有安装 ffmpeg-static，使用系统的 ffmpeg
	ffmpegPath = 'ffmpeg';
}

interface VideoInfo {
	title: string;
	author: string;
	description: string;
	uploadDate: string;
	bvid: string;
}

interface AudioStream {
	baseUrl?: string;
	base_url?: string;
	backupUrl?: string[];
	backup_url?: string[];
	bandwidth: number;
}

interface VideoData {
	audioArr: AudioStream[];
	videoArr: any[];
	dolby: any[];
	videoInfo: VideoInfo;
	cid?: string; // 用于调 playurl 拿高清 dash
}

interface SeasonArchive {
	aid: number;
	bvid: string;
	ctime: number;
	duration: number;
	title: string;
	pic: string;
	pubdate: number;
	stat: {
		view: number;
		vt: number;
		danmaku: number;
	};
	state: number;
	ugc_pay: number;
	vt_display: string;
	is_lesson_video: number;
}

interface FailedDownload {
	bvid: string;
	title: string;
	url: string;
	error?: string;
}


interface SeasonMeta {
	category: number;
	cover: string;
	description: string;
	mid: number;
	name: string;
	ptime: number;
	season_id: number;
	total: number;
	title: string;
}

interface SeasonResponse {
	code: number;
	message: string;
	ttl: number;
	data: {
		aids: number[];
		archives: SeasonArchive[];
		meta: SeasonMeta;
		page: {
			page_num: number;
			page_size: number;
			total: number;
		};
	};
}

interface Config {
	downloadDir: string;
	cookieFile: string;
	headers: {
		[key: string]: string;
	};
	audioFormat: 'flac' | 'mp3' | 'wav' | 'm4a'; // 目标音频格式
	audioBitrate: string; // 音频比特率 (仅用于有损格式如mp3)
	ffmpegPath: string; // FFmpeg 可执行文件路径
	concurrency: number; // 并发下载数量
}

const log = console.log;
log('Downloader module loaded');

// ==================== 路径处理 (pkg 兼容) ====================
// 检测是否在 pkg 打包环境中运行
const isPkg = typeof (process as any).pkg !== 'undefined';
// 如果是打包环境，使用可执行文件所在目录；否则使用 cwd
const cwd = process.cwd()
const baseDir = isPkg ? path.dirname(process.execPath) : cwd;

// ==================== Config (只保留配置相关的全局变量) ====================
const config: Config = {
	downloadDir: path.join(baseDir, "downloads"),
	cookieFile: path.join(baseDir, 'cookies.txt'),
	audioFormat: 'mp3', // 默认转换为 FLAC 音乐格式
	audioBitrate: '320k', // MP3 比特率
	ffmpegPath: ffmpegPath || 'ffmpeg', // 使用打包的 ffmpeg，如果没有则使用系统的
	concurrency: 3, // 同时下载 3 首歌
	headers: {
		'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
		'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
		'cache-control': 'no-cache',
		'pragma': 'no-cache',
		'priority': 'u=0, i',
		'referer': 'https://www.bilibili.com',
		'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
		'sec-ch-ua-mobile': '?0',
		'sec-ch-ua-platform': '"Windows"',
		'sec-fetch-dest': 'document',
		'sec-fetch-mode': 'navigate',
		'sec-fetch-site': 'same-origin',
		'sec-fetch-user': '?1',
		'upgrade-insecure-requests': '1',
		'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
		'cookie': ''
	}
};

// 确保下载目录存在
if (!fs.existsSync(config.downloadDir)) {
	fs.mkdirSync(config.downloadDir);
}

// ==================== Cookie 管理 ====================
function loadCookies(): boolean {
	try {
		if (fs.existsSync(config.cookieFile)) {
			const cookie = fs.readFileSync(config.cookieFile, 'utf-8').trim();
			if (cookie) {
				log(chalk.green('Cookies loaded from file.'));
				config.headers.cookie = cookie;
				return true;
			}
		}
	} catch (error: any) {
		log(chalk.red('No cookies file found, proceeding without cookies.'));
	}
	return false;
}

function validateCookie(cookie: string): boolean {
	if (!cookie || cookie.length < 100) {
		log(chalk.yellow('⚠️  Cookie seems too short (less than 100 characters)'));
		return false;
	}
	if (!cookie.includes(';')) {
		log(chalk.yellow('⚠️  Cookie should contain semicolons (;)'));
		return false;
	}
	if (!cookie.includes('buvid4')) {
		log(chalk.yellow('⚠️  Cookie seems to be missing key fields'));
		return false;
	}
	return true;
}

function setupCookie(rl: readline.Interface, callback: () => void): void {
	log(chalk.yellow('No cookies found. Please enter your Bilibili cookies to proceed.'));
	log(chalk.gray('(You can get it from browser DevTools -> Application -> Cookies)\n'));

	const askForCookie = () => {
		rl.question('Enter your cookies: ', (inputCookie) => {
			if (!inputCookie.trim()) {
				log(chalk.red('Cookie cannot be empty!'));
				promptRetry();
				return;
			}

			if (!validateCookie(inputCookie)) {
				promptRetry();
				return;
			}

			config.headers.cookie = inputCookie.trim();
			fs.writeFileSync(config.cookieFile, inputCookie.trim(), 'utf-8');
			log(chalk.green('Cookies saved successfully.\n'));
			callback();
		});
	};

	const promptRetry = () => {
		rl.question('Do you want to re-enter cookies? (y/n): ', (answer) => {
			const trimmed = answer.trim().toLowerCase();
			if (trimmed === 'y' || trimmed === 'yes') {
				askForCookie();
			} else {
				log(chalk.red('Cannot proceed without valid cookies. Exiting.'));
				rl.close();
				process.exit(1);
			}
		});
	};

	askForCookie();
}

// ==================== URL 解析 ====================
function isSeasonUrl(url: string): boolean {
	return url.includes('seasons_archives_list');
}

function extractBVID(url: string): string | null {
	const bvidMatch = url.match(/BV[0-9A-Za-z]+/);
	return bvidMatch ? bvidMatch[0] : null;
}

function extractSeasonId(url: string): string | null {
	// 方式1: 从API URL中提取 (原有方式)
	// https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?season_id=2209693&...
	let seasonIdMatch = url.match(/season_id=(\d+)/);
	if (seasonIdMatch) {
		return seasonIdMatch[1];
	}

	// 方式2: 从用户空间合集URL中提取
	// https://space.bilibili.com/1060544882/lists/1049571?type=season
	// https://space.bilibili.com/xxx/lists/SEASON_ID
	seasonIdMatch = url.match(/\/lists\/(\d+)/);
	if (seasonIdMatch) {
		return seasonIdMatch[1];
	}

	return null;
}

// 方式3: 从用户空间主页URL中提取 UID (mid)
// https://space.bilibili.com/313580179/upload/video
// https://space.bilibili.com/313580179
function extractSpaceMid(url: string): string | null {
	const midMatch = url.match(/space\.bilibili\.com\/(\d+)/);
	return midMatch ? midMatch[1] : null;
}

// 判断是否为UP主主页投稿列表URL
function isSpaceUrl(url: string): boolean {
	// space.bilibili.com/{mid}（带或不带 /upload/video），但排除合集 /lists/ 链接
	return /space\.bilibili\.com\/\d+/.test(url) && !url.includes('/lists/');
}

// ==================== WBI 签名 (B站空间接口必须) ====================
// 混淆密钥表
const WBI_MIXIN_KEY_ENC_TAB = [
	46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
	33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40,
	61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11,
	36, 20, 34, 44, 52
];

// WBI 密钥缓存 (避免每次请求都打 nav 接口)
let wbiKeyCache: { imgKey: string; subKey: string; ts: number } | null = null;

function getMixinKey(orig: string): string {
	return WBI_MIXIN_KEY_ENC_TAB.map(n => orig[n]).join('').slice(0, 32);
}

// 获取 img_key / sub_key (从 nav 接口)
async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
	// 缓存 30 分钟
	if (wbiKeyCache && Date.now() - wbiKeyCache.ts < 30 * 60 * 1000) {
		return { imgKey: wbiKeyCache.imgKey, subKey: wbiKeyCache.subKey };
	}

	const response = await axios.get('https://api.bilibili.com/x/web-interface/nav', {
		headers: config.headers
	});

	const wbiImg = response.data?.data?.wbi_img;
	if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) {
		throw new Error('Failed to obtain WBI keys from nav API');
	}

	const imgKey = wbiImg.img_url.split('/').pop().split('.')[0];
	const subKey = wbiImg.sub_url.split('/').pop().split('.')[0];

	wbiKeyCache = { imgKey, subKey, ts: Date.now() };
	return { imgKey, subKey };
}

// 对参数进行 WBI 签名, 返回完整 query string
function encodeWbi(params: Record<string, string | number>, imgKey: string, subKey: string): string {
	const mixinKey = getMixinKey(imgKey + subKey);
	const currTime = Math.round(Date.now() / 1000);
	const signedParams: Record<string, string | number> = { ...params, wts: currTime };

	// 按 key 升序排序并过滤特殊字符
	const query = Object.keys(signedParams)
		.sort()
		.map(key => {
			const value = String(signedParams[key]).replace(/[!'()*]/g, '');
			return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
		})
		.join('&');

	const wRid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
	return `${query}&w_rid=${wRid}`;
}

// ==================== 文件名处理 ====================
function sanitizeFilename(filename: string): string {
	// 只移除文件系统不允许的字符
	return filename
		.replace(/[<>:"/\\|?*]/g, '') // Windows/Linux 非法字符
		.replace(/[\x00-\x1f]/g, '') // 控制字符
		.replace(/\s+/g, ' ') // 多个空格替换为单个
		.trim()
		.substring(0, 200); // 限制长度
}

function extractTitleFromBrackets(title: string): string {
	// 提取书名号《》内的内容
	const match = title.match(/《([^》]+)》/);
	if (match && match[1]) {
		return match[1].trim();
	}
	return title;
}

function generateFilename(videoInfo: VideoInfo, extension: string): string {
	// 先提取书名号内容
	const extractedTitle = extractTitleFromBrackets(videoInfo.title);
	const title = sanitizeFilename(extractedTitle);
	const author = sanitizeFilename(videoInfo.author);
	return `${title} - ${author}.${extension}`;
}

// ==================== 音频格式转换 ====================
function convertAudioFormat(
	inputPath: string,
	outputPath: string,
	format: 'flac' | 'mp3' | 'wav' | 'm4a',
	bitrate?: string,
	silent: boolean = false
): boolean {
	try {
		if (!silent) log(chalk.blue(`Converting to ${format.toUpperCase()}...`));

		// 如果是 m4a，直接复制不转换
		if (format === 'm4a') {
			fs.copyFileSync(inputPath, outputPath);
			if (!silent) log(chalk.green(`✅ Saved as M4A`));
			return true;
		}

		// 使用 ffmpeg-static 提供的路径，或回退到配置的路径
		const ffmpegExe = ffmpegPath || config.ffmpegPath || 'ffmpeg';

		let command = '';
		switch (format) {
			case 'flac':
				command = `"${ffmpegExe}" -i "${inputPath}" -c:a flac -compression_level 8 "${outputPath}" -y -loglevel error`;
				break;
			case 'mp3':
				command = `"${ffmpegExe}" -i "${inputPath}" -c:a libmp3lame -b:a ${bitrate || '320k'} "${outputPath}" -y -loglevel error`;
				break;
			case 'wav':
				command = `"${ffmpegExe}" -i "${inputPath}" -c:a pcm_s16le "${outputPath}" -y -loglevel error`;
				break;
		}

		// 同步执行转换
		execSync(command, { stdio: 'pipe' });

		// 删除临时 m4a 文件
		try {
			fs.unlinkSync(inputPath);
		} catch (error: any) {
			// 忽略删除错误
		}

		if (!silent) log(chalk.green(`✅ Converted to ${format.toUpperCase()}`));
		return true;

	} catch (error: any) {
		if (!silent) {
			log(chalk.red(`❌ Conversion failed: ${error.message || 'Unknown error'}`));
			log(chalk.yellow(`Hint: Install FFmpeg or run: npm install ffmpeg-static`));
		}
		// 转换失败，保留 m4a 文件
		return false;
	}
}

// ==================== HTML/数据获取 ====================
async function fetchVideoHtml(url: string): Promise<string> {
	const response = await axios.get(url, {
		headers: config.headers
	});
	return response.data;
}

async function fetchSeasonData(url: string): Promise<SeasonResponse> {
	const response = await axios.get(url, {
		headers: config.headers
	});
	return response.data;
}

// ==================== 数据提取 ====================
function extractVideoDataFromHtml(html: string, bvid: string): VideoData | null {
	const regex = /window\.__playinfo__\s*=\s*(\{.*?\})\s*<\/script>/;
	const match = html.match(regex);

	if (!match || !match[1]) {
		log(chalk.red('Failed to extract playinfo from HTML'));
		return null;
	}

	try {
		const playinfoJson = JSON.parse(match[1]);

		// 提取视频信息
		const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/);
		const authorMatch = html.match(/<meta[^>]*name="author"[^>]*content="([^"]*)"/);
		const descMatch = html.match(/<meta[^>]*name="description"[^>]*content="([^"]*)"/);

		// 清理标题：移除 "_哔哩哔哩_bilibili" 等后缀
		let cleanTitle = titleMatch ? titleMatch[1].trim() : 'Unknown';
		cleanTitle = cleanTitle
			.replace(/_哔哩哔哩_bilibili$/i, '')
			.replace(/ - 哔哩哔哩$/i, '')
			.replace(/\s+$/, '')
			.trim();

		const videoInfo: VideoInfo = {
			title: cleanTitle,
			author: authorMatch ? authorMatch[1] : 'Unknown',
			description: descMatch ? descMatch[1].replace(/\s*[，,]\s*相关视频[:：]?\s*.*$/, '').trim() : '',
			uploadDate: '',
			bvid: bvid
		};

		// 提取 cid (第一个分P), 用于调 playurl 拿高清流
		const cidMatch = html.match(/"cid":(\d+)/) || html.match(/&cid=(\d+)/);
		const cid = cidMatch ? cidMatch[1] : undefined;

		const videoData: VideoData = {
			audioArr: playinfoJson.data.dash.audio || [],
			videoArr: playinfoJson.data.dash.video || [],
			dolby: playinfoJson.data.dash.dolby || [],
			videoInfo: videoInfo,
			cid: cid
		};

		return videoData;
	} catch (error) {
		log(chalk.red('Failed to parse playinfo JSON:', error));
		return null;
	}
}

// ==================== 下载功能 ====================
async function downloadAudioToFolder(
	audioStreams: AudioStream[],
	videoInfo: VideoInfo,
	targetFolder: string,
	silent: boolean = false,
	progressCallback?: (progress: number, status: string) => void
): Promise<boolean> {
	if (audioStreams.length === 0) {
		if (!silent) log(chalk.red('No audio streams found to download.'));
		return false;
	}

	if (!silent) log(chalk.yellow(`Found ${audioStreams.length} audio stream(s). Downloading the highest quality one.`));

	// 按带宽排序,选择最高质量
	const sortedStreams = [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth);
	const bestAudio = sortedStreams[0];

	// 收集所有可能的URL (过滤掉 undefined/null)
	const urlsToDownload = [
		bestAudio.baseUrl,
		bestAudio.base_url,
		...(bestAudio.backupUrl || []),
		...(bestAudio.backup_url || [])
	].filter((url): url is string => !!url); // 类型守卫：确保过滤后都是 string

	// 尝试每个URL直到成功
	for (const url of urlsToDownload) {
		try {
			if (!silent) log(chalk.blue(`Downloading audio from URL: ${url.substring(0, 80)}...`));
			if (progressCallback) progressCallback(5, chalk.cyan('Connecting...'));

			const res = await axios.get(url, {
				headers: config.headers,
				responseType: 'arraybuffer',
				onDownloadProgress: (progressEvent) => {
					if (progressCallback && progressEvent.total) {
						const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
						// 下载阶段占 5-85%
						const adjustedProgress = 5 + Math.round(percentCompleted * 0.8);
						progressCallback(adjustedProgress, chalk.cyan(`Downloading ${percentCompleted}%`));
					}
				}
			});

			if (res.status !== 200) {
				if (!silent) log(chalk.yellow(`Warning: Received status code ${res.status}. Trying next URL...`));
				continue;
			}

			if (!res.data || res.data.byteLength === 0) {
				if (!silent) log(chalk.yellow('Warning: Empty response data. Trying next URL...'));
				continue;
			}

			if (progressCallback) progressCallback(90, chalk.yellow('Saving file...'));

			// 下载成功,保存为临时 m4a 文件
			const tempFilename = generateFilename(videoInfo, 'm4a');
			const tempFilepath = path.join(targetFolder, tempFilename);
			fs.writeFileSync(tempFilepath, Buffer.from(res.data));

			// 如果目标格式不是 m4a，则转换
			if (config.audioFormat !== 'm4a') {
				if (progressCallback) progressCallback(93, chalk.magenta('Converting...'));

				const finalFilename = generateFilename(videoInfo, config.audioFormat);
				const finalFilepath = path.join(targetFolder, finalFilename);

				const success = convertAudioFormat(
					tempFilepath,
					finalFilepath,
					config.audioFormat,
					config.audioBitrate,
					silent
				);

				if (success) {
					if (!silent) log(chalk.green(`✅ Download finished: ${finalFilename}`));
					if (progressCallback) progressCallback(100, chalk.green('✓ Done'));
				} else {
					if (!silent) {
						log(chalk.red(`❌ Conversion failed, keeping original m4a file`));
						log(chalk.yellow(`Saved as: ${tempFilename}`));
					}
					if (progressCallback) progressCallback(100, chalk.yellow('✓ Saved (m4a)'));
				}
			} else {
				if (!silent) log(chalk.green(`✅ Download finished: ${tempFilename}`));
				if (progressCallback) progressCallback(100, chalk.green('✓ Done'));
			}

			return true;
		} catch (error: any) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (!silent) {
				log(chalk.yellow(`Error downloading from ${url.substring(0, 50)}...: ${errorMsg}`));
				log(chalk.yellow('Trying next URL...'));
			}
			if (progressCallback) progressCallback(0, chalk.red('Error, retrying...'));
			continue;
		}
	}

	if (!silent) log(chalk.red('❌ Failed to download audio from all available URLs.'));
	if (progressCallback) progressCallback(0, chalk.red('✗ Failed'));
	return false;
}

async function downloadAudioStream(audioStreams: AudioStream[], videoInfo: VideoInfo): Promise<boolean> {
	return downloadAudioToFolder(audioStreams, videoInfo, config.downloadDir);
}

// ==================== 下载模式 (音频 / 视频) ====================
// 每次输入 URL 前由用户选择, 默认仅音频
let downloadMode: 'audio' | 'video' = 'audio';

// 输出基目录: 视频模式存到 downloads/video, 音频模式仍在 downloads
function getOutputBaseDir(): string {
	const base = downloadMode === 'video'
		? path.join(config.downloadDir, 'video')
		: config.downloadDir;
	if (!fs.existsSync(base)) {
		fs.mkdirSync(base, { recursive: true });
	}
	return base;
}

// 记录最近一次流下载失败原因 (供上层报错展示)
let lastStreamError = '';

// 字节 → MB 字符串
function fmtMB(bytes: number): string {
	return (bytes / 1048576).toFixed(1) + 'MB';
}

// 下载单条 dash 流 (视频或音频) 到指定文件, 依次尝试各 URL 直到成功
async function downloadStreamToFile(
	stream: AudioStream,
	filepath: string,
	onProgress?: (pct: number, info: string) => void,
	silent: boolean = false
): Promise<boolean> {
	const urls = [
		stream.baseUrl,
		stream.base_url,
		...(stream.backupUrl || []),
		...(stream.backup_url || [])
	].filter((u): u is string => !!u);

	if (urls.length === 0) {
		lastStreamError = '无可用 URL';
		return false;
	}

	// CDN 只认 UA + Referer + Range; 绝不发登录 cookie (会被 CDN 403)
	const cdnHeaders = {
		'user-agent': config.headers['user-agent'],
		'referer': 'https://www.bilibili.com/',
		'accept': '*/*',
		'range': 'bytes=0-'
	};

	// 分块下载单块 (Range), 每块最多重试 3 次
	const CHUNK = 4 * 1024 * 1024;   // 4MB 一段
	const CHUNK_CONCURRENCY = 6;      // 并发段数 (B站按连接限速, 多连接叠加带宽)
	const getChunk = async (url: string, start: number, end: number): Promise<Buffer> => {
		let err: any;
		for (let i = 0; i < 3; i++) {
			try {
				const r = await axios.get(url, {
					headers: { ...cdnHeaders, range: `bytes=${start}-${end}` },
					responseType: 'arraybuffer',
					decompress: false,
					timeout: 30000,
					maxContentLength: Infinity,
					maxBodyLength: Infinity
				});
				return Buffer.from(r.data);
			} catch (e) {
				err = e;
				await new Promise(res => setTimeout(res, 800 * (i + 1)));
			}
		}
		throw err;
	};

	let lastInfo = 'no url';
	for (const url of urls) {
		try {
			// 1) 探测总大小 (Range 0-0 → Content-Range: bytes 0-0/TOTAL)
			const probe = await axios.get(url, {
				headers: { ...cdnHeaders, range: 'bytes=0-0' },
				responseType: 'arraybuffer',
				decompress: false,
				timeout: 20000
			});
			if (probe.status !== 206 && probe.status !== 200) {
				lastInfo = `status ${probe.status}`;
				continue;
			}
			let total = 0;
			const cr = probe.headers['content-range'];
			if (cr) {
				const m = String(cr).match(/\/(\d+)\s*$/);
				if (m) total = parseInt(m[1], 10);
			}
			if (!total) total = parseInt(probe.headers['content-length'] || '0', 10);

			// 2) 并发分段下载 + 定位写盘 (多连接叠加带宽, 某块卡住只重试该块, 不拖累整体)
			if (total > 0) {
				const ranges: Array<[number, number]> = [];
				for (let s = 0; s < total; s += CHUNK) {
					ranges.push([s, Math.min(s + CHUNK - 1, total - 1)]);
				}
				const fd = fs.openSync(filepath, 'w');
				try {
					const limit = pLimit(CHUNK_CONCURRENCY);
					let done = 0;
					const t0 = Date.now();
					await Promise.all(ranges.map(([s, e]) => limit(async () => {
						const buf = await getChunk(url, s, e);
						await new Promise<void>((resolve, reject) => {
							fs.write(fd, buf, 0, buf.length, s, (err) => err ? reject(err) : resolve());
						});
						done += (e - s + 1);
						const elapsed = (Date.now() - t0) / 1000;
						const speed = elapsed > 0 ? done / elapsed : 0;
						if (onProgress) {
							onProgress(
								Math.min(100, Math.round((done * 100) / total)),
								`${fmtMB(done)}/${fmtMB(total)} ${fmtMB(speed)}/s`
							);
						}
					})));
				} finally {
					fs.closeSync(fd);
				}
			} else {
				// 未知大小: 退回整段流式
				const writer = fs.createWriteStream(filepath);
				try {
					const res = await axios.get(url, { headers: cdnHeaders, responseType: 'stream', decompress: false });
					await new Promise<void>((resolve, reject) => {
						res.data.on('error', reject);
						writer.on('error', reject);
						writer.on('finish', () => resolve());
						res.data.pipe(writer);
					});
				} catch (inner) {
					writer.destroy();
					throw inner;
				}
			}

			if (fs.existsSync(filepath) && fs.statSync(filepath).size > 0) {
				return true;
			}
			lastInfo = 'empty file';
		} catch (e: any) {
			lastInfo = e.response ? `HTTP ${e.response.status}` : (e.code || e.message || String(e));
			try { fs.unlinkSync(filepath); } catch (_) { /* ignore */ }
			continue;
		}
	}
	lastStreamError = lastInfo;
	if (!silent) log(chalk.gray(`  (stream 下载失败: ${lastInfo})`));
	return false;
}

// 调 playurl 接口拿高清 dash 流。网页嵌入的 __playinfo__ 画质被限死,
// 这里显式请求 fnval=4048(全量 dash)+ qn=127(最高档),1080P+/大会员档由账号决定。
async function fetchHighQualityDash(bvid: string, cid: string): Promise<{ video: any[], audio: AudioStream[] } | null> {
	try {
		const { imgKey, subKey } = await getWbiKeys();
		const params: Record<string, string | number> = {
			bvid: bvid,
			cid: cid,
			qn: 127,
			fnval: 4048,
			fourk: 1,
			otype: 'json',
			platform: 'pc'
		};
		const query = encodeWbi(params, imgKey, subKey);
		const res = await axios.get(`https://api.bilibili.com/x/player/wbi/playurl?${query}`, {
			headers: { ...config.headers, referer: `https://www.bilibili.com/video/${bvid}` }
		});
		const json = res.data;
		if (json.code !== 0 || !json.data?.dash?.video) {
			return null;
		}
		// 仅取普通 AAC 音频 (dash.audio), 保证 ffmpeg -c copy 能直接封进 mp4
		return { video: json.data.dash.video, audio: json.data.dash.audio || [] };
	} catch (_) {
		return null;
	}
}

// 下载视频: 取最高画质视频流 + 最高音频流, 用 ffmpeg 合并为 mp4
async function downloadVideoToFolder(
	videoStreams: any[],
	audioStreams: AudioStream[],
	videoInfo: VideoInfo,
	targetFolder: string,
	silent: boolean = false,
	progressCallback?: (progress: number, status: string) => void
): Promise<boolean> {
	if (!videoStreams || videoStreams.length === 0) {
		if (!silent) log(chalk.red('No video streams found to download.'));
		if (progressCallback) progressCallback(0, chalk.red('✗ No video'));
		return false;
	}

	// 先按画质档 id 降序 (80=1080P, 116=1080P60, 120=4K, 127=8K), 同档再按带宽
	const bestVideo = [...videoStreams].sort(
		(a, b) => ((b.id || 0) - (a.id || 0)) || ((b.bandwidth || 0) - (a.bandwidth || 0))
	)[0];
	const bestAudio = (audioStreams && audioStreams.length)
		? [...audioStreams].sort((a, b) => b.bandwidth - a.bandwidth)[0]
		: null;

	const base = generateFilename(videoInfo, 'mp4').replace(/\.mp4$/i, '');
	const vTemp = path.join(targetFolder, `${base}.video.m4s`);
	const aTemp = path.join(targetFolder, `${base}.audio.m4s`);
	const outPath = path.join(targetFolder, `${base}.mp4`);

	try {
		// 1) 下载视频流 (占 5-55%)
		if (progressCallback) progressCallback(5, chalk.cyan('Video...'));
		const vOk = await downloadStreamToFile(bestVideo, vTemp, (p, info) => {
			if (progressCallback) progressCallback(5 + Math.round(p * 0.5), chalk.cyan(`视频 ${info}`));
		}, silent);
		if (!vOk) {
			if (!silent) log(chalk.red(`❌ 视频流下载失败 (${lastStreamError || '未知'})`));
			if (progressCallback) progressCallback(0, chalk.red(`✗ ${lastStreamError || 'Failed'}`));
			return false;
		}

		// 2) 下载音频流 (占 55-80%)
		let aOk = false;
		if (bestAudio) {
			if (progressCallback) progressCallback(55, chalk.cyan('Audio...'));
			aOk = await downloadStreamToFile(bestAudio, aTemp, (p, info) => {
				if (progressCallback) progressCallback(55 + Math.round(p * 0.25), chalk.cyan(`音频 ${info}`));
			}, silent);
		}

		// 3) ffmpeg 合并 (占 80-100%)
		if (progressCallback) progressCallback(85, chalk.magenta('Merging...'));
		const ffmpegExe = ffmpegPath || config.ffmpegPath || 'ffmpeg';
		const command = aOk
			? `"${ffmpegExe}" -i "${vTemp}" -i "${aTemp}" -c copy -y -loglevel error "${outPath}"`
			: `"${ffmpegExe}" -i "${vTemp}" -c copy -y -loglevel error "${outPath}"`;
		execSync(command, { stdio: 'pipe' });

		// 清理临时分离文件
		try { fs.unlinkSync(vTemp); } catch (_) { /* ignore */ }
		try { if (aOk) fs.unlinkSync(aTemp); } catch (_) { /* ignore */ }

		if (!silent) log(chalk.green(`✅ Video saved: ${base}.mp4`));
		if (progressCallback) progressCallback(100, chalk.green('✓ Done'));
		return true;
	} catch (error: any) {
		try { fs.unlinkSync(vTemp); } catch (_) { /* ignore */ }
		try { fs.unlinkSync(aTemp); } catch (_) { /* ignore */ }
		const msg = error instanceof Error ? error.message : String(error);
		if (!silent) {
			log(chalk.red(`❌ Video merge failed: ${msg}`));
			log(chalk.yellow('Hint: 确保 ffmpeg 可用 (npm install ffmpeg-static)'));
		}
		if (progressCallback) progressCallback(0, chalk.red('✗ Failed'));
		return false;
	}
}

// 按当前模式分发: 视频 → 下视频并合并; 音频 → 原有逻辑
async function downloadMediaToFolder(
	videoData: VideoData,
	targetFolder: string,
	silent: boolean = false,
	progressCallback?: (progress: number, status: string) => void
): Promise<boolean> {
	if (downloadMode === 'video') {
		let videoStreams = videoData.videoArr;
		let audioStreams = videoData.audioArr;
		// 用 playurl 接口把网页里被限死的画质升级到最高 (1080P/60、4K 等)
		if (videoData.cid) {
			const hq = await fetchHighQualityDash(videoData.videoInfo.bvid, videoData.cid);
			if (hq && hq.video.length > 0) {
				videoStreams = hq.video;
				if (hq.audio.length > 0) audioStreams = hq.audio;
			}
		}
		return downloadVideoToFolder(videoStreams, audioStreams, videoData.videoInfo, targetFolder, silent, progressCallback);
	}
	return downloadAudioToFolder(videoData.audioArr, videoData.videoInfo, targetFolder, silent, progressCallback);
}

// 询问下载类型 (视频 / 仅音频)
function askDownloadType(rl: readline.Interface): Promise<'audio' | 'video'> {
	return new Promise((resolve) => {
		rl.question(chalk.yellow('下载类型?  [1] 仅音频(默认)   [2] 视频(自动合并为 mp4) : '), (ans) => {
			resolve(ans.trim() === '2' ? 'video' : 'audio');
		});
	});
}

// ==================== 合集列表获取 ====================
async function fetchAllSeasonArchives(seasonId: string): Promise<{ archives: SeasonArchive[], meta: SeasonMeta } | null> {
	try {
		const allArchives: SeasonArchive[] = [];
		let pageNum = 1;
		const pageSize = 100; // 每页获取100个
		let meta: SeasonMeta | null = null;

		log(chalk.blue('Fetching season data...'));

		while (true) {
			const url = `https://api.bilibili.com/x/polymer/web-space/seasons_archives_list?season_id=${seasonId}&page_size=${pageSize}&page_num=${pageNum}`;
			const response = await fetchSeasonData(url);

			if (response.code !== 0) {
				log(chalk.red(`API Error: ${response.message}`));
				return null;
			}

			// 保存 meta 信息
			if (!meta) {
				meta = response.data.meta;
			}

			// 如果没有数据了，退出循环
			if (response.data.archives.length === 0) {
				break;
			}

			allArchives.push(...response.data.archives);
			log(chalk.gray(`Fetched page ${pageNum}, total: ${allArchives.length}/${meta.total}`));

			// 如果已经获取了所有视频，退出
			if (allArchives.length >= meta.total) {
				break;
			}

			pageNum++;

			// 稍微延迟，避免请求过快
			await new Promise(resolve => setTimeout(resolve, 300));
		}

		log(chalk.green(`✅ Fetched ${allArchives.length} videos from season\n`));
		return { archives: allArchives, meta: meta! };

	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error fetching season archives:', errorMsg));
		return null;
	}
}

// ==================== UP主主页视频列表获取 ====================
// 把 "MM:SS" / "HH:MM:SS" 时长字符串转换为秒数
function parseDurationToSeconds(length: string): number {
	if (!length) return 0;
	const parts = length.split(':').map(p => parseInt(p, 10) || 0);
	return parts.reduce((acc, val) => acc * 60 + val, 0);
}

// 把空间接口返回的 vlist 条目映射为 SeasonArchive 结构, 以复用预览/下载逻辑
function mapVlistToArchive(v: any): SeasonArchive {
	// title 偶尔含 <em class="keyword"> 高亮标签, 去除之
	const cleanTitle = String(v.title || '').replace(/<[^>]+>/g, '').trim();
	return {
		aid: v.aid,
		bvid: v.bvid,
		ctime: v.created,
		duration: parseDurationToSeconds(v.length),
		title: cleanTitle,
		pic: v.pic,
		pubdate: v.created,
		stat: {
			view: v.play || 0,
			vt: 0,
			danmaku: v.video_review || 0
		},
		state: 0,
		ugc_pay: 0,
		vt_display: '',
		is_lesson_video: 0
	};
}

// ==================== HTTP (axios, 携带登录 cookie) ====================
// -352 风控的真因是 cookie 登录态失效 / bili_ticket 过期, 不是 TLS。
// axios 会带上 config.headers.cookie (含 SESSDATA), 配合自动续 bili_ticket 即可。

// 发 GET 并返回 JSON (带完整登录 cookie + 浏览器头)
async function httpGetJson(url: string, headers: Record<string, string>): Promise<any> {
	const merged = { ...config.headers, ...headers };
	const res = await axios.get(url, { headers: merged });
	return res.data;
}

// 解析 cookie 里 bili_ticket(JWT) 的过期时间; 无/解析失败返回 0
function getBiliTicketExp(cookie: string): number {
	const m = cookie.match(/bili_ticket=([^;]+)/);
	if (!m) return 0;
	try {
		const payload = m[1].split('.')[1];
		const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf-8'));
		return json.exp || 0;
	} catch (_) {
		return 0;
	}
}

// 自动刷新 bili_ticket (只活 3 天, 过期就 -352)。无需重新登录, 用 bili_jct 做 csrf。
async function refreshBiliTicket(): Promise<void> {
	const cookie = config.headers.cookie || '';
	const exp = getBiliTicketExp(cookie);
	const now = Math.floor(Date.now() / 1000);
	// 还有 >10 分钟才过期则不刷新
	if (exp && exp - now > 600) {
		return;
	}

	try {
		const csrfMatch = cookie.match(/bili_jct=([^;]+)/);
		const csrf = csrfMatch ? csrfMatch[1] : '';
		const ts = now;
		const hexsign = crypto.createHmac('sha256', 'XgwSnGZ1p').update(`ts${ts}`).digest('hex');
		const url = `https://api.bilibili.com/bapis/bilibili.api.ticket.v1.Ticket/GenWebTicket`
			+ `?key_id=ec02&hexsign=${hexsign}&context%5Bts%5D=${ts}&csrf=${csrf}`;

		const res = await axios.post(url, null, {
			headers: {
				...config.headers,
				'accept': '*/*',
				'origin': 'https://www.bilibili.com',
				'referer': 'https://www.bilibili.com/'
			}
		});

		const body = res.data;
		const ticket = body?.data?.ticket;
		if (!ticket) {
			log(chalk.gray(`bili_ticket 刷新无效: ${JSON.stringify(body).slice(0, 150)}`));
			return;
		}

		let newCookie = cookie;
		newCookie = /bili_ticket=([^;]+)/.test(newCookie)
			? newCookie.replace(/bili_ticket=[^;]*/, `bili_ticket=${ticket}`)
			: `${newCookie}; bili_ticket=${ticket}`;
		config.headers.cookie = newCookie;
		// 写回 cookies.txt, 让下次直接用新票
		try { fs.writeFileSync(config.cookieFile, newCookie, 'utf-8'); } catch (_) { /* ignore */ }
		log(chalk.green('🎟️  bili_ticket 已自动刷新'));
	} catch (e: any) {
		log(chalk.gray(`bili_ticket 刷新跳过: ${e?.message || e}`));
	}
}

// 获取某个UP主的全部投稿视频 (axios + WBI 签名 + 分页)
async function fetchAllSpaceVideos(mid: string): Promise<{ archives: SeasonArchive[], meta: SeasonMeta } | null> {
	try {
		log(chalk.blue('Fetching uploader video list...'));

		// cookie 诊断 (SESSDATA 缺失则未登录, 必被风控)
		const ckBefore = config.headers.cookie || '';
		const ckHas = (k: string) => ckBefore.includes(k + '=');
		if (!ckHas('SESSDATA')) {
			log(chalk.yellow('⚠️  cookies.txt 缺 SESSDATA (HttpOnly, 需从 Network→请求头 Cookie 整行复制)。未登录必被风控。'));
		}

		// bili_ticket 只活 3 天, 过期自动续票 (无需重新登录)
		await refreshBiliTicket();

		const ck = config.headers.cookie || '';
		const exp = getBiliTicketExp(ck);
		const leftMin = exp ? Math.round((exp - Date.now() / 1000) / 60) : 0;
		log(chalk.gray(`Cookie 诊断: SESSDATA=${ckHas('SESSDATA')} bili_ticket 剩余=${leftMin}min bili_jct=${ckHas('bili_jct')}`));

		const reqHeaders: Record<string, string> = {
			'accept': '*/*',
			'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
			'cache-control': 'no-cache',
			'origin': 'https://space.bilibili.com',
			'pragma': 'no-cache',
			'priority': 'u=1, i',
			'referer': `https://space.bilibili.com/${mid}/upload/video`,
			'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
			'sec-ch-ua-mobile': '?0',
			'sec-ch-ua-platform': '"Windows"',
			'sec-fetch-dest': 'empty',
			'sec-fetch-mode': 'cors',
			'sec-fetch-site': 'same-site',
			'cookie': ck
		};

		// 1) 获取 WBI 密钥
		const nav = await httpGetJson('https://api.bilibili.com/x/web-interface/nav', reqHeaders);
		const wbiImg = nav?.data?.wbi_img;
		if (!wbiImg || !wbiImg.img_url || !wbiImg.sub_url) {
			log(chalk.red('Failed to obtain WBI keys from nav API'));
			log(chalk.gray(`nav raw: ${JSON.stringify(nav).slice(0, 300)}`));
			return null;
		}
		// nav 通过, 说明能正常访问 B 站 (isLogin 见上方诊断)
		log(chalk.gray(`nav OK, isLogin=${nav?.data?.isLogin}, uname=${nav?.data?.uname || ''}`));
		const imgKey = wbiImg.img_url.split('/').pop().split('.')[0];
		const subKey = wbiImg.sub_url.split('/').pop().split('.')[0];

		// 2) 翻页拉全部投稿
		const rawList: any[] = [];
		let authorName = '';
		let total = 0;
		let pageNum = 1;
		const pageSize = 25;

		while (true) {
			const params: Record<string, string | number> = {
				mid: mid,
				ps: pageSize,
				pn: pageNum,
				order: 'pubdate',
				index: 1,
				order_avoided: 'true',
				platform: 'web',
				web_location: '333.1387',
				// 反爬指纹参数 dm_* (配合 WBI 签名一起绕过 -352)
				dm_img_list: '[]',
				dm_img_str: 'V2ViR0wgMS4wIChPcGVuR0wgRVMgMi4wIENocm9taXVtKQ',
				dm_cover_img_str: 'QU5HTEUgKEludGVsLCBJbnRlbChSKSBVSEQgR3JhcGhpY3MgNjMwICgweDAwMDAzRTkyKSBEaXJlY3QzRDExIHZzXzVfMCBwc181XzAsIEQzRDExKUdvb2dsZSBJbmMuIChJbnRlbCk',
				dm_img_inter: '{"ds":[],"wh":[0,0,0],"of":[0,0,0]}'
			};
			const query = encodeWbi(params, imgKey, subKey);
			const json = await httpGetJson(`https://api.bilibili.com/x/space/wbi/arc/search?${query}`, reqHeaders);

			if (!json) {
				log(chalk.red('No/invalid response from space API'));
					return null;
			}
			if (json.code !== 0) {
				log(chalk.red(`API Error: ${json.message} (code ${json.code})`));
				log(chalk.gray(`arc/search raw: ${JSON.stringify(json).slice(0, 300)}`));
				log(chalk.gray(`signed query: ${query.slice(0, 200)}`));
				if (json.code === -352) {
					log(chalk.yellow('仍被风控 (-352)。请确认 cookies.txt 为已登录的完整 cookie, 或稍后重试。'));
				}
					return null;
			}

			const data = json.data;
			const vlist: any[] = data?.list?.vlist || [];
			total = data?.page?.count ?? total;

			if (!authorName && vlist.length > 0) {
				authorName = vlist[0].author || '';
			}
			if (vlist.length === 0) break;

			rawList.push(...vlist);
			log(chalk.gray(`Fetched page ${pageNum}, total: ${rawList.length}/${total}`));

			if (rawList.length >= total) break;
			pageNum++;
			await new Promise(resolve => setTimeout(resolve, 400));
		}


		if (rawList.length === 0) {
			log(chalk.red('No videos found for this uploader.'));
			return null;
		}

		const allArchives: SeasonArchive[] = rawList.map(mapVlistToArchive);

		// 按发布时间升序排序 (由先到后: 最早的视频排在前面)
		allArchives.sort((a, b) => a.pubdate - b.pubdate);

		const meta: SeasonMeta = {
			category: 0,
			cover: allArchives[0]?.pic || '',
			description: '',
			mid: parseInt(mid, 10),
			name: authorName,
			ptime: 0,
			season_id: 0,
			total: allArchives.length,
			// title 同时用作下载文件夹名, 因此直接使用UP主名字
			title: authorName || `UP_${mid}`
		};

		log(chalk.green(`✅ Fetched ${allArchives.length} videos from uploader\n`));
		return { archives: allArchives, meta };

	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error fetching uploader videos:', errorMsg));
		return null;
	}
}

// 下载某个UP主主页的全部投稿视频 (复用合集的菜单/预览/下载流程)
async function downloadSpace(url: string, rl: readline.Interface): Promise<boolean> {
	try {
		const mid = extractSpaceMid(url);
		if (!mid) {
			log(chalk.red('Failed to extract UID (mid) from space URL'));
			return false;
		}

		const result = await fetchAllSpaceVideos(mid);
		if (!result) {
			return false;
		}

		const { archives, meta } = result;

		while (true) {
			const choice = await showSeasonMenu(archives, meta, rl);

			if (choice === 'cancel') {
				log(chalk.yellow('\nCancelled.\n'));
				return false;
			}

			if (choice === 'preview') {
				await previewSeasonArchives(archives, meta, rl);
				continue;
			}

			if (choice === 'download') {
				return await downloadSeasonArchives(archives, meta, rl);
			}
		}

	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error during space download:', errorMsg));
		return false;
	}
}

// ==================== 合集预览 ====================
async function previewSeasonArchives(archives: SeasonArchive[], meta: SeasonMeta, rl: readline.Interface): Promise<void> {
	return new Promise((resolve) => {
		const itemsPerPage = 10;
		let currentPage = 0;
		const totalPages = Math.ceil(archives.length / itemsPerPage);

		const displayPage = () => {
			console.clear();
			log(chalk.bold.cyan(`\n=== ${meta.title} ===`));
			log(chalk.gray(`Total: ${meta.total} videos | Page ${currentPage + 1}/${totalPages}\n`));

			const startIdx = currentPage * itemsPerPage;
			const endIdx = Math.min(startIdx + itemsPerPage, archives.length);

			for (let i = startIdx; i < endIdx; i++) {
				const archive = archives[i];
				log(chalk.white(`${i + 1}. `) + chalk.green(archive.title));
				log(chalk.gray(`   BVID: ${archive.bvid} | Duration: ${archive.duration}s | Views: ${archive.stat.view}\n`));
			}

			log(chalk.yellow('\nControls:'));
			log(chalk.gray('  [A] or [←] Previous page'));
			log(chalk.gray('  [D] or [→] Next page'));
			log(chalk.gray('  [ESC] Return to menu\n'));
		};

		displayPage();

		// 暂停 readline，启用 raw mode
		rl.pause();
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		const onKeyPress = (key: string) => {
			// ESC 键 (ASCII 27)
			if (key === '\u001b') {
				cleanup();
				resolve();
				return;
			}

			// Ctrl+C
			if (key === '\u0003') {
				cleanup();
				process.exit(0);
			}

			// 左箭头或 'a'
			if (key === '\u001b[D' || key.toLowerCase() === 'a') {
				if (currentPage > 0) {
					currentPage--;
					displayPage();
				}
			}

			// 右箭头或 'd'
			if (key === '\u001b[C' || key.toLowerCase() === 'd') {
				if (currentPage < totalPages - 1) {
					currentPage++;
					displayPage();
				}
			}
		};

		const cleanup = () => {
			process.stdin.removeListener('data', onKeyPress);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
			process.stdin.pause();
			// 恢复 readline
			rl.resume();
		};

		process.stdin.on('data', onKeyPress);
	});
}

// ==================== 合集下载菜单 ====================
async function showSeasonMenu(archives: SeasonArchive[], meta: SeasonMeta, rl: readline.Interface): Promise<'preview' | 'download' | 'cancel'> {
	return new Promise((resolve) => {
		console.clear();
		log(chalk.bold.cyan(`\n=== ${meta.title} ===`));
		log(chalk.green(`Total videos: ${meta.total}\n`));
		log(chalk.yellow('What would you like to do?'));
		log(chalk.white('  [1] Preview list'));
		log(chalk.white('  [2] Download all'));
		log(chalk.white('  [ESC] Cancel\n'));

		// 暂停 readline，启用 raw mode
		rl.pause();
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();
		process.stdin.setEncoding('utf8');

		const onKeyPress = (key: string) => {
			cleanup();

			if (key === '1') {
				resolve('preview');
			} else if (key === '2') {
				resolve('download');
			} else if (key === '\u001b') { // ESC
				resolve('cancel');
			} else if (key === '\u0003') { // Ctrl+C
				process.exit(0);
			}
		};

		const cleanup = () => {
			process.stdin.removeListener('data', onKeyPress);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
			process.stdin.pause();
			// 恢复 readline
			rl.resume();
		};

		process.stdin.on('data', onKeyPress);
	});
}
async function downloadSingleVideo(url: string): Promise<boolean> {
	try {
		// 1. 提取BVID
		const bvid = extractBVID(url);
		if (!bvid) {
			log(chalk.red('Failed to extract BVID from URL'));
			return false;
		}
		log(chalk.blue(`Extracted BVID: ${bvid}`));

		// 2. 获取HTML
		const html = await fetchVideoHtml(url);

		// 3. 提取视频数据
		const videoData = extractVideoDataFromHtml(html, bvid);
		if (!videoData) {
			return false;
		}

		// 4. 显示视频信息
		log(chalk.green(`Video Title: ${videoData.videoInfo.title}`));
		log(chalk.green(`Author: ${videoData.videoInfo.author}`));
		log(chalk.green(`BVID: ${videoData.videoInfo.bvid}`));
		log(chalk.green(`Description: ${videoData.videoInfo.description}`));

		// 5. 下载 (按模式: 视频或音频; 视频存到 downloads/video), 带进度条
		const bar = new cliProgress.SingleBar({
			format: ' {bar} | {percentage}% | {status}',
			hideCursor: true,
			barCompleteChar: '█',
			barIncompleteChar: '░',
			clearOnComplete: false
		}, cliProgress.Presets.shades_grey);
		bar.start(100, 0, { status: chalk.yellow('Starting...') });

		lastStreamError = '';
		const success = await downloadMediaToFolder(
			videoData,
			getOutputBaseDir(),
			true, // silent: 交给进度条显示
			(progress, status) => bar.update(progress, { status })
		);

		bar.update(100, { status: success ? chalk.green('✓ Done') : chalk.red(`✗ ${lastStreamError || 'Failed'}`) });
		bar.stop();

		if (success) {
			log(chalk.green('✅ 下载完成'));
		} else {
			log(chalk.red(`❌ 下载失败: ${lastStreamError || '未知原因'}`));
		}
		return success;
	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error during video download:', errorMsg));
		return false;
	}
}

// ==================== 单个视频下载（用于并发） ====================
async function downloadSingleArchive(
	archive: SeasonArchive,
	seasonFolder: string,
	videoBar: any,
	index: number,
	total: number
): Promise<{ success: boolean, title: string, bvid: string, url: string, error?: string }> {
	const videoUrl = `https://www.bilibili.com/video/${archive.bvid}`;

	try {
		// 断点续传: 若该视频音频已存在则跳过 (按 "标题 - " 前缀匹配, 忽略作者名差异)
		try {
			const extractedTitle = sanitizeFilename(extractTitleFromBrackets(archive.title));
			const prefix = `${extractedTitle} - `;
			// 视频模式看 .mp4, 音频模式看音频后缀
			const extRe = downloadMode === 'video' ? /\.mp4$/i : /\.(mp3|m4a|flac|wav)$/i;
			if (extractedTitle && fs.existsSync(seasonFolder)) {
				const exists = fs.readdirSync(seasonFolder).some(
					f => f.startsWith(prefix) && extRe.test(f)
				);
				if (exists) {
					videoBar.update(100, { status: chalk.gray('✓ Skipped (exists)') });
					return {
						success: true,
						title: archive.title,
						bvid: archive.bvid,
						url: videoUrl
					};
				}
			}
		} catch (_) { /* 扫描失败则照常下载 */ }

		// 获取视频数据
		videoBar.update(0, { status: chalk.yellow('Fetching info...') });
		const html = await fetchVideoHtml(videoUrl);
		const videoData = extractVideoDataFromHtml(html, archive.bvid);

		if (!videoData) {
			videoBar.update(0, { status: chalk.red('✗ Failed') });
			return {
				success: false,
				title: archive.title,
				bvid: archive.bvid,
				url: videoUrl,
				error: 'Failed to extract video data'
			};
		}

		// 下载到合集文件夹 (按模式: 视频或音频), 使用进度回调
		const downloaded = await downloadMediaToFolder(
			videoData,
			seasonFolder,
			true, // silent mode
			(progress, status) => {
				videoBar.update(progress, { status });
			}
		);

		if (downloaded) {
			videoBar.update(100, { status: chalk.green('✓ Completed') });
		} else {
			videoBar.update(0, { status: chalk.red('✗ Failed') });
		}

		return {
			success: downloaded,
			title: videoData.videoInfo.title,
			bvid: archive.bvid,
			url: videoUrl,
			error: downloaded ? undefined : 'Download or conversion failed'
		};

	} catch (error: any) {
		videoBar.update(0, { status: chalk.red('✗ Error') });
		return {
			success: false,
			title: archive.title,
			bvid: archive.bvid,
			url: videoUrl,
			error: error.message || 'Unknown error'
		};
	}
}

// ==================== 合集下载（多进度条版本） ====================
async function downloadSeasonArchives(archives: SeasonArchive[], meta: SeasonMeta, rl: readline.Interface): Promise<boolean> {
	try {
		log(chalk.green(`\n=== Starting download: ${meta.title} ===`));
		log(chalk.green(`Total videos: ${archives.length}`));
		log(chalk.cyan(`Concurrency: ${config.concurrency} simultaneous downloads\n`));

		// 创建合集文件夹 (视频模式在 downloads/video 下)
		const seasonFolderName = sanitizeFilename(meta.title);
		const seasonFolder = path.join(getOutputBaseDir(), seasonFolderName);

		if (!fs.existsSync(seasonFolder)) {
			fs.mkdirSync(seasonFolder, { recursive: true });
			log(chalk.blue(`Created folder: ${seasonFolderName}\n`));
		}

		let failedDownloads: FailedDownload[] = [];
		let archivesToDownload = [...archives];

		// 下载循环（支持重试）
		while (archivesToDownload.length > 0) {
			// 创建多进度条容器
			const multibar = new cliProgress.MultiBar({
				clearOnComplete: false,
				hideCursor: true,
				format: ' {bar} | {percentage}% | {number} | {title} | {status}',
				barCompleteChar: '\u2588',
				barIncompleteChar: '\u2591',
			}, cliProgress.Presets.shades_grey);

			// 总进度条
			const totalBar = multibar.create(archivesToDownload.length, 0, {
				number: chalk.cyan('Overall'),
				title: '',
				status: 'Starting...'
			});

			// 并发控制
			const limit = pLimit(config.concurrency);
			let completed = 0;
			let successCount = 0;
			const currentFailed: FailedDownload[] = [];

			// 活动进度条池
			const activeVideoBars: Map<string, any> = new Map();

			// 创建所有下载任务
			const tasks = archivesToDownload.map((archive, idx) =>
				limit(async () => {
					const currentIndex = idx + 1;
					const totalCount = archivesToDownload.length;

					// 创建该视频的进度条
					const shortTitle = archive.title.length > 35
						? archive.title.substring(0, 35) + '...'
						: archive.title.padEnd(38);

					const videoBar = multibar.create(100, 0, {
						number: chalk.white(`[${String(currentIndex).padStart(3)}/${totalCount}]`),
						title: chalk.white(shortTitle),
						status: chalk.yellow('Waiting...')
					});

					activeVideoBars.set(archive.bvid, videoBar);

					// 下载
					const result = await downloadSingleArchive(
						archive,
						seasonFolder,
						videoBar,
						currentIndex,
						totalCount
					);

					// 更新计数
					completed++;
					if (result.success) {
						successCount++;
					} else {
						currentFailed.push({
							bvid: result.bvid,
							title: result.title,
							url: result.url,
							error: result.error
						});
					}

					// 更新总进度条
					totalBar.increment(1);
					totalBar.update({
						status: `${chalk.green(successCount)} ok / ${chalk.red(currentFailed.length)} failed`
					});

					// 短暂延迟让用户看到完成状态，然后移除进度条
					await new Promise(resolve => setTimeout(resolve, 800));
					videoBar.stop();
					multibar.remove(videoBar);
					activeVideoBars.delete(archive.bvid);

					return result;
				})
			);

			// 等待所有任务完成
			await Promise.all(tasks);

			// 等待一下确保所有进度条都已移除
			await new Promise(resolve => setTimeout(resolve, 500));

			// 停止总进度条
			totalBar.stop();
			multibar.stop();

			// 显示结果
			log(chalk.green(`\n✅ Download complete: ${successCount}/${archivesToDownload.length} successful`));

			// 如果有失败的
			if (currentFailed.length > 0) {
				failedDownloads = currentFailed;
				log(chalk.red(`\n❌ Failed (${failedDownloads.length}):`));
				failedDownloads.slice(0, 5).forEach(f => {
					log(chalk.gray(`  - ${f.title}`));
					log(chalk.gray(`    ${f.url}`));
					if (f.error) log(chalk.gray(`    Error: ${f.error}`));
				});
				if (failedDownloads.length > 5) {
					log(chalk.gray(`  ... and ${failedDownloads.length - 5} more`));
				}

				// 保存失败列表
				const failedJsonPath = path.join(seasonFolder, 'failed_downloads.json');
				fs.writeFileSync(failedJsonPath, JSON.stringify(failedDownloads, null, 2), 'utf-8');
				log(chalk.yellow(`\n📄 Failed list saved to: ${failedJsonPath}`));

				// 询问用户
				const choice = await askRetryChoice(rl, failedDownloads.length);

				if (choice === 'retry') {
					// 重试失败的
					archivesToDownload = archives.filter(a =>
						failedDownloads.some(f => f.bvid === a.bvid)
					);
					log(chalk.cyan(`\n🔄 Retrying ${archivesToDownload.length} failed downloads...\n`));
					continue;
				} else if (choice === 'view') {
					// 显示失败列表JSON
					log(chalk.cyan(`\n📋 Failed downloads JSON:\n`));
					log(JSON.stringify(failedDownloads, null, 2));
					log(chalk.yellow(`\nSaved to: ${failedJsonPath}\n`));
					break;
				} else {
					// 跳过
					break;
				}
			} else {
				// 全部成功
				break;
			}
		}

		return true;

	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error during season download:', errorMsg));
		return false;
	}
}

// ==================== 重试选择菜单 ====================
async function askRetryChoice(rl: readline.Interface, failedCount: number): Promise<'retry' | 'view' | 'skip'> {
	return new Promise((resolve) => {
		log(chalk.yellow(`\nWhat would you like to do with ${failedCount} failed downloads?`));
		log(chalk.white('  [1] Retry failed downloads'));
		log(chalk.white('  [2] View failed list (JSON)'));
		log(chalk.white('  [3] Skip and continue\n'));

		rl.pause();
		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
		}
		process.stdin.resume();

		const onKeyPress = (key: string) => {
			cleanup();

			if (key === '1') {
				resolve('retry');
			} else if (key === '2') {
				resolve('view');
			} else if (key === '3' || key === '\u001b') {
				resolve('skip');
			} else if (key === '\u0003') {
				process.exit(0);
			}
		};

		const cleanup = () => {
			process.stdin.removeListener('data', onKeyPress);
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
			process.stdin.pause();
			rl.resume();
		};

		process.stdin.on('data', onKeyPress);
	});
}

async function downloadSeason(url: string, rl: readline.Interface): Promise<boolean> {
	try {
		// 提取 season_id
		const seasonId = extractSeasonId(url);
		if (!seasonId) {
			log(chalk.red('Failed to extract season ID from URL'));
			return false;
		}

		// 获取整个合集的所有视频
		const result = await fetchAllSeasonArchives(seasonId);
		if (!result) {
			return false;
		}

		const { archives, meta } = result;

		// 显示菜单让用户选择
		while (true) {
			const choice = await showSeasonMenu(archives, meta, rl);

			if (choice === 'cancel') {
				log(chalk.yellow('\nCancelled.\n'));
				return false;
			}

			if (choice === 'preview') {
				await previewSeasonArchives(archives, meta, rl);
				// 预览完后继续显示菜单
				continue;
			}

			if (choice === 'download') {
				return await downloadSeasonArchives(archives, meta, rl);
			}
		}

	} catch (error: any) {
		const errorMsg = error instanceof Error ? error.message : String(error);
		log(chalk.red('Error during season download:', errorMsg));
		return false;
	}
}

// ==================== CLI ====================
function cli(rl: readline.Interface, callback: () => void): void {
	rl.question('Enter the video/collection URL (or q/quit to exit): ', (url) => {
		const trimmed = url.trim().toLowerCase();

		if (trimmed === 'q' || trimmed === 'quit') {
			log(chalk.green('Bye!'));
			rl.close();
			process.exit(0);
			return;
		}

		if (!url.includes('bilibili') && !url.includes('bv')) {
			log(chalk.yellow('Invalid URL, please try again.\n'));
			callback();
			return;
		}

		// 使用 IIFE 处理异步操作
		(async () => {
			try {
				let success = false;
				// 先问下载类型 (视频 / 仅音频)
				downloadMode = await askDownloadType(rl);
				log(downloadMode === 'video'
					? chalk.cyan('模式: 视频 (下载后自动 ffmpeg 合并为 mp4)\n')
					: chalk.cyan('模式: 仅音频\n'));

				// 判断是否为合集URL
				if (url.includes('seasons_archives_list') || url.includes('/lists/')) {
					// 合集URL (API格式或用户空间格式)
					success = await downloadSeason(url, rl);
				} else if (isSpaceUrl(url)) {
					// UP主主页投稿列表URL (https://space.bilibili.com/{mid}/upload/video)
					success = await downloadSpace(url, rl);
				} else if (url.includes('bilibili.com/video/') || url.includes('BV')) {
					// 单个视频URL
					success = await downloadSingleVideo(url);
				} else {
					log(chalk.yellow('Unknown URL format. Please provide a valid Bilibili video or season URL.\n'));
					callback();
					return;
				}

				if (success) {
					log(chalk.green('\n✅ Done! Enter another URL or q to quit.\n'));
				} else {
					log(chalk.yellow('\n⚠️ Download failed. Please try again.\n'));
				}
			} catch (error: any) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				log(chalk.red('Error during processing:', errorMsg));
				log(chalk.yellow('Please try again.\n'));
			}

			callback();
		})();
	});
}

// ==================== 主程序 ====================
const welcomeMessage = () => console.log(`
╔══════════════════════════════════════╗
║ ♡  Welcome to BiliAudio Downloader ♡ ║
║          ~ Let's start!              ║
╚══════════════════════════════════════╝
`);

function main() {
	welcomeMessage();

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout
	});

	// 加载或设置 cookies
	const hasCookie = loadCookies();

	if (!hasCookie) {
		// 使用回调而不是 Promise
		setupCookie(rl, () => {
			// Cookie 设置完成后，开始主循环
			runMainLoop(rl);
		});
	} else {
		// 直接开始主循环
		runMainLoop(rl);
	}
}

// 主循环函数
function runMainLoop(rl: readline.Interface): void {
	cli(rl, () => {
		// CLI 完成后，递归调用继续循环
		runMainLoop(rl);
	});
}

main();