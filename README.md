# TikTok Live Printer — bản chạy trên Render.com

Máy in giấy hiển thị quà tặng / bình luận / người vào live theo thời gian thực.
`server.js` là máy chủ viết lại bằng JavaScript thường (thay cho `server.jsc`), giao diện nằm trong `public/`.

## 1. Đưa lên Render

1. Tạo repo GitHub, đẩy **toàn bộ thư mục này** lên (không cần `node_modules`, `runtime`).
2. Render → **New +** → **Blueprint** → chọn repo (dùng `render.yaml`), hoặc **Web Service** với:
   - Build Command: `npm install --omit=dev`
   - Start Command: `node server.js`
   - Health Check Path: `/healthz`
3. Tab **Environment**, đặt:

| Biến | Bắt buộc | Ý nghĩa |
|---|---|---|
| `ADMIN_PASSWORD` | **Nên có** | Mật khẩu vào bảng điều khiển (tên đăng nhập `admin`, đổi bằng `ADMIN_USER`). Không đặt = ai có link cũng điều khiển được. |
| `SIGN_API_KEY` | Tùy chọn | Khóa Euler Stream. Nên có nếu TikTok chặn IP máy chủ (lỗi "không lấy được phòng LIVE"). |
| `TIER2_MIN` / `TIER3_MIN` | Tùy chọn | Kim cương của **1 quà** để tính VIP / Super VIP (mặc định 5 / 30). |

## 2. Cách dùng

- Bảng điều khiển: `https://TÊN-DỊCH-VỤ.onrender.com` → nhập ID TikTok → **Kết nối**.
- Overlay cho OBS / TikTok LIVE Studio: `https://TÊN-DỊCH-VỤ.onrender.com/overlay.html?tts=true` (1080 x 1920).
  Link này hiển thị sẵn trong bảng điều khiển, bấm "Sao chép".
- Nút **Thử nghiệm** trong bảng điều khiển để kiểm tra overlay khi chưa live.
- Unity (tùy chọn): kết nối WebSocket tới `wss://TÊN-DỊCH-VỤ.onrender.com/unity`.

## 3. Lưu ý khi chạy trên Render

- **Gói Free sẽ "ngủ"** sau ~15 phút không có yêu cầu HTTP, lúc đó mất kết nối TikTok. Dùng gói trả phí để chạy ổn định lúc live,
  hoặc dùng dịch vụ ping (vd UptimeRobot) gọi `/healthz` mỗi 5 phút.
- Ổ đĩa của Render là tạm thời: cài đặt bảng vinh danh/đồng hồ có thể về mặc định sau mỗi lần deploy/restart.
- Server không có cổng TCP riêng (Render chỉ mở cổng HTTP), nên "Unity TCP" luôn hiện "–"; dùng Unity WebSocket thay thế.

## 4. Chạy thử trên máy

```
npm install
npm start          # http://localhost:3000
npm test           # bộ test tự động (không cần Internet)
```
