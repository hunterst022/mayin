'use strict';
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { createApp } = require('../server');

// ───────── Client Socket.IO tối giản (giao thức v4 qua WebSocket) ─────────
class SioClient {
    constructor(port, headers = {}) { this.port = port; this.headers = headers; this.log = []; this.waiters = []; }
    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/socket.io/?EIO=4&transport=websocket`, { headers: this.headers, maxPayload: 40e6 });
            this.ws.on('error', reject);
            this.ws.on('message', (raw) => {
                const m = raw.toString();
                if (m[0] === '0') this.ws.send('40');
                else if (m === '2') this.ws.send('3');
                else if (m.startsWith('40')) resolve(this);
                else if (m.startsWith('42')) {
                    const [event, data] = JSON.parse(m.slice(2));
                    const rec = { event, data, at: Date.now() };
                    this.log.push(rec);
                    this.waiters = this.waiters.filter((w) => { if (w.event === event && w.pred(data)) { w.res(data); return false; } return true; });
                }
            });
        });
    }
    emit(event, data) { this.ws.send('42' + JSON.stringify([event, data])); }
    count(event, pred = () => true) { return this.log.filter((l) => l.event === event && pred(l.data)).length; }
    last(event) { const a = this.log.filter((l) => l.event === event); return a.length ? a[a.length - 1].data : undefined; }
    waitFor(event, pred = () => true, timeout = 3000) {
        const found = this.log.find((l) => l.event === event && pred(l.data));
        if (found) return Promise.resolve(found.data);
        return new Promise((res, rej) => {
            const w = { event, pred, res };
            this.waiters.push(w);
            setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); rej(new Error(`Hết giờ chờ '${event}'`)); }, timeout);
        });
    }
    close() { try { this.ws.close(); } catch { /* */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function httpReq(port, method, p, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
            const chunks = []; res.on('data', (c) => chunks.push(c));
            res.on('end', () => { const buf = Buffer.concat(chunks); resolve({ status: res.statusCode, headers: res.headers, buf, text: buf.toString('utf8'), json() { return JSON.parse(buf.toString('utf8')); } }); });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

// ───────── TikTok giả lập (cùng tên sự kiện & hình dạng dữ liệu với thư viện thật) ─────────
class UserOfflineError extends Error {}
class InvalidUniqueIdError extends Error {}
class SignatureRateLimitError extends Error {}
const behavior = { fail: null, delay: 0 };
class MockConn extends EventEmitter {
    constructor(id, opts) { super(); this.id = id; this.opts = opts; this.roomId = ''; MockConn.all.push(this); }
    async connect() { if (behavior.delay) await sleep(behavior.delay); if (behavior.fail) throw behavior.fail; this.roomId = 'room-' + this.id; }
    async disconnect() { this.disconnected = true; }
}
MockConn.all = [];
const mockLib = {
    TikTokLiveConnection: MockConn,
    WebcastEvent: { GIFT: 'gift', CHAT: 'chat', MEMBER: 'member', STREAM_END: 'streamEnd' },
    ControlEvent: { ERROR: 'error', DISCONNECTED: 'disconnected' },
    UserOfflineError, InvalidUniqueIdError, SignatureRateLimitError,
};
const live = () => MockConn.all[MockConn.all.length - 1];
let mid = 0;
const user = (n, id) => ({ id: id || 'u-' + n, nickname: n, displayId: n.toLowerCase(), avatarThumb: { urlList: ['https://p16.example.com/a.jpeg'] } });
const gift = (n, name, unit, extra = {}) => ({ common: { msgId: 'm' + ++mid }, user: user(n), giftId: 'g-' + name, repeatCount: 1, repeatEnd: 0, groupId: 'grp', gift: { name, diamondCount: unit, type: 0 }, ...extra });

// ───────── Khung chạy test ─────────
const results = [];
async function test(name, fn) {
    try { await fn(); results.push([name, true]); console.log('  ✔', name); }
    catch (e) { results.push([name, false, e]); console.log('  ✘', name, '\n     ', e.message); }
}

function makeServer(extra = {}, opts = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-'));
    return createApp({
        config: { port: 0, host: '127.0.0.1', dataDir, reconnectBaseMs: 100, streakFlushMs: 400, ...extra },
        loadTikTokLib: async () => mockLib,
        ttsSynth: opts.ttsSynth,
    });
}

(async () => {
    // ═════════ Nhóm 1: chức năng chính (không mật khẩu) ═════════
    console.log('\n[1] Giao diện, Socket.IO, TikTok giả lập');
    const s = makeServer();
    const port = await s.start(0, '127.0.0.1');
    const dash = await new SioClient(port).connect();
    const ovl = await new SioClient(port).connect();

    await test('Phục vụ trang bảng điều khiển, overlay, JS và /healthz', async () => {
        for (const p of ['/', '/overlay.html', '/js/app.js', '/js/printer.js', '/css/style.css']) {
            const r = await httpReq(port, 'GET', p);
            assert.strictEqual(r.status, 200, p + ' → ' + r.status);
        }
        const h = (await httpReq(port, 'GET', '/healthz')).json();
        assert.strictEqual(h.ok, true);
        assert.strictEqual((await httpReq(port, 'GET', '/khong-ton-tai')).status, 404);
    });

    await test('Client mới nhận trạng thái ban đầu (bridge/board/clock/stats)', async () => {
        for (const ev of ['bridge_status', 'board_state_update', 'clock_settings', 'update_stats']) await dash.waitFor(ev);
        assert.strictEqual(dash.last('board_state_update').items.length, 6);
        assert.strictEqual(dash.last('bridge_status').isConnected, false);
    });

    await test('/api/start: tên không hợp lệ bị từ chối', async () => {
        const r = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: '  ' } });
        assert.strictEqual(r.status, 400); assert.strictEqual(r.json().success, false);
        const r2 = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'a b<script>' } });
        assert.strictEqual(r2.json().success, false);
    });

    await test('/api/start: chủ phòng chưa live → thông báo tiếng Việt, không treo trạng thái', async () => {
        behavior.fail = new UserOfflineError('offline');
        const r = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'chualive' } });
        assert.strictEqual(r.json().success, false);
        assert.ok(/không phát LIVE/.test(r.json().error), r.json().error);
        await dash.waitFor('connection_status', (d) => d.status === 'error');
        assert.strictEqual(s.state.tiktok.connecting, false);
        behavior.fail = null;
    });

    await test('/api/start: lỗi giới hạn ký → gợi ý SIGN_API_KEY', async () => {
        behavior.fail = new SignatureRateLimitError('429');
        const r = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'abc' } });
        assert.ok(/SIGN_API_KEY/.test(r.json().error));
        behavior.fail = null;
    });

    await test('/api/start: kết nối thành công, nhận @ và URL tiktok.com', async () => {
        const r = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: '@Shop.Hoa' } });
        assert.strictEqual(r.json().success, true);
        assert.strictEqual(r.json().roomId, 'room-Shop.Hoa');
        assert.strictEqual(live().opts.processInitialData, false);
        await dash.waitFor('connection_status', (d) => d.status === 'connected');
        await dash.waitFor('bridge_status', (d) => d.isConnected === true && d.uniqueId === 'Shop.Hoa');
        // bấm lại cùng ID → already_connected, không tạo kết nối thứ 2
        const before = MockConn.all.length;
        const r2 = await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'https://www.tiktok.com/@shop.hoa/live' } });
        assert.strictEqual(r2.json().success, true); assert.strictEqual(MockConn.all.length, before);
        await dash.waitFor('connection_status', (d) => d.status === 'already_connected');
    });

    await test('Client mở sau khi đã kết nối vẫn thấy trạng thái "connected"', async () => {
        const late = await new SioClient(port).connect();
        await late.waitFor('connection_status', (d) => d.status === 'connected' && d.uniqueId === 'Shop.Hoa');
        late.close();
    });

    await test('Quà tặng được phân tier 1/2/3 theo kim cương và dịch tên quà', async () => {
        const c = live();
        c.emit('gift', gift('An', 'Rose', 1));
        c.emit('gift', gift('Bình', 'Finger Heart', 5));
        c.emit('gift', gift('Chi', 'Doughnut', 30, { repeatCount: 3 }));
        const t1 = await ovl.waitFor('print_ticket', (d) => d.type === 'gift' && d.username === 'An');
        const t2 = await ovl.waitFor('print_ticket', (d) => d.type === 'gift' && d.username === 'Bình');
        const t3 = await ovl.waitFor('print_ticket', (d) => d.type === 'gift' && d.username === 'Chi');
        assert.deepStrictEqual([t1.tier, t2.tier, t3.tier], [1, 2, 3]);
        assert.strictEqual(t1.giftName, 'Hoa hồng'); assert.strictEqual(t2.giftName, 'Bắn tim'); assert.strictEqual(t3.giftName, 'Bánh vòng');
        assert.strictEqual(t3.repeatCount, 3); assert.strictEqual(t3.diamondCount, 90);
        assert.ok(t1.ttsText && t1.ttsVoice === 'vi'); assert.strictEqual(t1.profilePictureUrl, 'https://p16.example.com/a.jpeg');
        await dash.waitFor('update_stats', (d) => d.total === 1 + 5 + 90);
    });

    await test('Chuỗi quà combo: chỉ in 1 vé với số lượng cuối cùng (repeatEnd)', async () => {
        const c = live(); const key = { giftId: 'g-rose2', groupId: 'combo1' };
        const mk = (n, end) => ({ common: { msgId: 'c' + ++mid }, user: user('Dũng'), ...key, repeatCount: n, repeatEnd: end, gift: { name: 'Rose', diamondCount: 1, type: 1 } });
        const base = ovl.count('print_ticket', (d) => d.username === 'Dũng');
        c.emit('gift', mk(1, 0)); c.emit('gift', mk(2, 0)); c.emit('gift', mk(5, 0));
        await sleep(100);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.username === 'Dũng'), base, 'không được in khi combo chưa kết thúc');
        c.emit('gift', mk(7, 1));
        const t = await ovl.waitFor('print_ticket', (d) => d.username === 'Dũng');
        assert.strictEqual(t.repeatCount, 7);
        await sleep(600);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.username === 'Dũng'), base + 1, 'timer không được in lần 2');
    });

    await test('Chuỗi quà combo mất sự kiện kết thúc → tự in sau thời gian chờ', async () => {
        const c = live();
        c.emit('gift', { common: { msgId: 'x' + ++mid }, user: user('Giang'), giftId: 'g-z', groupId: 'z', repeatCount: 4, repeatEnd: 0, gift: { name: 'Rose', diamondCount: 1, type: 1 } });
        const t = await ovl.waitFor('print_ticket', (d) => d.username === 'Giang', 2000);
        assert.strictEqual(t.repeatCount, 4);
    });

    await test('Sự kiện trùng msgId bị bỏ qua', async () => {
        const c = live(); const g = gift('Hải', 'Rose', 1);
        c.emit('gift', g); c.emit('gift', g);
        await sleep(150);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.username === 'Hải'), 1);
    });

    await test('Chống XSS: tên, bình luận, tên quà, avatar độc hại được làm sạch', async () => {
        const c = live();
        c.emit('chat', { common: { msgId: 'x' + ++mid }, user: { ...user('<img src=x onerror=alert(1)>'), avatarThumb: { urlList: ['javascript:alert(1)'] } }, content: '<script>alert("hi")</script> & "q"' });
        const t = await ovl.waitFor('print_ticket', (d) => d.type === 'chat' && /img/.test(d.username), 3000);
        assert.ok(!/[<>]/.test(t.username + t.comment), 'còn ký tự < > chưa escape');
        assert.ok(t.comment.includes('&lt;script&gt;'));
        assert.strictEqual(t.profilePictureUrl, '');
        c.emit('gift', { ...gift('Khoa', '"><svg onload=1>', 1) });
        const g = await ovl.waitFor('print_ticket', (d) => d.type === 'gift' && d.username === 'Khoa');
        assert.ok(!/[<>"]/.test(g.giftName), g.giftName);
    });

    await test('Chat chào hỏi có ttsText; chat thường thì không', async () => {
        const c = live();
        c.emit('chat', { common: { msgId: 'x' + ++mid }, user: user('Lan'), content: 'Xin chào shop' });
        const t = await ovl.waitFor('print_ticket', (d) => d.type === 'chat' && d.username === 'Lan', 3000);
        assert.ok(t.ttsText && /Lan/.test(t.ttsText));
        c.emit('chat', { common: { msgId: 'x' + ++mid }, user: user('Mai'), content: 'giá bao nhiêu ạ' });
        const t2 = await ovl.waitFor('print_ticket', (d) => d.type === 'chat' && d.username === 'Mai', 3000);
        assert.strictEqual(t2.ttsText, undefined);
    });

    await test('Join: mỗi người chỉ in 1 lần, bỏ qua sự kiện rời phòng', async () => {
        const c = live();
        c.emit('member', { common: { msgId: 'x' + ++mid }, user: user('Nam', 'u-nam'), action: 1 });
        c.emit('member', { common: { msgId: 'x' + ++mid }, user: user('Nam', 'u-nam'), action: 1 });
        c.emit('member', { common: { msgId: 'x' + ++mid }, user: user('Oanh', 'u-oanh'), action: 2 });
        await sleep(1700);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.type === 'join' && d.username === 'Nam'), 1);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.type === 'join' && d.username === 'Oanh'), 0);
    });

    await test('Chat dồn dập: giãn nhịp & giới hạn hàng đợi (không làm ngập overlay)', async () => {
        const c = live(); const base = ovl.count('print_ticket', (d) => d.type === 'chat');
        for (let i = 0; i < 40; i++) c.emit('chat', { common: { msgId: 'f' + ++mid }, user: user('Spam' + i), content: 'tin ' + i });
        await sleep(300);
        const early = ovl.count('print_ticket', (d) => d.type === 'chat') - base;
        assert.ok(early <= 2, 'đã phát ' + early + ' vé trong 300ms');
        await sleep(4800);
        const total = ovl.count('print_ticket', (d) => d.type === 'chat') - base;
        assert.ok(total <= 8, 'hàng đợi vượt giới hạn: ' + total);
        assert.ok(ovl.log.filter((l) => l.event === 'print_ticket' && l.data.username === 'Spam39').length === 1, 'tin mới nhất phải được giữ lại');
    });

    await test('Lỗi bất ngờ từ thư viện không làm sập server (error listener)', async () => {
        live().emit('error', new Error('boom'));
        live().emit('gift', null); live().emit('chat', {}); live().emit('member', undefined);
        await sleep(100);
        assert.strictEqual((await httpReq(port, 'GET', '/healthz')).status, 200);
    });

    await test('Mất kết nối bất ngờ → tự kết nối lại', async () => {
        const first = live(); const n = MockConn.all.length;
        first.emit('disconnected');
        await dash.waitFor('connection_status', (d) => d.status === 'disconnected');
        await sleep(600);
        assert.strictEqual(MockConn.all.length, n + 1, 'phải tạo kết nối mới');
        assert.ok(first.disconnected, 'kết nối cũ phải được dọn');
        assert.strictEqual(s.state.tiktok.connected, true);
        // sự kiện của kết nối mới vẫn đến overlay
        live().emit('gift', gift('SauNoiLai', 'Rose', 1));
        await ovl.waitFor('print_ticket', (d) => d.username === 'SauNoiLai');
        // kết nối cũ không còn ảnh hưởng
        first.emit('disconnected');
        await sleep(300);
        assert.strictEqual(MockConn.all.length, n + 1);
    });

    await test('Sự kiện LIVE kết thúc → dừng, không nối lại', async () => {
        const n = MockConn.all.length;
        live().emit('streamEnd');
        await dash.waitFor('connection_status', (d) => d.status === 'error' && /kết thúc/.test(d.error));
        await sleep(400);
        assert.strictEqual(MockConn.all.length, n);
        assert.strictEqual(s.state.tiktok.connected, false);
    });

    await test('/api/stop: ngắt kết nối và dọn dẹp', async () => {
        await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'stopme' } });
        const c = live();
        const r = await httpReq(port, 'POST', '/api/stop');
        assert.strictEqual(r.json().success, true); assert.ok(c.disconnected);
        await dash.waitFor('bridge_status', (d) => d.isConnected === false);
        // gọi stop khi chưa kết nối không được lỗi
        assert.strictEqual((await httpReq(port, 'POST', '/api/stop')).json().success, true);
    });

    await test('Chuyển sang ID khác khi đang kết nối: kết nối cũ bị đóng', async () => {
        await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'first' } });
        const a = live();
        await httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'second' } });
        assert.ok(a.disconnected); assert.strictEqual(s.state.tiktok.uniqueId, 'second');
        a.emit('gift', gift('Ma', 'Rose', 1)); // kết nối cũ đã bị gỡ listener
        await sleep(100);
        assert.strictEqual(ovl.count('print_ticket', (d) => d.username === 'Ma'), 0);
        await httpReq(port, 'POST', '/api/stop');
    });

    await test('Hai lệnh /api/start đồng thời: lệnh thứ 2 bị từ chối', async () => {
        behavior.delay = 400;
        const [r1, r2] = await Promise.all([
            httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'racea' } }),
            (async () => { await sleep(50); return httpReq(port, 'POST', '/api/start', { body: { uniqueId: 'raceb' } }); })(),
        ]);
        behavior.delay = 0;
        assert.strictEqual(r1.json().success, true);
        assert.strictEqual(r2.json().success, false);
        await httpReq(port, 'POST', '/api/stop');
    });

    await test('Nút thử nghiệm (tier1/2/3/chat/join) tạo vé đúng loại', async () => {
        const base = ovl.log.length;
        for (const t of ['tier1', 'tier2', 'tier3', 'chat', 'join']) dash.emit('test_event', t);
        await sleep(300);
        const tickets = ovl.log.slice(base).filter((l) => l.event === 'print_ticket').map((l) => l.data);
        assert.strictEqual(tickets.length, 5);
        assert.deepStrictEqual(tickets.slice(0, 3).map((t) => t.tier), [1, 2, 3]);
        assert.deepStrictEqual(tickets.slice(3).map((t) => t.type), ['chat', 'join']);
        assert.strictEqual(ovl.count('connection_status', (d) => d.uniqueId === 'Test_Mode'), 1);
        dash.emit('test_event', { evil: 1 }); dash.emit('test_event', 'x'.repeat(100));
    });

    await test('Bảng vinh danh: cập nhật, làm sạch, lưu file và phát cho mọi client', async () => {
        dash.emit('update_board_state', { show: false });
        await ovl.waitFor('board_state_update', (d) => d.show === false);
        dash.emit('update_board_state', { items: [{ id: 0, show: false, name: '<b>Tên mới</b>', desc: 'Mô tả' }, null, { id: 99, name: 'x' }, 'rác'] });
        const b = await ovl.waitFor('board_state_update', (d) => d.items[0].name.includes('Tên mới'));
        assert.strictEqual(b.items.length, 6); assert.strictEqual(b.items[0].show, false);
        assert.strictEqual(b.show, false); assert.strictEqual(b.items[1].name, 'Bắn tim');
        dash.emit('update_board_state', 'rác'); dash.emit('update_board_state', null);
        await sleep(900);
        const saved = JSON.parse(fs.readFileSync(path.join(s.cfg.dataDir, 'settings.json'), 'utf8'));
        assert.strictEqual(saved.board.items[0].show, false);
    });

    await test('Đồng hồ: múi giờ hợp lệ được nhận, múi giờ sai bị bỏ qua', async () => {
        dash.emit('update_clock_settings', { show: true, timeZone: 'America/New_York', hour12: true });
        await ovl.waitFor('clock_settings', (d) => d.timeZone === 'America/New_York' && d.hour12 === true);
        dash.emit('update_clock_settings', { timeZone: 'Mars/Olympus', show: false });
        const c = await ovl.waitFor('clock_settings', (d) => d.show === false);
        assert.strictEqual(c.timeZone, 'America/New_York');
    });

    await test('Nhạc nền: YouTube/MP3 hợp lệ được phát; dữ liệu sai bị chặn; MP3 ~20MB đi qua được', async () => {
        const b = ovl.count('play_music');
        dash.emit('set_music', { type: 'youtube', videoId: 'dQw4w9WgXcQ' });
        await ovl.waitFor('play_music', (d) => d.type === 'youtube' && d.videoId === 'dQw4w9WgXcQ');
        dash.emit('set_music', { type: 'youtube', videoId: '"><script>' });
        dash.emit('set_music', { type: 'mp3', dataUrl: 'javascript:alert(1)' });
        dash.emit('set_music', { type: 'zzz' });
        const big = 'data:audio/mpeg;base64,' + 'A'.repeat(20 * 1024 * 1024);
        dash.emit('set_music', { type: 'mp3', dataUrl: big });
        await ovl.waitFor('play_music', (d) => d.type === 'mp3' && d.dataUrl.length === big.length, 8000);
        dash.emit('set_music', { type: 'stop' });
        await ovl.waitFor('play_music', (d) => d.type === 'stop');
        assert.strictEqual(ovl.count('play_music'), b + 3);
    });

    await test('Unity WebSocket: nhận hello + vé; bộ đếm unityWs cập nhật', async () => {
        const msgs = [];
        const ws = new WebSocket(`ws://127.0.0.1:${port}/unity`);
        ws.on('message', (m) => msgs.push(JSON.parse(m.toString())));
        await new Promise((r, j) => { ws.on('open', r); ws.on('error', j); });
        await dash.waitFor('bridge_status', (d) => d.unityWs === 1);
        dash.emit('test_event', 'tier3');
        await sleep(300);
        assert.ok(msgs.some((m) => m.event === 'hello'));
        assert.ok(msgs.some((m) => m.event === 'print_ticket' && m.data.tier === 3));
        ws.close();
        await dash.waitFor('bridge_status', (d) => d.unityWs === 0);
    });

    await test('JSON hỏng gửi tới /api/start → 400, server vẫn sống', async () => {
        const r = await new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/api/start', headers: { 'Content-Type': 'application/json' } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
            req.on('error', reject); req.end('{khong-phai-json');
        });
        assert.strictEqual(r, 400);
        assert.strictEqual((await httpReq(port, 'GET', '/healthz')).status, 200);
    });

    dash.close(); ovl.close();
    await s.stop();

    // ═════════ Nhóm 2: TTS ═════════
    console.log('\n[2] TTS (cache, chống gọi trùng, giới hạn tốc độ, lỗi)');
    let synthCalls = 0; let failNext = 0;
    const s2 = makeServer({ ttsRatePerMin: 12 }, { ttsSynth: async (text, voice) => { synthCalls++; await sleep(80); if (failNext > 0) { failNext--; throw new Error('mạng lỗi'); } return Buffer.from(`MP3[${voice}|${text}]`); } });
    const p2 = await s2.start(0, '127.0.0.1');
    await test('Trả audio/mpeg, chọn đúng giọng, escape/giới hạn độ dài', async () => {
        const r = await httpReq(p2, 'GET', '/api/tts?text=' + encodeURIComponent('Cảm ơn Lan!') + '&voice=vi');
        assert.strictEqual(r.status, 200); assert.strictEqual(r.headers['content-type'], 'audio/mpeg');
        assert.ok(r.text.includes('vi-VN-HoaiMyNeural|Cảm ơn Lan!'));
        const r2 = await httpReq(p2, 'GET', '/api/tts?text=hi&voice=en');
        assert.ok(r2.text.includes('en-US-AriaNeural'));
        const r3 = await httpReq(p2, 'GET', '/api/tts?text=hi&voice=' + encodeURIComponent('"><evil'));
        assert.ok(r3.text.includes('vi-VN-HoaiMyNeural'), 'voice lạ phải rơi về giọng Việt');
        const r4 = await httpReq(p2, 'GET', '/api/tts?text=' + 'a'.repeat(500) + '&voice=vi');
        assert.ok(r4.buf.length < 260);
    });
    await test('Cache: cùng câu chỉ tổng hợp 1 lần; yêu cầu đồng thời được gộp', async () => {
        synthCalls = 0;
        const url = '/api/tts?text=' + encodeURIComponent('Câu trùng') + '&voice=vi';
        await Promise.all([1, 2, 3, 4].map(() => httpReq(p2, 'GET', url)));
        await httpReq(p2, 'GET', url);
        assert.strictEqual(synthCalls, 1);
    });
    await test('Lỗi tổng hợp: thử lại 1 lần; vẫn lỗi → 502 (client sẽ tự bỏ qua câu)', async () => {
        failNext = 1;
        assert.strictEqual((await httpReq(p2, 'GET', '/api/tts?text=thulai1')).status, 200);
        failNext = 2;
        assert.strictEqual((await httpReq(p2, 'GET', '/api/tts?text=hongluon')).status, 502);
        assert.strictEqual((await httpReq(p2, 'GET', '/api/tts?text=')).status, 400);
    });
    await test('Giới hạn tốc độ theo IP → 429', async () => {
        let got429 = false;
        for (let i = 0; i < 20; i++) { const r = await httpReq(p2, 'GET', '/api/tts?text=rl' + i); if (r.status === 429) { got429 = true; break; } }
        assert.ok(got429);
    });
    await s2.stop();

    // ═════════ Nhóm 3: mật khẩu quản trị ═════════
    console.log('\n[3] Bảo vệ bảng điều khiển bằng ADMIN_PASSWORD');
    const s3 = makeServer({ adminPassword: 'mat-khau-test', adminUser: 'boss' });
    const p3 = await s3.start(0, '127.0.0.1');
    const good = 'Basic ' + Buffer.from('boss:mat-khau-test').toString('base64');
    const bad = 'Basic ' + Buffer.from('boss:sai').toString('base64');
    await test('Chưa đăng nhập: / và /api/* → 401; overlay/TTS/healthz vẫn mở', async () => {
        for (const [m, p] of [['GET', '/'], ['GET', '/index.html'], ['POST', '/api/start'], ['POST', '/api/stop'], ['GET', '/api/status']]) {
            const r = await httpReq(p3, m, p, { body: m === 'POST' ? { uniqueId: 'abc' } : undefined });
            assert.strictEqual(r.status, 401, `${m} ${p}`); assert.ok(/Basic/.test(r.headers['www-authenticate']));
        }
        assert.strictEqual((await httpReq(p3, 'GET', '/', { headers: { Authorization: bad } })).status, 401);
        for (const p of ['/overlay.html', '/healthz', '/js/app.js']) assert.strictEqual((await httpReq(p3, 'GET', p)).status, 200, p);
    });
    await test('Đăng nhập đúng: vào được bảng điều khiển và gọi API', async () => {
        assert.strictEqual((await httpReq(p3, 'GET', '/', { headers: { Authorization: good } })).status, 200);
        const r = await httpReq(p3, 'POST', '/api/start', { headers: { Authorization: good }, body: { uniqueId: 'abcd' } });
        assert.strictEqual(r.json().success, true);
        await httpReq(p3, 'POST', '/api/stop', { headers: { Authorization: good } });
    });
    await test('Socket không đăng nhập (overlay) không điều khiển được; socket admin thì được', async () => {
        const anon = await new SioClient(p3).connect();
        const adm = await new SioClient(p3, { Authorization: good }).connect();
        const watcher = await new SioClient(p3).connect();
        anon.emit('test_event', 'tier3'); anon.emit('update_board_state', { show: false }); anon.emit('set_music', { type: 'stop' }); anon.emit('update_clock_settings', { show: false });
        await sleep(300);
        assert.strictEqual(watcher.count('print_ticket'), 0); assert.strictEqual(watcher.count('play_music'), 0);
        assert.strictEqual(s3.state.board.show, true); assert.strictEqual(s3.state.clock.show, true);
        adm.emit('test_event', 'tier3');
        await watcher.waitFor('print_ticket', (d) => d.tier === 3);
        anon.close(); adm.close(); watcher.close();
    });
    await test('Unity WS cũng đòi đăng nhập khi có mật khẩu', async () => {
        const code = await new Promise((res) => { const ws = new WebSocket(`ws://127.0.0.1:${p3}/unity`); ws.on('unexpected-response', (rq, rs) => res(rs.statusCode)); ws.on('open', () => res('open')); ws.on('error', () => {}); });
        assert.strictEqual(code, 401);
    });
    await s3.stop();

    // ═════════ Nhóm 4: thư viện TikTok THẬT (không có mạng) ═════════
    console.log('\n[4] Thư viện tiktok-live-connector thật (sandbox không có Internet)');
    const s4 = createApp({ config: { port: 0, host: '127.0.0.1', dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'ttp-')), connectTimeoutMs: 15000 } });
    const p4 = await s4.start(0, '127.0.0.1');
    await test('Tên enum/lớp lỗi mà server dùng đều tồn tại trong thư viện thật', async () => {
        const lib = await import('tiktok-live-connector');
        for (const n of ['TikTokLiveConnection', 'WebcastEvent', 'ControlEvent', 'UserOfflineError', 'InvalidUniqueIdError', 'SignatureRateLimitError', 'SignAPIError', 'AlreadyConnectingError', 'ConnectTimeoutError'])
            assert.ok(lib[n], 'thiếu ' + n);
        for (const n of ['GIFT', 'CHAT', 'MEMBER', 'STREAM_END']) assert.ok(lib.WebcastEvent[n], 'thiếu WebcastEvent.' + n);
        for (const n of ['ERROR', 'DISCONNECTED']) assert.ok(lib.ControlEvent[n], 'thiếu ControlEvent.' + n);
        const c = new lib.TikTokLiveConnection('someone', { processInitialData: false, fetchRoomInfoOnConnect: true, enableExtendedGiftInfo: false });
        assert.strictEqual(typeof c.connect, 'function'); assert.strictEqual(typeof c.disconnect, 'function');
        assert.strictEqual(typeof c.removeAllListeners, 'function');
    });
    await test('Kết nối thật khi mất mạng: trả lỗi rõ ràng, không treo, không sập', async () => {
        const t0 = Date.now();
        const r = await httpReq(p4, 'POST', '/api/start', { body: { uniqueId: 'tiktok' } });
        const j = r.json();
        console.log('      → phản hồi sau', Date.now() - t0, 'ms:', JSON.stringify(j.error).slice(0, 140));
        assert.strictEqual(j.success, false); assert.ok(j.error && j.error.length > 3);
        assert.strictEqual(s4.state.tiktok.connecting, false);
        assert.strictEqual((await httpReq(p4, 'GET', '/healthz')).status, 200);
    });
    await s4.stop();

    const failed = results.filter((r) => !r[1]);
    console.log(`\n══ Kết quả: ${results.length - failed.length}/${results.length} đạt ══`);
    process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('Lỗi khung test:', e); process.exit(2); });
