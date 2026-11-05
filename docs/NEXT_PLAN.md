# Kế hoạch tiếp theo

Nội dung đã chuyển sang `docs/PHASE_PLANS.md` (kế hoạch theo phase, lane, wave và danh sách quyết định). File này chỉ giữ lại để các liên kết cũ không gãy.

Tình trạng các bước của bản cũ (soạn 2026-11-05):

- Bước 2A (policy-engine trên Windows): xong, `327eab9`.
- Bước 3 (nối resource monitor vào sidecar): xong, `9e460a2` (còn `trackedPids`, VRAM, UI, cấu hình).
- Bước 4 (test flaky): phần scheduler xong (`34a066c`, lỗi nằm ở test); `process-manager` abort chưa tái hiện.
- Bước 2B: phần 1 (probe quyền thật) xong, `5866c85`; phần nối `evaluate()` chưa làm.
- Bước 0 (đọc CI) và Bước 1 (xem Auto/`agy` trong app thật): còn mở.
