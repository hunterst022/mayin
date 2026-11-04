/**
 * Multi-Layer Particle Mask System
 * Mục đích: Làm nhiễu ảnh động để tránh các thuật toán nhận diện ảnh tĩnh của TikTok.
 * Kỹ thuật:
 *   1. Hạt bụi trắng ngẫu nhiên (di chuyển)
 *   2. Tia sáng len lỏi (đường thẳng mờ xuyên màn hình)
 *   3. Hạt màu ngẫu nhiên nhỏ (tạo noise màu sắc)
 *   4. Micro-jitter ngẫu nhiên mỗi frame (thay đổi opacity toàn canvas nhẹ)
 */
class ParticleSystem {
    constructor(canvasId) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) return;
        this.ctx = this.canvas.getContext('2d');
        
        // Layer 1: Hạt bụi trắng
        this.dustParticles = [];
        // Layer 2: Tia sáng
        this.lightRays = [];
        // Layer 3: Hạt màu nhỏ (color noise)
        this.colorDots = [];
        
        this.frameCount = 0;
        
        this.resize();
        window.addEventListener('resize', () => this.resize());
        
        this.initDust();
        this.initRays();
        this.initColorDots();
        this.animate();
    }

    resize() {
        const container = this.canvas.parentElement;
        // Kích thước "logic" (px của container); canvas vẽ ở nửa độ phân giải.
        // Hạt vốn mờ nên hình không khác, nhưng nhẹ hơn ~4 lần.
        this.S = 0.5;
        this.W = container.clientWidth  || window.innerWidth;
        this.H = container.clientHeight || window.innerHeight;
        this.canvas.width  = Math.round(this.W * this.S);
        this.canvas.height = Math.round(this.H * this.S);
        this.ctx.setTransform(this.S, 0, 0, this.S, 0, 0); // vẽ theo toạ độ logic
        // Reinit sau khi resize để fill đúng canvas mới
        this.initDust();
        this.initRays();
        this.initColorDots();
    }

    // Layer 1: Hạt bụi nhỏ bay
    initDust() {
        this.dustParticles = [];
        const count = 60;
        for (let i = 0; i < count; i++) {
            this.dustParticles.push(this.createDust());
        }
    }

    createDust() {
        return {
            x: Math.random() * this.W,
            y: Math.random() * this.H,
            size: Math.random() * 2.5 + 0.5,
            speedX: (Math.random() - 0.5) * 0.8,
            speedY: (Math.random() - 0.5) * 0.8,
            opacity: Math.random() * 0.35 + 0.05,
            // Màu ngẫu nhiên: trắng hoặc màu nhạt
            hue: Math.floor(Math.random() * 360),
            colorChance: Math.random() // < 0.3 thì dùng màu, còn lại trắng
        };
    }

    drawDust() {
        this.dustParticles.forEach(p => {
            p.x += p.speedX;
            p.y += p.speedY;
            // Wrap around
            if (p.x < 0) p.x = this.W;
            if (p.x > this.W) p.x = 0;
            if (p.y < 0) p.y = this.H;
            if (p.y > this.H) p.y = 0;

            this.ctx.beginPath();
            this.ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
            if (p.colorChance < 0.3) {
                this.ctx.fillStyle = `hsla(${p.hue}, 70%, 80%, ${p.opacity})`;
            } else {
                this.ctx.fillStyle = `rgba(255, 255, 255, ${p.opacity})`;
            }
            this.ctx.fill();
        });
    }

    // Layer 2: Tia sáng len lỏi (light streak)
    initRays() {
        this.lightRays = [];
        for (let i = 0; i < 4; i++) {
            this.lightRays.push(this.createRay());
        }
    }

    createRay() {
        return {
            x: Math.random() * this.W,
            y: 0,
            length: Math.random() * 200 + 100,
            angle: Math.PI / 2 + (Math.random() - 0.5) * 0.5,
            speed: Math.random() * 1.5 + 0.5,
            opacity: Math.random() * 0.06 + 0.01,
            width: Math.random() * 2 + 1,
            life: 0,
            maxLife: Math.random() * 120 + 60
        };
    }

    drawRays() {
        this.lightRays.forEach((r, i) => {
            r.life++;
            // Fade in / fade out
            const lifeRatio = r.life / r.maxLife;
            const fade = lifeRatio < 0.3 ? lifeRatio / 0.3 : lifeRatio > 0.7 ? (1 - lifeRatio) / 0.3 : 1;

            const endX = r.x + Math.cos(r.angle) * r.length;
            const endY = r.y + Math.sin(r.angle) * r.length;

            const grad = this.ctx.createLinearGradient(r.x, r.y, endX, endY);
            grad.addColorStop(0, `rgba(255,255,255,0)`);
            grad.addColorStop(0.5, `rgba(255,255,255,${r.opacity * fade})`);
            grad.addColorStop(1, `rgba(255,255,255,0)`);

            this.ctx.save();
            this.ctx.beginPath();
            this.ctx.moveTo(r.x, r.y);
            this.ctx.lineTo(endX, endY);
            this.ctx.strokeStyle = grad;
            this.ctx.lineWidth = r.width;
            this.ctx.stroke();
            this.ctx.restore();

            r.x += (Math.random() - 0.5) * 0.5;
            r.y += r.speed;

            // Spawn new ray when this one dies or leaves screen
            if (r.life >= r.maxLife || r.y > this.H) {
                this.lightRays[i] = this.createRay();
            }
        });
    }

    // Layer 3: Color noise dots (flash nhanh ngẫu nhiên)
    initColorDots() {
        this.colorDots = [];
        for (let i = 0; i < 15; i++) {
            this.colorDots.push(this.createColorDot());
        }
    }

    createColorDot() {
        return {
            x: Math.random() * this.W,
            y: Math.random() * this.H,
            size: Math.random() * 1.5 + 0.5,
            opacity: 0,
            maxOpacity: Math.random() * 0.2 + 0.05,
            flashSpeed: Math.random() * 0.05 + 0.02,
            phase: Math.random() * Math.PI * 2,
            hue: Math.floor(Math.random() * 360),
            // Mỗi dot tự thay đổi vị trí sau mỗi lần flash
            ttl: Math.floor(Math.random() * 60) + 30
        };
    }

    drawColorDots() {
        this.colorDots.forEach((d, i) => {
            d.ttl--;
            d.phase += d.flashSpeed;
            d.opacity = d.maxOpacity * (0.5 + 0.5 * Math.sin(d.phase));

            if (d.opacity > 0.01) {
                this.ctx.beginPath();
                this.ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
                this.ctx.fillStyle = `hsla(${d.hue}, 80%, 70%, ${d.opacity})`;
                this.ctx.fill();
            }

            if (d.ttl <= 0) {
                this.colorDots[i] = this.createColorDot();
            }
        });
    }

    animate() {
        this.ctx.clearRect(0, 0, this.W, this.H);
        this.frameCount++;

        this.drawDust();
        this.drawRays();
        this.drawColorDots();

        requestAnimationFrame(() => this.animate());
    }
}

// Khởi chạy khi DOM load xong
document.addEventListener('DOMContentLoaded', () => {
    if (document.getElementById('particle-canvas')) {
        new ParticleSystem('particle-canvas');
    }
});
