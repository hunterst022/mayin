const Printer = {
    paperRoll: document.getElementById('paper-roll'),
    printSound: new Audio('assets/printer-sound.mp3'),
    maxTickets: 8,
    // TTS Properties
    ttsQueue: [],
    isSpeaking: false,
    enableTTS: false,
    isMuted: false,

    showGiftNotification(innerHTML) {
        const container = document.getElementById('gift-notification-container');
        if (!container) return;

        const notif = document.createElement('div');
        // Kế thừa style của ticket và thêm animation notification
        notif.className = 'ticket notification-ticket';
        notif.innerHTML = innerHTML;

        // Dọn dẹp thẻ cũ đã có class slide-down-out
        const oldNotifs = container.querySelectorAll('.slide-down-out');
        oldNotifs.forEach(el => el.remove());

        // Giữ lại các thẻ (lùi xuống), giới hạn hiển thị tối đa 3 thẻ để không bị tràn
        const currentNotifs = container.querySelectorAll('.notification-ticket:not(.slide-down-out)');
        if (currentNotifs.length >= 3) {
            // Thẻ cũ nhất (ở cuối danh sách) sẽ bị xóa
            const oldest = currentNotifs[currentNotifs.length - 1];
            oldest.classList.add('slide-down-out');
            setTimeout(() => {
                if (oldest.parentNode) oldest.remove();
            }, 500);
        }

        // Chèn thẻ mới lên ĐẦU danh sách (những thẻ cũ sẽ tự động bị đẩy xuống dưới)
        container.prepend(notif);

        // Tự động xóa sau 15 giây nếu không bị đè
        setTimeout(() => {
            if (notif.parentNode && !notif.classList.contains('slide-down-out')) {
                notif.classList.add('slide-down-out');
                setTimeout(() => {
                    if (notif.parentNode) notif.remove();
                }, 500);
            }
        }, 15000);
    },

    init() {
        this.printSound.volume = 0.2;

        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('tts') === 'true') {
            this.enableTTS = true;
        }
        if (urlParams.get('glow') === '0') {
            const mc = document.querySelector('.main-container');
            if (mc) mc.classList.add('no-glow');
        }

        // Khởi động watchdog ngay khi init
        this.startWatchdog();
    },

    // ════════════════════════════════════════════════════════════════
    // WATCHDOG — Chạy mỗi 3 giây, tự reset isSpeaking nếu bị kẹt.
    // Đây là lớp bảo vệ cuối cùng — không cần F5 hay restart.
    // ════════════════════════════════════════════════════════════════
    startWatchdog() {
        this._speakStartTime = 0;
        setInterval(() => {
            if (!this.isSpeaking) {
                this._speakStartTime = 0;
                return;
            }
            if (this._speakStartTime === 0) {
                this._speakStartTime = Date.now();
                return;
            }
            const elapsed = Date.now() - this._speakStartTime;
            if (elapsed > 10000) { // 10 giây không xong → reset
                console.warn(`[TTS Watchdog] Stuck for ${elapsed}ms → auto reset!`);
                this.isSpeaking = false;
                this._speakStartTime = 0;
                setTimeout(() => this.speakNext(), 100);
            }
        }, 3000);
    },

    speakNext() {
        if (this.isSpeaking || this.ttsQueue.length === 0 || !this.enableTTS) return;

        const item = this.ttsQueue[0];

        // Nếu audio chưa được tạo (preload chưa kịp), tạo ngay tại đây
        if (!item.audio) {
            item.audio = new Audio(item.url);
            item.audio.volume = 1.0;
            item.audio.preload = 'auto';
            item.audio.load();
        }

        const audio = item.audio;

        // Nếu audio chưa load đủ data, đợi sự kiện canplay rồi thử lại
        if (audio.readyState < 2) {
            audio.addEventListener('canplay', () => this.speakNext(), { once: true });
            // Phòng trường hợp canplay không fire (mạng chết): skip sau 4s
            setTimeout(() => {
                if (!this.isSpeaking && this.ttsQueue.length > 0 && this.ttsQueue[0] === item) {
                    console.warn('[TTS] Item load timeout (4s), skip:', item.text?.substring(0, 30));
                    this.ttsQueue.shift();
                    this.speakNext();
                }
            }, 4000);
            return;
        }

        // Chiếm lock + ghi thời điểm để watchdog theo dõi
        this.isSpeaking = true;
        this._speakStartTime = Date.now();
        this.ttsQueue.shift();

        // Preload các câu tiếp theo ngay lúc này
        this.preloadNextAudios();

        // Xử lý tốc độ đọc: Tốc độ 1.15x để giọng có năng lượng và đọc nhanh hơn.
        // Chỉ khi hàng đợi quá dài mới tăng nhẹ tốc độ lên 1.3x để dọn dẹp.
        if (this.ttsQueue.length > 5) {
            audio.playbackRate = 1.3; 
            audio.preservesPitch = true;
        } else {
            audio.playbackRate = 1.15; 
        }
        
        let finished = false;

        const done = () => {
            if (finished) return;
            finished = true;
            this.isSpeaking = false;
            this._speakStartTime = 0;
            setTimeout(() => this.speakNext(), 50);
        };

        const fallback = (reason) => {
            console.warn(`[TTS] Skip (${reason}):`, item.text?.substring(0, 40));
            try { audio.pause(); } catch (e) { }
            done();
        };

        // Timeout 8s — đủ cho câu dài nhất, đủ nhanh để tự phục hồi
        const timeoutId = setTimeout(() => fallback('timeout 8s'), 8000);

        audio.onended = () => { clearTimeout(timeoutId); done(); };
        audio.onerror = (e) => { clearTimeout(timeoutId); fallback('audio error ' + e.type); };
        audio.play().catch(e => { clearTimeout(timeoutId); fallback('autoplay: ' + e.message); });
    },

    preloadNextAudios() {
        let loadCount = 0;
        for (let i = 0; i < this.ttsQueue.length; i++) {
            if (loadCount >= 3) break;
            const item = this.ttsQueue[i];
            if (!item.audio) {
                item.audio = new Audio(item.url);
                item.audio.volume = 1.0;
                item.audio.preload = 'auto';
                item.audio.load();
                item.audio.onerror = () => { item.audio = null; }; // reset nếu load lỗi
            }
            loadCount++;
        }
    },

    speakText(text, voice = 'vi') {
        if (!this.enableTTS || this.isMuted) return;
        if (!text || text.trim() === '') return;

        // Hard cap: tối đa 30 câu. Câu dài bị drop trước, câu ngắn được ưu tiên.
        if (this.ttsQueue.length >= 30) {
            if (text.length > 60) {
                console.warn('[TTS] Queue full, dropping long line:', text.substring(0, 30));
                return;
            }
            // Câu ngắn (cảm ơn nhanh) → pop câu dài cuối để nhường chỗ
            this.ttsQueue.pop();
        }

        const encodedText = encodeURIComponent(text.substring(0, 200));
        const ttsUrl = `/api/tts?text=${encodedText}&voice=${voice}`;

        // Đã có bộ lọc chống lặp API ở server, nên cứ nhận lệnh là đưa vào hàng đợi
        this.ttsQueue.push({ text, voice, url: ttsUrl, audio: null });
        this.preloadNextAudios();
        this.speakNext();
    },

    playSound() {
        if (this.isMuted) return;
        const soundClone = this.printSound.cloneNode();
        soundClone.volume = 0.4;
        soundClone.play().catch(e => console.log('Audio play blocked:', e));
    },

    printTicket(data) {
        this.playSound();

        // ── TTS: Gift (ưu tiên cao, luôn đọc) ──
        if (data.type === 'gift') {
            let text = data.ttsText;
            let voice = data.ttsVoice || 'vi';

            // Queue bận → đọc cực ngắn, đa dạng để không bị lặp
            if (this.ttsQueue.length > 4) {
                const quickReplies = [
                    `Cảm ơn ${data.username}!`,
                    `${data.username}, bạn đỉnh quá!`,
                    `Cảm ơn bạn nhiều, ${data.username}!`,
                    `${data.username}, bạn tuyệt vời lắm!`,
                    `Ôi, cảm ơn ${data.username} nha!`,
                ];
                text = quickReplies[Math.floor(Math.random() * quickReplies.length)];
                voice = 'vi';
            }

            this.speakText(text, voice);

            // ── TTS: Join (ưu tiên thấp, chỉ đọc khi AI rảnh) ──
        } else if (data.type === 'join') {
            if (!this.isSpeaking && this.ttsQueue.length === 0) {
                // Dùng câu được server tạo sẵn (đã đa dạng hoá), fallback nếu không có
                const joinText = data.ttsText || `Chào mừng ${data.username} đến với phiên live!`;
                this.speakText(joinText, data.ttsVoice || 'vi');
            }
        } else if (data.type === 'chat' && data.ttsText) {
            // ── TTS: Chat đặc biệt (chào hỏi) ──
            // Chỉ đọc chào hỏi nếu AI đang hoàn toàn rảnh (ưu tiên nhường chỗ cho quà)
            // và giảm tần suất chào lại xuống 50% để không bị spam
            if (!this.isSpeaking && this.ttsQueue.length === 0 && Math.random() < 0.5) {
                this.speakText(data.ttsText, data.ttsVoice || 'vi');
            }
        }
        // Chat bình thường: không đọc TTS

        const ticket = document.createElement('div');
        ticket.className = 'ticket';

        let innerHTML = '';

        // Use a default avatar if none is provided
        const avatarUrl = data.profilePictureUrl || ('https://ui-avatars.com/api/?name=' + encodeURIComponent(data.username || 'U'));
        const name = data.username || 'Ẩn danh';
        const uniqueId = '@' + (name.toLowerCase().replace(/\s+/g, '') + Math.floor(Math.random() * 100)); // Fake ID if not provided

        if (data.tier === 0) {
            ticket.classList.add('ticket-tier0');
            const isChat = data.type === 'chat';
            const icon = isChat ? '💬' : '👋';
            const actionText = isChat ? data.comment : 'Đã vào phiên Live!';
            const themeClass = isChat ? 't0-chat' : 't0-join';

            innerHTML = `
                <div class="t0-card ${themeClass}">
                    <div class="t0-avatar-wrap">
                        <img src="${avatarUrl}" class="t0-avatar" alt="Avatar" onerror="this.onerror=null;this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name)}'">
                    </div>
                    <div class="t0-content">
                        <div class="t0-name">${name} <span class="t0-icon">${icon}</span></div>
                        <div class="t0-text">${actionText}</div>
                    </div>
                </div>
            `;
        }
        else if (data.tier === 1) {
            ticket.classList.add('ticket-tier1');
            innerHTML = `
                <div class="t1-card">
                    <div class="t1-sparkle">✨</div>
                    <div class="t1-avatar-wrap">
                        <img src="bieutuong/player-wings.png" class="t1-wings" alt="Wings" onerror="this.style.display='none'">
                        <img src="${avatarUrl}" class="t1-avatar" alt="Avatar" onerror="this.onerror=null;this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name)}'">
                    </div>
                    <div class="t1-info">
                        <div class="t1-name">${name}</div>
                        <div class="t1-gift-row">
                            <span class="t1-count">${data.repeatCount || 1} ${data.giftName || 'Hoa hồng'}</span>
                        </div>
                    </div>
                </div>
            `;
        }
        else if (data.tier === 2) {
            ticket.classList.add('ticket-vip');
            innerHTML = `
                <div class="vip-card">
                    <div class="vip-sparkles">✨ ❄️ ✨</div>
                    <div class="vip-avatar-wrap">
                        <img src="bieutuong/wings-ice.png" class="vip-wings" alt="Wings" onerror="this.style.display='none'">
                        <div class="vip-ring-1"></div>
                        <div class="vip-ring-2"></div>
                        <img src="${avatarUrl}" class="vip-avatar" alt="Avatar" onerror="this.onerror=null;this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name)}'">
                    </div>
                    <div class="vip-info">
                        <div class="vip-label">VIP</div>
                        <div class="vip-player-name">${name}</div>
                        <div class="vip-thanks">
                            <span class="vip-gift-highlight">${data.repeatCount || 1} ${data.giftName || 'Quà'}</span>
                        </div>
                    </div>
                </div>
            `;
        }
        else if (data.tier === 3) {
            ticket.classList.add('ticket-super-vip');
            innerHTML = `
                <div class="svip-card">
                    <div class="svip-sparkles">🔥 ✨ 👑 ✨ 🔥</div>
                    
                    <div class="svip-badge-wrap">
                        <img src="bieutuong/wings-fire.png" class="svip-wings" alt="Wings" onerror="this.style.display='none'">
                        <div class="svip-sunburst"></div>
                        <div class="svip-ring-outer"></div>
                        <img src="${avatarUrl}" class="svip-avatar-img" alt="Avatar" onerror="this.onerror=null;this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(name)}'">
                    </div>
                    
                    <div class="svip-label">SUPER VIP</div>
                    <div class="svip-player-name">${name}</div>
                    
                    <div class="svip-thanks">
                        <span class="svip-gift-highlight">${data.repeatCount || 1} ${data.giftName || 'Bánh vòng'}</span>
                    </div>
                </div>
            `;
        }

        ticket.innerHTML = innerHTML;

        // Prepend directly to container to get accurate layout calculations
        this.paperRoll.prepend(ticket);

        // Force synchronous layout calculation
        const ticketHeight = ticket.offsetHeight;

        // Lấy vị trí Y hiện tại của paperRoll (để xử lý trường hợp in liên tục)
        const computedStyle = window.getComputedStyle(this.paperRoll);
        let currentY = 0;
        if (computedStyle.transform !== 'none') {
            const matrix = new DOMMatrix(computedStyle.transform);
            currentY = matrix.m42;
        }

        // Tắt transition, dịch toàn bộ cuộn giấy lên trên (bằng vị trí hiện tại trừ chiều cao ticket mới)
        this.paperRoll.style.transition = 'none';
        const newY = currentY - ticketHeight;
        this.paperRoll.style.transform = `translate3d(0, ${newY}px, 0)`;

        // Force reflow để trình duyệt ghi nhận transform mới
        void this.paperRoll.offsetHeight;

        // Bật lại animation và trượt mượt mà về 0
        this.paperRoll.style.transition = 'transform 0.65s cubic-bezier(0.22, 1, 0.36, 1)';
        this.paperRoll.style.transform = 'translate3d(0, 0px, 0)';

        // HIỂN THỊ NOTIFICATION BÊN PHẢI (CHỈ QUÀ TẶNG)
        if (data.type === 'gift') {
            this.showGiftNotification(ticket.innerHTML);
        }

        this.cleanup();
    },

    cleanup() {
        const tickets = this.paperRoll.querySelectorAll('.ticket');
        if (tickets.length > this.maxTickets) {
            for (let i = this.maxTickets; i < tickets.length; i++) {
                this.paperRoll.removeChild(tickets[i]);
            }
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    Printer.init();
});

