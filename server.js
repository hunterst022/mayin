'use strict';
/**
 * TikTok Live Printer — server (bản viết lại, chạy được trên Render.com)
 *
 * Phục vụ giao diện trong /public và cung cấp:
 *   - Socket.IO  : bridge_status, connection_status, update_stats, print_ticket,
 *                  board_state_update, clock_settings, play_music
 *                  (nhận: test_event, update_board_state, update_clock_settings, set_music)
 *   - HTTP       : POST /api/start, POST /api/stop, GET /api/status,
 *                  GET /api/tts, GET /healthz
 *   - WebSocket  : /unity  (tùy chọn, đẩy sự kiện cho Unity)
 *
 * Biến môi trường (đều tùy chọn):
 *   PORT              cổng (Render tự cấp)
 *   ADMIN_PASSWORD    đặt mật khẩu cho bảng điều khiển (khuyến nghị khi public)
 *   ADMIN_USER        tên đăng nhập, mặc định "admin"
 *   SIGN_API_KEY      khóa Euler Stream (tăng độ ổn định khi chạy trên IP datacenter)
 *   TIER2_MIN         kim cương/1 quà để tính VIP        (mặc định 5)
 *   TIER3_MIN         kim cương/1 quà để tính Super VIP  (mặc định 30)
 *   DATA_DIR          nơi lưu cài đặt (mặc định ./data)
 *   CORS_ORIGIN       nếu cần cho phép domain khác nhúng overlay
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server: IOServer } = require('socket.io');
const { WebSocketServer } = require('ws');

// ───────────────────────── Cấu hình ─────────────────────────
function loadConfig(env = process.env) {
    const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
    return {
        port: num(env.PORT, 3000),
        host: env.HOST || '0.0.0.0',
        adminUser: env.ADMIN_USER || 'admin',
        adminPassword: env.ADMIN_PASSWORD || '',
        signApiKey: env.SIGN_API_KEY || env.EULER_API_KEY || '',
        tier2Min: num(env.TIER2_MIN, 5),
        tier3Min: num(env.TIER3_MIN, 30),
        dataDir: env.DATA_DIR || path.join(__dirname, 'data'),
        publicDir: path.join(__dirname, 'public'),
        corsOrigin: env.CORS_ORIGIN || '',
        connectTimeoutMs: num(env.CONNECT_TIMEOUT_MS, 30000),
        maxReconnect: num(env.MAX_RECONNECT, 8),
        reconnectBaseMs: num(env.RECONNECT_BASE_MS, 2000),
        streakFlushMs: num(env.STREAK_FLUSH_MS, 6000),
        ttsCacheEntries: num(env.TTS_CACHE_ENTRIES, 300),
        ttsRatePerMin: num(env.TTS_RATE_PER_MIN, 90),
    };
}

// ───────────────────────── Tiện ích ─────────────────────────
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const warn = (...a) => console.warn(new Date().toISOString().slice(11, 19), '[WARN]', ...a);

// Giao diện chèn dữ liệu bằng innerHTML → phải escape ở server (chat/tên người dùng là dữ liệu không tin cậy)
const HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => HTML_MAP[c]);
const cleanText = (s, max) =>
    String(s == null ? '' : s)
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
const escXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeAvatar(url) {
    // Chỉ cho https, không có ký tự phá thuộc tính HTML
    if (typeof url !== 'string') return '';
    if (!/^https:\/\/[^\s"'<>`]+$/i.test(url) || url.length > 600) return '';
    return url;
}

function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

// Tên quà tiếng Anh → tiếng Việt (khớp với bảng vinh danh). Quà khác giữ nguyên tên gốc.
const GIFT_NAME_VI = {
    'rose': 'Hoa hồng',
    'finger heart': 'Bắn tim',
    'doughnut': 'Bánh vòng',
    'donut': 'Bánh vòng',
};
const viGiftName = (n) => GIFT_NAME_VI[String(n || '').trim().toLowerCase()] || String(n || '').trim();

// ───────────────────────── Trạng thái mặc định ─────────────────────────
const DEFAULT_BOARD = {
    show: true,
    items: [
        { id: 0, show: true, name: 'Hoa hồng', desc: 'Cảm ơn mọi người' },
        { id: 1, show: true, name: 'Bắn tim', desc: 'Cảm ơn mọi người' },
        { id: 2, show: true, name: 'Bánh vòng', desc: 'Cảm ơn mọi người' },
        { id: 3, show: true, name: 'Ánh sao tỏa sáng', desc: 'Cảm ơn mọi người' },
        { id: 4, show: true, name: 'Bó hoa', desc: 'Cảm ơn mọi người' },
        { id: 5, show: true, name: 'Heo may mắn', desc: 'Cảm ơn mọi người' },
    ],
};
const DEFAULT_CLOCK = { show: true, timeZone: 'local', hour12: false };

function validTimeZone(tz) {
    if (tz === 'local') return true;
    if (typeof tz !== 'string' || tz.length > 64) return false;
    try { new Intl.DateTimeFormat('vi-VN', { timeZone: tz }); return true; } catch { return false; }
}

// ───────────────────────── TTS (Edge) ─────────────────────────
const VOICES = {
    vi: 'vi-VN-HoaiMyNeural',
    'vi-male': 'vi-VN-NamMinhNeural',
    en: 'en-US-AriaNeural',
    'en-male': 'en-US-GuyNeural',
    th: 'th-TH-PremwadeeNeural',
    id: 'id-ID-GadisNeural',
    ja: 'ja-JP-NanamiNeural',
    ko: 'ko-KR-SunHiNeural',
    zh: 'zh-CN-XiaoxiaoNeural',
};
function resolveVoice(v) {
    v = String(v || 'vi');
    if (VOICES[v]) return VOICES[v];
    if (/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]{3,30}Neural$/.test(v)) return v;
    return VOICES.vi;
}

async function edgeSynthesize(text, voiceName) {
    const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
    const tts = new MsEdgeTTS({ connectionTimeoutMs: 8000, synthesisTimeoutMs: 12000 });
    try {
        await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
        const { audioStream } = tts.toStream(escXml(text));
        const chunks = [];
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('TTS timeout')), 14000);
            audioStream.on('data', (c) => chunks.push(c));
            audioStream.on('end', () => { clearTimeout(timer); resolve(); });
            audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
            audioStream.on('close', () => { clearTimeout(timer); resolve(); });
        });
        const buf = Buffer.concat(chunks);
        if (!buf.length) throw new Error('TTS trả về dữ liệu rỗng');
        return buf;
    } finally {
        try { tts.close(); } catch { /* bỏ qua */ }
    }
}

class TtsService {
    constructor({ synth, maxEntries, concurrency = 3 }) {
        this.synth = synth;
        this.maxEntries = maxEntries;
        this.concurrency = concurrency;
        this.cache = new Map();      // key → Buffer (LRU theo thứ tự chèn)
        this.inflight = new Map();   // key → Promise<Buffer>  (chống gọi trùng)
        this.active = 0;
        this.waiters = [];
    }
    async _acquire() {
        if (this.active < this.concurrency) { this.active++; return; }
        await new Promise((r) => this.waiters.push(r));
        this.active++;
    }
    _release() {
        this.active--;
        const next = this.waiters.shift();
        if (next) next();
    }
    async get(text, voice) {
        const voiceName = resolveVoice(voice);
        const key = voiceName + '|' + text;
        const hit = this.cache.get(key);
        if (hit) { this.cache.delete(key); this.cache.set(key, hit); return hit; }
        if (this.inflight.has(key)) return this.inflight.get(key);

        const p = (async () => {
            await this._acquire();
            try {
                let lastErr;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const buf = await this.synth(text, voiceName);
                        this.cache.set(key, buf);
                        while (this.cache.size > this.maxEntries) this.cache.delete(this.cache.keys().next().value);
                        return buf;
                    } catch (e) { lastErr = e; await sleep(300); }
                }
                throw lastErr;
            } finally { this._release(); }
        })();
        this.inflight.set(key, p);
        try { return await p; } finally { this.inflight.delete(key); }
    }
}

// ───────────────────────── Hàng đợi vé (chat/join) ─────────────────────────
// Chat/join rất dày → xả tối đa 1 vé / interval, giữ tối đa maxPending vé (bỏ vé cũ nhất).
class TicketQueue {
    constructor(emit, { intervalMs, maxPending }) {
        this.emit = emit; this.intervalMs = intervalMs; this.maxPending = maxPending;
        this.q = []; this.timer = null; this.last = 0;
    }
    push(ticket) {
        this.q.push(ticket);
        while (this.q.length > this.maxPending) this.q.shift();
        this._kick();
    }
    _kick() {
        if (this.timer || !this.q.length) return;
        const wait = Math.max(0, this.last + this.intervalMs - Date.now());
        this.timer = setTimeout(() => {
            this.timer = null;
            const t = this.q.shift();
            if (t) { this.last = Date.now(); this.emit(t); }
            this._kick();
        }, wait);
    }
    clear() { this.q = []; if (this.timer) { clearTimeout(this.timer); this.timer = null; } }
}

// ───────────────────────── Tải thư viện TikTok (ESM) ─────────────────────────
async function loadTikTokLib() {
    return await import('tiktok-live-connector');
}

function translateError(e, lib) {
    const msg = (e && e.message) || String(e);
    const is = (C) => C && e instanceof C;
    if (is(lib.UserOfflineError)) return 'Tài khoản này hiện không phát LIVE (hoặc chưa bật live). Hãy bật live rồi thử lại.';
    if (is(lib.InvalidUniqueIdError)) return 'Tên người dùng TikTok không hợp lệ.';
    if (is(lib.AlreadyConnectingError)) return 'Đang kết nối, vui lòng đợi.';
    if (is(lib.ConnectTimeoutError) || /timeout|timed out/i.test(msg)) return 'Hết thời gian chờ khi kết nối TikTok. Thử lại sau ít phút.';
    if (/room ?id/i.test(msg))
        return 'Không lấy được phòng LIVE của tài khoản này. Có thể: sai tên, chưa bật live, hoặc TikTok đang chặn IP máy chủ — hãy kiểm tra lại tên/đang live, và thêm SIGN_API_KEY nếu lỗi lặp lại.';
    if (is(lib.SignatureRateLimitError) || is(lib.SignAPIError) || /rate.?limit|429|sign/i.test(msg))
        return 'Máy chủ ký của TikTok đang giới hạn lượt gọi. Hãy thêm biến môi trường SIGN_API_KEY (Euler Stream) hoặc thử lại sau.';
    return msg.slice(0, 300);
}

// ───────────────────────── Tạo ứng dụng ─────────────────────────
function createApp(userOptions = {}) {
    const cfg = { ...loadConfig(), ...(userOptions.config || {}) };
    const deps = {
        loadTikTokLib: userOptions.loadTikTokLib || loadTikTokLib,
        ttsSynth: userOptions.ttsSynth || edgeSynthesize,
    };

    // ── Lưu cài đặt (best effort — đĩa của Render là tạm thời) ──
    const settingsFile = path.join(cfg.dataDir, 'settings.json');
    function loadSettings() {
        try {
            const j = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
            return { board: sanitizeBoard(j.board, DEFAULT_BOARD), clock: sanitizeClock(j.clock, DEFAULT_CLOCK) };
        } catch { return { board: JSON.parse(JSON.stringify(DEFAULT_BOARD)), clock: { ...DEFAULT_CLOCK } }; }
    }
    let saveTimer = null;
    function saveSettings() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            try {
                fs.mkdirSync(cfg.dataDir, { recursive: true });
                fs.writeFileSync(settingsFile, JSON.stringify({ board: state.board, clock: state.clock }, null, 2));
            } catch (e) { warn('Không lưu được cài đặt:', e.message); }
        }, 500);
    }

    function sanitizeBoard(input, base) {
        const out = { show: base.show, items: base.items.map((i) => ({ ...i })) };
        if (!input || typeof input !== 'object') return out;
        if (typeof input.show === 'boolean') out.show = input.show;
        if (Array.isArray(input.items)) {
            input.items.slice(0, out.items.length).forEach((it, idx) => {
                if (!it || typeof it !== 'object') return;
                const i = Number.isInteger(it.id) && it.id >= 0 && it.id < out.items.length ? it.id : idx;
                out.items[i] = {
                    id: i,
                    show: typeof it.show === 'boolean' ? it.show : out.items[i].show,
                    name: typeof it.name === 'string' ? cleanText(it.name, 60) : out.items[i].name,
                    desc: typeof it.desc === 'string' ? cleanText(it.desc, 80) : out.items[i].desc,
                };
            });
        }
        return out;
    }
    function sanitizeClock(input, base) {
        const out = { ...base };
        if (!input || typeof input !== 'object') return out;
        if (typeof input.show === 'boolean') out.show = input.show;
        if (typeof input.hour12 === 'boolean') out.hour12 = input.hour12;
        if (validTimeZone(input.timeZone)) out.timeZone = input.timeZone;
        return out;
    }

    const saved = loadSettings();
    const state = {
        board: saved.board,
        clock: saved.clock,
        diamonds: 0,
        tiktok: { conn: null, uniqueId: '', connected: false, connecting: false, roomId: '', manualStop: false, retry: 0, retryTimer: null, gen: 0 },
        testModeAnnounced: false,
    };

    // ── Express / HTTP / Socket.IO ──
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    const server = http.createServer(app);
    const io = new IOServer(server, {
        maxHttpBufferSize: 25e6, // cho phép gửi MP3 ≤ 15MB (base64 ≈ 20MB)
        pingInterval: 20000,
        pingTimeout: 30000,
        cors: cfg.corsOrigin ? { origin: cfg.corsOrigin.split(',').map((s) => s.trim()) } : undefined,
    });

    // ── Xác thực quản trị (chỉ bật khi có ADMIN_PASSWORD) ──
    const authEnabled = !!cfg.adminPassword;
    function validAuthHeader(h) {
        if (!authEnabled) return true;
        if (typeof h !== 'string' || !h.startsWith('Basic ')) return false;
        const dec = Buffer.from(h.slice(6), 'base64').toString('utf8');
        const i = dec.indexOf(':');
        if (i < 0) return false;
        return safeEqual(dec.slice(0, i), cfg.adminUser) && safeEqual(dec.slice(i + 1), cfg.adminPassword);
    }
    const PROTECTED = new Set(['/', '/index.html', '/api/start', '/api/stop', '/api/status']);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        if (authEnabled && PROTECTED.has(req.path) && !validAuthHeader(req.headers.authorization)) {
            res.setHeader('WWW-Authenticate', 'Basic realm="TikTok Printer", charset="UTF-8"');
            return res.status(401).type('text/plain; charset=utf-8').send('Cần đăng nhập để vào bảng điều khiển.');
        }
        next();
    });
    app.use(express.json({ limit: '10kb' }));

    // ── Phát sự kiện ──
    const unityClients = new Set();
    let statusTimer = null;
    const bridgeStatus = () => ({
        isConnected: state.tiktok.connected,
        uniqueId: state.tiktok.uniqueId,
        roomId: state.tiktok.roomId,
        unityWs: unityClients.size,
        unityTcp: false, // Render chỉ mở 1 cổng HTTP — không có TCP riêng
        diamonds: state.diamonds,
    });
    function emitBridgeStatus(immediate = false) {
        const fire = () => { statusTimer = null; io.emit('bridge_status', bridgeStatus()); };
        if (immediate) { clearTimeout(statusTimer); return fire(); }
        if (!statusTimer) statusTimer = setTimeout(fire, 200);
    }
    function emitConnection(status, extra = {}) {
        io.emit('connection_status', { status, uniqueId: state.tiktok.uniqueId, ...extra });
        emitBridgeStatus();
    }
    function broadcastTicket(ticket) {
        io.emit('print_ticket', ticket);
        if (unityClients.size) {
            const msg = JSON.stringify({ event: 'print_ticket', data: ticket });
            for (const ws of unityClients) { try { if (ws.readyState === 1) ws.send(msg); } catch { /* bỏ qua */ } }
        }
    }
    const lowPriority = new TicketQueue(broadcastTicket, { intervalMs: 700, maxPending: 6 });

    // ── Dựng vé ──
    const tierOf = (unit) => (unit >= cfg.tier3Min ? 3 : unit >= cfg.tier2Min ? 2 : 1);

    function buildGiftTicket({ username, userId, avatar, giftName, giftId, unit, repeatCount }) {
        const tier = tierOf(unit);
        const rawName = cleanText(username, 40) || 'Ẩn danh';
        const rawGift = cleanText(viGiftName(giftName), 60) || 'Quà';
        const total = unit * repeatCount;
        const ttsText = tier === 3
            ? pick([
                `Wow! Cảm ơn ${rawName} đã tặng ${repeatCount} ${rawGift}, bạn là siêu VIP của phiên live này!`,
                `Trời ơi, ${rawName} vừa tặng ${repeatCount} ${rawGift}! Cảm ơn bạn rất nhiều!`,
                `Cảm ơn ${rawName} nhiều lắm, ${repeatCount} ${rawGift} thật sự quá đỉnh!`,
            ])
            : tier === 2
                ? pick([
                    `Cảm ơn ${rawName} đã tặng ${repeatCount} ${rawGift}!`,
                    `${rawName} tặng ${repeatCount} ${rawGift}, cảm ơn bạn nhé!`,
                    `Ôi, cảm ơn ${rawName} vì ${repeatCount} ${rawGift} nha!`,
                ])
                : pick([
                    `Cảm ơn ${rawName} đã tặng ${rawGift}!`,
                    `${rawName} ơi, cảm ơn bạn nhiều nha!`,
                    `Cảm ơn ${rawName}, yêu bạn nhiều!`,
                ]);
        return {
            type: 'gift', tier,
            username: escHtml(rawName), userId: String(userId || ''),
            profilePictureUrl: safeAvatar(avatar),
            giftName: escHtml(rawGift), giftId: String(giftId || ''),
            repeatCount, diamondCount: total,
            ttsText, ttsVoice: 'vi', timestamp: Date.now(),
        };
    }
    function buildJoinTicket({ username, userId, avatar }) {
        const rawName = cleanText(username, 40) || 'Ẩn danh';
        return {
            type: 'join', tier: 0,
            username: escHtml(rawName), userId: String(userId || ''),
            profilePictureUrl: safeAvatar(avatar),
            ttsText: pick([
                `Chào mừng ${rawName} đến với phiên live!`,
                `Xin chào ${rawName}, rất vui được gặp bạn!`,
                `${rawName} vừa vào phòng, chào bạn nhé!`,
                `Chào ${rawName}, chúc bạn xem live vui vẻ!`,
            ]),
            ttsVoice: 'vi', timestamp: Date.now(),
        };
    }
    const GREETING_RE = /(^|[\s,.!?])(xin chào|chào|hello|hi|hey|alo|helo)($|[\s,.!?])/i;
    function buildChatTicket({ username, userId, avatar, comment }) {
        const rawName = cleanText(username, 40) || 'Ẩn danh';
        const rawComment = cleanText(comment, 200);
        const t = {
            type: 'chat', tier: 0,
            username: escHtml(rawName), userId: String(userId || ''),
            profilePictureUrl: safeAvatar(avatar),
            comment: escHtml(rawComment), timestamp: Date.now(),
        };
        if (GREETING_RE.test(rawComment) && rawComment.length <= 40) {
            t.ttsText = pick([`Chào ${rawName} nhé!`, `Xin chào ${rawName}!`, `${rawName} ơi, chào bạn!`]);
            t.ttsVoice = 'vi';
        }
        return t;
    }

    // ── Xử lý sự kiện TikTok ──
    const seenMsg = new Map();           // msgId → thời điểm (chống trùng)
    const seenJoin = new Map();          // userId → thời điểm (mỗi người chỉ chào 1 lần / 10 phút)
    const streaks = new Map();           // key → { data, timer }
    const gc = setInterval(() => {
        const now = Date.now();
        for (const [k, t] of seenMsg) if (now - t > 60000) seenMsg.delete(k);
        for (const [k, t] of seenJoin) if (now - t > 600000) seenJoin.delete(k);
    }, 30000);
    gc.unref();

    const isDup = (d) => {
        const id = d && d.common && d.common.msgId;
        if (!id) return false;
        if (seenMsg.has(id)) return true;
        seenMsg.set(id, Date.now());
        return false;
    };
    const userOf = (d) => {
        const u = (d && d.user) || {};
        const avatar = (u.avatarThumb && u.avatarThumb.urlList && u.avatarThumb.urlList[0])
            || (u.avatarMedium && u.avatarMedium.urlList && u.avatarMedium.urlList[0]) || '';
        return { username: u.nickname || u.displayId || 'Ẩn danh', userId: u.id || d.userId || '', avatar };
    };

    function flushGift(key) {
        const s = streaks.get(key);
        if (!s) return;
        clearTimeout(s.timer);
        streaks.delete(key);
        const { info, repeatCount } = s;
        const ticket = buildGiftTicket({ ...info, repeatCount });
        state.diamonds += ticket.diamondCount;
        broadcastTicket(ticket);
        io.emit('update_stats', { total: state.diamonds });
        emitBridgeStatus();
    }

    function handleGift(d) {
        try {
            if (isDup(d)) return;
            const g = d.gift || {};
            const unit = Number(g.diamondCount ?? d.diamondCount ?? 0) || 0;
            const repeatCount = Math.max(1, Number(d.repeatCount) || 1);
            const u = userOf(d);
            const info = {
                ...u,
                giftName: g.name || d.giftName || (d.extendedGiftInfo && d.extendedGiftInfo.name) || '',
                giftId: d.giftId || g.id || '',
                unit,
            };
            const isStreakGift = g.type === 1 || d.giftType === 1;
            if (!isStreakGift) {
                // Quà thường: in ngay
                const ticket = buildGiftTicket({ ...info, repeatCount });
                state.diamonds += ticket.diamondCount;
                broadcastTicket(ticket);
                io.emit('update_stats', { total: state.diamonds });
                emitBridgeStatus();
                return;
            }
            // Quà combo: gom tới khi kết thúc chuỗi (repeatEnd) hoặc im 6s
            const key = `${u.userId}|${info.giftId}|${d.groupId || ''}`;
            const prev = streaks.get(key);
            if (prev) clearTimeout(prev.timer);
            const entry = { info, repeatCount: Math.max(repeatCount, prev ? prev.repeatCount : 0), timer: null };
            streaks.set(key, entry);
            if (d.repeatEnd) return flushGift(key);
            entry.timer = setTimeout(() => flushGift(key), cfg.streakFlushMs);
        } catch (e) { warn('Lỗi xử lý quà:', e.message); }
    }
    function handleChat(d) {
        try {
            if (isDup(d)) return;
            const text = cleanText(d.content || d.comment, 200);
            if (!text) return;
            lowPriority.push(buildChatTicket({ ...userOf(d), comment: text }));
        } catch (e) { warn('Lỗi xử lý chat:', e.message); }
    }
    function handleMember(d) {
        try {
            if (d.action !== undefined && d.action !== 1 && d.action !== 0) return; // chỉ "vào phòng"
            const u = userOf(d);
            const key = u.userId || u.username;
            if (!key) return;
            const last = seenJoin.get(key);
            if (last && Date.now() - last < 600000) return;
            seenJoin.set(key, Date.now());
            lowPriority.push(buildJoinTicket(u));
        } catch (e) { warn('Lỗi xử lý join:', e.message); }
    }

    // ── Kết nối TikTok ──
    const T = state.tiktok;
    function clearRetry() { if (T.retryTimer) { clearTimeout(T.retryTimer); T.retryTimer = null; } }
    function normalizeId(raw) {
        let s = String(raw || '').trim();
        const m = s.match(/tiktok\.com\/@([^/?#\s]+)/i);
        if (m) s = m[1];
        return s.replace(/^@/, '');
    }

    async function teardown(conn) {
        if (!conn) return;
        try { conn.removeAllListeners && conn.removeAllListeners(); } catch { /* bỏ qua */ }
        try { await Promise.race([conn.disconnect(), sleep(3000)]); } catch { /* bỏ qua */ }
    }

    async function openConnection(lib, uniqueId, gen) {
        const opts = {
            processInitialData: false,      // không in lại tin nhắn/quà cũ khi vừa vào phòng
            fetchRoomInfoOnConnect: true,   // báo lỗi rõ ràng nếu chủ phòng chưa live
            enableExtendedGiftInfo: false,
        };
        if (cfg.signApiKey) opts.signApiKey = cfg.signApiKey;
        const conn = new lib.TikTokLiveConnection(uniqueId, opts);
        const { WebcastEvent: WE, ControlEvent: CE } = lib;

        conn.on(WE.GIFT, handleGift);
        conn.on(WE.CHAT, handleChat);
        conn.on(WE.MEMBER, handleMember);
        // Bắt buộc có listener 'error' — nếu không EventEmitter sẽ làm sập tiến trình
        conn.on(CE.ERROR, (e) => warn('TikTok error:', (e && (e.info || e.message || e.exception && e.exception.message)) || e));
        conn.on(WE.STREAM_END, () => {
            if (gen !== T.gen) return;
            log('Live đã kết thúc @' + uniqueId);
            T.manualStop = true; // không tự kết nối lại
            clearRetry();
            T.connected = false; T.connecting = false;
            io.emit('connection_status', { status: 'disconnected', uniqueId });
            io.emit('connection_status', { status: 'error', uniqueId, error: 'Phiên LIVE đã kết thúc.' });
            emitBridgeStatus();
            teardown(conn);
        });
        conn.on(CE.DISCONNECTED, () => {
            if (gen !== T.gen) return;        // kết nối cũ, bỏ qua
            if (T.manualStop) return;
            T.connected = false;
            io.emit('connection_status', { status: 'disconnected', uniqueId });
            emitBridgeStatus();
            scheduleReconnect(lib, uniqueId, gen);
        });

        const connectP = conn.connect();
        connectP.catch(() => { /* lỗi được xử lý bởi race bên dưới */ });
        let timer;
        try {
            await Promise.race([
                connectP,
                new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Connect timeout')), cfg.connectTimeoutMs); }),
            ]);
        } catch (e) { await teardown(conn); throw e; } finally { clearTimeout(timer); }
        return conn;
    }

    function scheduleReconnect(lib, uniqueId, gen) {
        clearRetry();
        if (T.manualStop || gen !== T.gen) return;
        if (T.retry >= cfg.maxReconnect) {
            io.emit('connection_status', { status: 'error', uniqueId, error: 'Mất kết nối TikTok và không thể kết nối lại tự động.' });
            return;
        }
        const delay = Math.min(30000, cfg.reconnectBaseMs * 2 ** T.retry);
        T.retry++;
        log(`Kết nối lại @${uniqueId} sau ${delay / 1000}s (lần ${T.retry}/${cfg.maxReconnect})`);
        T.retryTimer = setTimeout(async () => {
            if (T.manualStop || gen !== T.gen) return;
            io.emit('connection_status', { status: 'connecting', uniqueId });
            try {
                const old = T.conn;
                const conn = await openConnection(lib, uniqueId, gen);
                if (T.manualStop || gen !== T.gen) { await teardown(conn); return; }
                await teardown(old);
                T.conn = conn; T.connected = true; T.retry = 0;
                T.roomId = String(conn.roomId || '');
                io.emit('connection_status', { status: 'connected', uniqueId, roomId: T.roomId });
                emitBridgeStatus();
            } catch (e) {
                warn('Kết nối lại thất bại:', e.message);
                scheduleReconnect(lib, uniqueId, gen);
            }
        }, delay);
    }

    async function startTikTok(rawId) {
        const uniqueId = normalizeId(rawId);
        if (!/^[A-Za-z0-9._]{2,40}$/.test(uniqueId)) return { success: false, error: 'Tên người dùng TikTok không hợp lệ.' };
        if (T.connecting) return { success: false, error: 'Đang kết nối, vui lòng đợi.' };
        if (T.connected && T.uniqueId.toLowerCase() === uniqueId.toLowerCase()) {
            io.emit('connection_status', { status: 'already_connected', uniqueId: T.uniqueId });
            return { success: true, roomId: T.roomId, already: true };
        }
        if (T.conn || T.connected) await stopTikTok(true);

        let lib;
        try { lib = await deps.loadTikTokLib(); } catch (e) {
            return { success: false, error: 'Không tải được thư viện TikTok: ' + e.message };
        }

        T.gen++;
        const gen = T.gen;
        T.connecting = true; T.manualStop = false; T.retry = 0; T.uniqueId = uniqueId;
        clearRetry();
        io.emit('connection_status', { status: 'connecting', uniqueId });
        emitBridgeStatus();
        try {
            const conn = await openConnection(lib, uniqueId, gen);
            if (gen !== T.gen || T.manualStop) { await teardown(conn); return { success: false, error: 'Đã hủy kết nối.' }; }
            T.conn = conn; T.connected = true; T.connecting = false;
            T.roomId = String(conn.roomId || '');
            log(`Đã kết nối @${uniqueId} (phòng ${T.roomId})`);
            io.emit('connection_status', { status: 'connected', uniqueId, roomId: T.roomId });
            emitBridgeStatus(true);
            return { success: true, roomId: T.roomId };
        } catch (e) {
            T.connecting = false; T.connected = false; T.conn = null; T.roomId = '';
            const error = translateError(e, lib);
            warn(`Kết nối @${uniqueId} thất bại:`, e && e.message);
            io.emit('connection_status', { status: 'error', uniqueId, error });
            emitBridgeStatus();
            return { success: false, error };
        }
    }

    async function stopTikTok(silent = false) {
        T.gen++;                      // vô hiệu hóa mọi callback của kết nối cũ
        T.manualStop = true;
        clearRetry();
        const conn = T.conn;
        T.conn = null; T.connected = false; T.connecting = false; T.roomId = '';
        lowPriority.clear();
        for (const [k, s] of streaks) { clearTimeout(s.timer); streaks.delete(k); }
        await teardown(conn);
        if (!silent) {
            io.emit('connection_status', { status: 'disconnected', uniqueId: T.uniqueId });
            emitBridgeStatus(true);
        }
    }

    // ── Routes ──
    app.get('/healthz', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()), connected: T.connected, uniqueId: T.uniqueId }));
    app.get('/api/status', (req, res) => res.json(bridgeStatus()));
    app.post('/api/start', async (req, res) => {
        try {
            const out = await startTikTok(req.body && req.body.uniqueId);
            res.status(out.success ? 200 : 400).json(out);
        } catch (e) {
            warn('/api/start lỗi:', e);
            res.status(500).json({ success: false, error: 'Lỗi máy chủ: ' + e.message });
        }
    });
    app.post('/api/stop', async (req, res) => {
        try { await stopTikTok(); res.json({ success: true }); }
        catch (e) { res.status(500).json({ success: false, error: e.message }); }
    });

    // TTS (công khai vì overlay trong OBS không có đăng nhập) — giới hạn theo IP
    const tts = new TtsService({ synth: deps.ttsSynth, maxEntries: cfg.ttsCacheEntries });
    const ttsHits = new Map();
    const ttsGc = setInterval(() => ttsHits.clear(), 60000);
    ttsGc.unref();
    app.get('/api/tts', async (req, res) => {
        const text = cleanText(req.query.text, 200);
        if (!text) return res.status(400).json({ error: 'Thiếu text' });
        const n = (ttsHits.get(req.ip) || 0) + 1;
        ttsHits.set(req.ip, n);
        if (n > cfg.ttsRatePerMin) return res.status(429).json({ error: 'Quá nhiều yêu cầu TTS' });
        try {
            const buf = await tts.get(text, req.query.voice);
            res.set({ 'Content-Type': 'audio/mpeg', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=86400' });
            res.end(buf);
        } catch (e) {
            warn('TTS lỗi:', e && e.message);
            res.status(502).json({ error: 'Không tạo được giọng đọc' });
        }
    });

    app.use(express.static(cfg.publicDir, {
        index: 'index.html',
        setHeaders(res, file) {
            if (/\.html$/i.test(file)) res.setHeader('Cache-Control', 'no-cache');
            else if (/\.(png|jpe?g|svg|mp4|mp3|webp)$/i.test(file)) res.setHeader('Cache-Control', 'public, max-age=86400');
        },
    }));
    app.use((req, res) => res.status(404).type('text/plain; charset=utf-8').send('Không tìm thấy'));
    // eslint-disable-next-line no-unused-vars
    app.use((err, req, res, next) => {
        if (err && err.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: 'JSON không hợp lệ' });
        warn('Express lỗi:', err && err.message);
        res.status(500).json({ success: false, error: 'Lỗi máy chủ' });
    });

    // ── Socket.IO ──
    io.use((socket, next) => {
        // Chỉ socket mang thông tin đăng nhập (trang điều khiển) mới được điều khiển
        socket.data.isAdmin = validAuthHeader(socket.handshake.headers.authorization);
        next();
    });

    const TEST_GIFTS = {
        tier1: [{ name: 'Hoa hồng', unit: 1 }],
        tier2: [{ name: 'Bắn tim', unit: 5 }],
        tier3: [{ name: 'Bánh vòng', unit: 30 }, { name: 'Bó hoa', unit: 100 }, { name: 'Heo may mắn', unit: 199 }],
    };
    const TEST_NAMES = ['Minh Anh', 'Thu Hà', 'Quốc Bảo', 'Ngọc Mai', 'Hoàng Nam', 'Lan Phương', 'Tuấn Kiệt'];
    function runTestEvent(type) {
        if (!T.connected && !state.testModeAnnounced) {
            state.testModeAnnounced = true;
            io.emit('connection_status', { status: 'connected', uniqueId: 'Test_Mode' });
        }
        const username = pick(TEST_NAMES);
        const base = { username, userId: 'test-' + username, avatar: '' };
        if (TEST_GIFTS[type]) {
            const g = pick(TEST_GIFTS[type]);
            broadcastTicket(buildGiftTicket({ ...base, giftName: g.name, giftId: 'test', unit: g.unit, repeatCount: 1 + Math.floor(Math.random() * 5) }));
        } else if (type === 'chat') {
            broadcastTicket(buildChatTicket({ ...base, comment: pick(['Xin chào mọi người!', 'Live vui quá 😍', 'Chúc shop buôn may bán đắt', 'Hello cả nhà']) }));
        } else if (type === 'join') {
            broadcastTicket(buildJoinTicket(base));
        }
    }

    io.on('connection', (socket) => {
        socket.emit('bridge_status', bridgeStatus());
        socket.emit('board_state_update', state.board);
        socket.emit('clock_settings', state.clock);
        socket.emit('update_stats', { total: state.diamonds });
        if (T.connected) socket.emit('connection_status', { status: 'connected', uniqueId: T.uniqueId, roomId: T.roomId });

        // Lệnh điều khiển: bọc try/catch để dữ liệu xấu không làm sập server
        const admin = (name, fn) => socket.on(name, (...args) => {
            if (!socket.data.isAdmin) return;
            try { fn(...args); } catch (e) { warn(`Lỗi sự kiện ${name}:`, e.message); }
        });

        admin('test_event', (type) => { if (typeof type === 'string' && type.length < 16) runTestEvent(type); });
        admin('update_board_state', (payload) => {
            state.board = sanitizeBoard(payload, state.board);
            io.emit('board_state_update', state.board);
            saveSettings();
        });
        admin('update_clock_settings', (payload) => {
            state.clock = sanitizeClock(payload, state.clock);
            io.emit('clock_settings', state.clock);
            saveSettings();
        });
        admin('set_music', (p) => {
            if (!p || typeof p !== 'object') return;
            if (p.type === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(String(p.videoId))) {
                io.emit('play_music', { type: 'youtube', videoId: p.videoId });
            } else if (p.type === 'mp3' && typeof p.dataUrl === 'string' && /^data:audio\/[\w.+-]+;base64,/.test(p.dataUrl.slice(0, 80)) && p.dataUrl.length < 22e6) {
                io.emit('play_music', { type: 'mp3', dataUrl: p.dataUrl });
            } else if (p.type === 'stop') {
                io.emit('play_music', { type: 'stop' });
            }
        });
    });

    // ── Unity WebSocket (/unity) ──
    const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    server.on('upgrade', (req, socket, head) => {
        let pathname = '';
        try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* bỏ qua */ }
        if (pathname !== '/unity') return; // để Socket.IO tự xử lý đường dẫn của nó
        if (authEnabled && !validAuthHeader(req.headers.authorization)) {
            socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="TikTok Printer"\r\nConnection: close\r\n\r\n');
            return socket.destroy();
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
            unityClients.add(ws);
            emitBridgeStatus();
            ws.on('close', () => { unityClients.delete(ws); emitBridgeStatus(); });
            ws.on('error', () => { unityClients.delete(ws); });
            ws.on('message', () => { /* Unity không cần gửi gì lên */ });
            try { ws.send(JSON.stringify({ event: 'hello', data: bridgeStatus() })); } catch { /* bỏ qua */ }
        });
    });

    // ── Khởi động / dừng ──
    function start(port = cfg.port, host = cfg.host) {
        return new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, host, () => {
                server.off('error', reject);
                log(`Máy chủ chạy tại http://${host}:${server.address().port}`
                    + (authEnabled ? ' (đã bật mật khẩu bảng điều khiển)' : ' (CHƯA đặt ADMIN_PASSWORD)'));
                resolve(server.address().port);
            });
        });
    }
    async function stop() {
        clearInterval(gc); clearInterval(ttsGc); clearTimeout(saveTimer); clearTimeout(statusTimer);
        await stopTikTok(true);
        for (const ws of unityClients) { try { ws.terminate(); } catch { /* bỏ qua */ } }
        await new Promise((r) => io.close(() => r()));
        await new Promise((r) => { server.close(() => r()); setTimeout(r, 1500); });
    }

    return { app, server, io, state, cfg, start, stop, tts, startTikTok, stopTikTok };
}

module.exports = { createApp, loadConfig, escHtml, cleanText, TtsService, TicketQueue };

// ───────────────────────── Chạy trực tiếp ─────────────────────────
if (require.main === module) {
    process.on('unhandledRejection', (r) => warn('unhandledRejection:', r && r.message ? r.message : r));
    process.on('uncaughtException', (e) => warn('uncaughtException:', e && e.stack ? e.stack : e));

    const srv = createApp();
    srv.start().catch((e) => { console.error('Không mở được cổng:', e.message); process.exit(1); });

    let closing = false;
    const shutdown = async (sig) => {
        if (closing) return;
        closing = true;
        log(`Nhận ${sig}, đang dừng...`);
        const force = setTimeout(() => process.exit(0), 5000);
        force.unref();
        try { await srv.stop(); } catch { /* bỏ qua */ }
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
