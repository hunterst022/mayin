const socket = io();

// ════════════════════════════════════
// TAB SWITCHING
// ════════════════════════════════════
const TAB_IDS = ['control', 'printer'];


function switchTab(target) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    TAB_IDS.forEach(id => {
        const el = document.getElementById('tab-' + id);
        if (el) el.style.display = 'none';
    });

    const btn = document.querySelector(`[data-tab="${target}"]`);
    if (btn) btn.classList.add('active');

    const tab = document.getElementById('tab-' + target);
    if (tab) {
        // printer tab uses flex centering
        tab.style.display = (target === 'printer') ? 'flex' : 'block';
    }
}

document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// Fit the 1080x1920 printer preview into the area below the status + tab bars (92px)
function fitPrinterPreview() {
    const container = document.querySelector('#tab-printer .main-container');
    if (!container) return;
    const pad = 16;
    const scale = Math.min((window.innerWidth - pad * 2) / 1080, (window.innerHeight - 92 - pad * 2) / 1920);
    container.style.setProperty('--fit-scale', Math.max(scale, 0.05));
}
window.addEventListener('resize', fitPrinterPreview);
fitPrinterPreview();

// Default: show control tab
switchTab('control');

// ════════════════════════════════════
// CONTROL PANEL — Connect/Disconnect
// ════════════════════════════════════
const tiktokIdInput   = document.getElementById('tiktok-id-input');
const connectBtn      = document.getElementById('connect-btn');
const disconnectBtn   = document.getElementById('disconnect-btn');
const statusMsg       = document.getElementById('connect-status-msg');

function showMsg(text, type) {
    statusMsg.textContent = text;
    statusMsg.className = 'msg-' + type;
    statusMsg.style.display = 'block';
}

connectBtn.addEventListener('click', async () => {
    const uniqueId = tiktokIdInput.value.trim().replace(/^@/, '');
    if (!uniqueId) { showMsg('Vui lòng nhập tên người dùng TikTok!', 'err'); return; }

    connectBtn.disabled = true;
    showMsg('⏳ Đang kết nối tới @' + uniqueId + '...', 'loading');

    try {
        const res = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uniqueId })
        });
        const data = await res.json();
        if (data.success) {
            showMsg('✅ Đã kết nối tới @' + uniqueId + (data.roomId ? ' | Phòng: ' + data.roomId : ''), 'ok');
        } else {
            showMsg('❌ ' + (data.error || 'Không thể kết nối'), 'err');
        }
    } catch (e) {
        showMsg('❌ Lỗi máy chủ: ' + e.message, 'err');
    } finally {
        connectBtn.disabled = false;
    }
});

disconnectBtn.addEventListener('click', async () => {
    await fetch('/api/stop', { method: 'POST' });
    showMsg('Đã ngắt kết nối.', 'loading');
});

// Enter key
tiktokIdInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') connectBtn.click();
});

// Auto-connect via URL params
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.has('user')) {
    tiktokIdInput.value = urlParams.get('user');
    connectBtn.click();
}

// ════════════════════════════════════
// STATUS BAR — realtime updates
// ════════════════════════════════════
function updateStatusBar(status) {
    const pillTT = document.getElementById('pill-tiktok');
    const pillTTText = document.getElementById('pill-tiktok-text');
    const pillWS = document.getElementById('pill-unity-ws');
    const pillWSText = document.getElementById('pill-unity-ws-text');
    const pillTCP = document.getElementById('pill-unity-tcp');
    const pillTCPText = document.getElementById('pill-unity-tcp-text');
    const barDiamonds = document.getElementById('bar-diamonds');

    // TikTok status
    if (status.isConnected) {
        pillTT.className = 'status-pill online';
        pillTT.querySelector('.dot').classList.add('pulse');
        pillTTText.textContent = '@' + status.uniqueId;
    } else {
        pillTT.className = 'status-pill offline';
        pillTT.querySelector('.dot').classList.remove('pulse');
        pillTTText.textContent = 'TikTok: Đang chờ';
    }

    // Unity WS
    if (status.unityWs > 0) {
        pillWS.className = 'status-pill online';
        pillWSText.textContent = 'Unity WS: ' + status.unityWs;
    } else {
        pillWS.className = 'status-pill offline';
        pillWSText.textContent = 'Unity WS: 0';
    }

    // Unity TCP
    if (status.unityTcp) {
        pillTCP.className = 'status-pill online';
        pillTCPText.textContent = 'Unity TCP: ●';
    } else {
        pillTCP.className = 'status-pill offline';
        pillTCPText.textContent = 'Unity TCP: –';
    }

    // Diamonds
    barDiamonds.textContent = (status.diamonds || 0).toLocaleString('vi-VN');
}

function updateStatCards(status) {
    document.getElementById('stat-tiktok').textContent =
        status.isConnected ? '@' + status.uniqueId : 'Đang chờ kết nối';
    document.getElementById('stat-diamonds').textContent =
        (status.diamonds || 0).toLocaleString('vi-VN');
    document.getElementById('stat-unity-ws').textContent =
        (status.unityWs || 0) + ' kết nối';
    document.getElementById('stat-unity-tcp').textContent =
        status.unityTcp ? '✅ Đã kết nối' : 'Chưa kết nối';
}

// ════════════════════════════════════
// EVENT LOG
// ════════════════════════════════════
const eventLog = document.getElementById('event-log');

function logEvent(type, text) {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);
    const el = document.createElement('div');
    el.className = 'log-entry ' + type;
    el.innerHTML = `<span class="ts">${ts}</span>${text}`;
    eventLog.appendChild(el);
    // Auto scroll to bottom
    eventLog.scrollTop = eventLog.scrollHeight;
    // Keep max 200 entries
    while (eventLog.children.length > 200) {
        eventLog.removeChild(eventLog.firstChild);
    }
}

function clearLog() {
    eventLog.innerHTML = '';
}

// ════════════════════════════════════
// PRINTER VIEW — existing counters
// ════════════════════════════════════
const hud        = document.getElementById('hud');
const marqueeText = document.getElementById('marquee');
const countNormal   = document.getElementById('count-normal');
const countVip      = document.getElementById('count-vip');
const countSuperVipElements = document.querySelectorAll('.count-super-vip');
let stats = { normal: 0, vip: 0, superVip: 0 };

// ════════════════════════════════════
// SOCKET LISTENERS
// ════════════════════════════════════
socket.on('bridge_status', (data) => {
    updateStatusBar(data);
    updateStatCards(data);
});

socket.on('connection_status', (data) => {
    if (!data) return;

    if (data.status === 'connected' || data.status === 'already_connected') {
        hud.style.opacity = '1';
        const mc = document.getElementById('marquee-container');
        if (mc) mc.style.opacity = '1';
        if (data.uniqueId !== 'Test_Mode') {
            marqueeText.textContent = `Đã kết nối Live @${data.uniqueId}! Đang chờ sự kiện...`;
        }
        logEvent('system', `✅ Kết nối thành công: @${data.uniqueId}`);
        showMsg('✅ Đã kết nối tới @' + data.uniqueId, 'ok');
    } else if (data.status === 'connecting') {
        logEvent('system', `⏳ Đang kết nối tới @${data.uniqueId}...`);
    } else if (data.status === 'disconnected') {
        logEvent('system', '🔌 Đã ngắt kết nối');
        showMsg('Đã ngắt kết nối.', 'loading');
    } else if (data.status === 'error') {
        logEvent('system', `❌ Lỗi: ${data.error}`);
        showMsg('❌ ' + data.error, 'err');
    }
});

socket.on('update_stats', (s) => {
    const diamonds = s.total || 0;
    document.getElementById('stat-diamonds').textContent = diamonds.toLocaleString('vi-VN');
    document.getElementById('bar-diamonds').textContent = diamonds.toLocaleString('vi-VN');
});

socket.on('board_state_update', (state) => {
    // 1. Update Control Panel UI if it's open
    const toggleCb = document.getElementById('toggle-board-cb');
    if (toggleCb) toggleCb.checked = state.show;
    
    const configContainer = document.getElementById('board-items-config');
    if (configContainer && state.items) {
        // Only render the inputs if they don't exist yet to avoid losing focus
        if (configContainer.children.length === 0) {
            configContainer.innerHTML = state.items.map((item, index) => `
                <div style="display:flex; align-items:center; gap:8px; background:rgba(255,255,255,0.05); padding:8px; border-radius:8px;">
                    <input type="checkbox" id="item-cb-${index}" ${item.show ? 'checked' : ''} style="cursor:pointer;">
                    <div style="display:flex; flex-direction:column; flex:1; gap:4px;">
                        <input type="text" id="item-name-${index}" value="${item.name}" placeholder="Tên..." style="background:transparent; border:1px solid rgba(255,255,255,0.2); color:#fff; padding:4px; border-radius:4px; font-size:12px;">
                        <input type="text" id="item-desc-${index}" value="${item.desc}" placeholder="Mô tả..." style="background:transparent; border:1px solid rgba(255,255,255,0.2); color:rgba(255,255,255,0.6); padding:4px; border-radius:4px; font-size:11px;">
                    </div>
                </div>
            `).join('');
        }
    }

    // 2. Update HUD Visibility
    const hud = document.getElementById('hud');
    if (hud) {
        hud.style.display = state.show ? 'block' : 'none';
    }

    // 3. Update the 6 items in the overlay/printer view
    const ul = document.querySelector('.menu-board ul');
    if (ul && state.items) {
        const lis = ul.querySelectorAll('li');
        state.items.forEach((item, index) => {
            if (lis[index]) {
                lis[index].style.display = item.show ? 'flex' : 'none';
                const nameEl = lis[index].querySelector('.tier-name');
                if (nameEl) nameEl.textContent = item.name;
                const descEl = lis[index].querySelector('.tier-desc');
                if (descEl) descEl.textContent = item.desc;
            }
        });
    }
});

socket.on('print_ticket', (data) => {
    // Log
    if (data.type === 'gift') {
        logEvent('gift', `🎁 ${data.username} đã tặng ${data.giftName} x${data.repeatCount} (${data.diamondCount}💎)`);
        marqueeText.textContent = `🎁 WOW! ${data.username} đã tặng ${data.giftName} x${data.repeatCount}!`;

        if (data.tier === 1) { stats.normal += 1; if(countNormal) countNormal.textContent = stats.normal; }
        else if (data.tier === 2) { stats.vip += 1; if(countVip) countVip.textContent = stats.vip; }
        else if (data.tier === 3) { stats.superVip += 1; if(countSuperVipElements) countSuperVipElements.forEach(el => el.textContent = stats.superVip); }

    } else if (data.type === 'join') {
        logEvent('join', `👋 ${data.username} đã vào live`);
        marqueeText.textContent = `👋 Chào mừng ${data.username} đến với phiên Live!`;
    } else if (data.type === 'chat') {
        logEvent('chat', `💬 ${data.username}: ${data.comment || ''}`);
    }

    // Trigger print
    try {
        Printer.printTicket(data);
    } catch (e) {
        console.error('Printer not initialized', e);
    }
});

// ════════════════════════════════════
// COPY OVERLAY URL
// ════════════════════════════════════
function copyOverlayUrl() {
    const url = document.getElementById('overlay-url').textContent;
    navigator.clipboard.writeText(url).then(() => {
        const btn = document.getElementById('copy-btn');
        btn.textContent = '✅ Đã sao chép!';
        btn.style.color = '#4ade80';
        btn.style.borderColor = 'rgba(74,222,128,0.3)';
        setTimeout(() => {
            btn.textContent = '📋 Sao chép';
            btn.style.color = '#60a5fa';
            btn.style.borderColor = 'rgba(96,165,250,0.2)';
        }, 2000);
    }).catch(() => {
        // fallback
        const el = document.getElementById('overlay-url');
        const range = document.createRange();
        range.selectNode(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
    });
}

const obsTtsToggle = document.getElementById('obs-tts-toggle');
if (obsTtsToggle) {
    // Hiển thị đúng địa chỉ máy chủ đang chạy (localhost hoặc tên miền Render)
    document.getElementById('overlay-url').textContent =
        location.origin + '/overlay.html' + (obsTtsToggle.checked ? '?tts=true' : '');
    // Cập nhật luôn trạng thái TTS cho trang quản lý (Dashboard)
    if (typeof Printer !== 'undefined') {
        Printer.enableTTS = obsTtsToggle.checked;
    }

    obsTtsToggle.addEventListener('change', (e) => {
        const urlEl = document.getElementById('overlay-url');
        if (e.target.checked) {
            urlEl.textContent = location.origin + '/overlay.html?tts=true';
        } else {
            urlEl.textContent = location.origin + '/overlay.html';
        }
        
        if (typeof Printer !== 'undefined') {
            Printer.enableTTS = e.target.checked;
        }
    });
}

const dashboardSoundToggle = document.getElementById('dashboard-sound-toggle');
if (dashboardSoundToggle) {
    // Mặc định tắt tiếng trên Dashboard để tránh vọng âm
    if (typeof Printer !== 'undefined') {
        Printer.isMuted = !dashboardSoundToggle.checked;
    }
    dashboardSoundToggle.addEventListener('change', (e) => {
        if (typeof Printer !== 'undefined') {
            Printer.isMuted = !e.target.checked;
        }
    });
}

// ════════════════════════════════════
// PAPER CURL TIP — follow bottom of paper roll
// ════════════════════════════════════
(function trackCurlTip() {
    const paperRoll = document.getElementById('paper-roll');
    const curlTip   = document.querySelector('.paper-curl-tip');
    if (!paperRoll || !curlTip) return;

    function updateCurl() {
        const container = paperRoll.closest('.main-container');
        if (!container) return;

        const rollRect      = paperRoll.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const scale         = containerRect.width / 1080; // how much the container is scaled

        // Bottom of paper roll relative to container (in scaled px)
        const rollBottomScaled = rollRect.bottom - containerRect.top;
        // Convert to unscaled 1080-space
        const rollBottomPx = rollBottomScaled / scale;

        // Clamp: don't go outside the container (1920px height)
        const clampedBottom = Math.max(0, Math.min(1920, 1920 - rollBottomPx - 36));

        curlTip.style.bottom = clampedBottom + 'px';
        curlTip.style.top    = 'auto';
    }

    // Update whenever a ticket is printed (MutationObserver)
    const observer = new MutationObserver(updateCurl);
    observer.observe(paperRoll, { childList: true, subtree: true });

    // Also update periodically for smooth tracking
    setInterval(updateCurl, 500);
    updateCurl();
})();

// ════════════════════════════════════
// BACKGROUND MUSIC CONTROLS
// ════════════════════════════════════
function extractYoutubeId(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|&v=)([^#&?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

function playYoutubeMusic() {
    const linkInput = document.getElementById('youtube-link-input');
    const url = linkInput.value.trim();
    if (!url) {
        alert("Vui lòng nhập link YouTube!");
        return;
    }
    const videoId = extractYoutubeId(url);
    if (!videoId) {
        alert("Link YouTube không hợp lệ!");
        return;
    }
    
    socket.emit('set_music', { type: 'youtube', videoId: videoId });
    showMsg('Đã gửi lệnh phát nhạc YouTube!', 'ok');
}

function playLocalMp3() {
    const fileInput = document.getElementById('mp3-file-input');
    if (!fileInput.files || fileInput.files.length === 0) {
        alert("Vui lòng chọn file MP3!");
        return;
    }
    const file = fileInput.files[0];
    
    // Check file size limit (e.g. 15MB max)
    if (file.size > 15 * 1024 * 1024) {
        alert("File quá lớn! Vui lòng chọn file dưới 15MB.");
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        socket.emit('set_music', { type: 'mp3', dataUrl: e.target.result });
        showMsg('Đã gửi nhạc MP3 lên overlay!', 'ok');
    };
    reader.onerror = function() {
        alert("Lỗi khi đọc file!");
    };
    reader.readAsDataURL(file);
}

function stopBackgroundMusic() {
    socket.emit('set_music', { type: 'stop' });
    showMsg('Đã dừng nhạc nền.', 'ok');
}


// ================================================================
// TEST CONTROLS
// ================================================================
function simulateTestEvent(type) {
    socket.emit('test_event', type);
}

// ================================================================
// LEADERBOARD CONTROLS
// ================================================================
function updateBoardConfig() {
    const isChecked = document.getElementById('toggle-board-cb').checked;
    socket.emit('update_board_state', { show: isChecked });
}

function applyBoardConfig() {
    const configContainer = document.getElementById('board-items-config');
    if (!configContainer) return;
    
    const items = [];
    for (let i = 0; i < 6; i++) {
        const cb = document.getElementById(`item-cb-${i}`);
        const nameInput = document.getElementById(`item-name-${i}`);
        const descInput = document.getElementById(`item-desc-${i}`);
        if (cb && nameInput && descInput) {
            items.push({
                id: i,
                show: cb.checked,
                name: nameInput.value.trim(),
                desc: descInput.value.trim()
            });
        }
    }
    
    socket.emit('update_board_state', { items: items });
    alert('Đã lưu cài đặt bảng vinh danh!');
}

// ════════════════════════════════════
// LIVE CLOCK SETTINGS
// ════════════════════════════════════
const CLOCK_ZONES = [
    ['local', 'Giờ của máy tính này'],
    ['Asia/Ho_Chi_Minh', 'Việt Nam — TP. Hồ Chí Minh / Hà Nội'],
    ['America/Los_Angeles', 'Mỹ — Thái Bình Dương (Los Angeles)'],
    ['America/Denver', 'Mỹ — Miền núi (Denver)'],
    ['America/Chicago', 'Mỹ — Miền Trung (Chicago)'],
    ['America/New_York', 'Mỹ — Miền Đông (New York)'],
    ['America/Toronto', 'Canada — Toronto'],
    ['America/Vancouver', 'Canada — Vancouver'],
    ['America/Mexico_City', 'Mexico — Thành phố Mexico'],
    ['America/Sao_Paulo', 'Brazil — São Paulo'],
    ['Europe/London', 'Anh — London'],
    ['Europe/Paris', 'Pháp — Paris'],
    ['Europe/Berlin', 'Đức — Berlin'],
    ['Europe/Madrid', 'Tây Ban Nha — Madrid'],
    ['Europe/Rome', 'Ý — Rome'],
    ['Europe/Moscow', 'Nga — Moscow'],
    ['Asia/Dubai', 'UAE — Dubai'],
    ['Asia/Kolkata', 'Ấn Độ'],
    ['Asia/Bangkok', 'Thái Lan — Bangkok'],
    ['Asia/Jakarta', 'Indonesia — Jakarta'],
    ['Asia/Singapore', 'Singapore'],
    ['Asia/Manila', 'Philippines — Manila'],
    ['Asia/Hong_Kong', 'Hồng Kông'],
    ['Asia/Taipei', 'Đài Loan — Đài Bắc'],
    ['Asia/Shanghai', 'Trung Quốc — Thượng Hải'],
    ['Asia/Seoul', 'Hàn Quốc — Seoul'],
    ['Asia/Tokyo', 'Nhật Bản — Tokyo'],
    ['Australia/Perth', 'Úc — Perth'],
    ['Australia/Sydney', 'Úc — Sydney'],
    ['Pacific/Auckland', 'New Zealand — Auckland'],
];

(function initClockSettingsUI() {
    const select = document.getElementById('clock-tz-select');
    if (!select) return;
    CLOCK_ZONES.forEach(([value, label]) => {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    });

    socket.on('clock_settings', (s) => {
        if (!s) return;
        // Zone saved earlier but not in the list — add it so it still shows
        if (![...select.options].some(o => o.value === s.timeZone)) {
            const opt = document.createElement('option');
            opt.value = opt.textContent = s.timeZone;
            select.appendChild(opt);
        }
        select.value = s.timeZone;
        document.getElementById('clock-show-cb').checked = s.show !== false;
        document.getElementById('clock-12h-cb').checked = !!s.hour12;
    });

    setInterval(() => {
        const preview = document.getElementById('clock-preview');
        const live = document.getElementById('live-clock');
        if (preview && live) preview.textContent = live.textContent;
    }, 500);
})();

function saveClockSettings() {
    socket.emit('update_clock_settings', {
        show: document.getElementById('clock-show-cb').checked,
        timeZone: document.getElementById('clock-tz-select').value,
        hour12: document.getElementById('clock-12h-cb').checked
    });
    showMsg('Đã lưu cài đặt đồng hồ.', 'ok');
}
