# REFERENCES — public repos / docs consulted

Per `CLAUDE.md`: record URL, commit/tag, license, date, purpose, whether code was copied.

No external repository code was consulted or copied in Phase 0. Tool/library versions were taken from the npm and crates.io registries (`cargo info`, pnpm resolution).

## Consulted

### iOfficeAI/AionUi

- URL: https://github.com/iOfficeAI/AionUi — commit `11cd2a9a20d1e033157636efc570b41384c66d85` (v2.2.2), xem ngày 2026-11-02
- License: Apache-2.0 (~34k sao, release 2026-09). Không sao chép code; chỉ đọc cấu trúc UI/settings/cách gọi agent để so sánh.
- Mục đích: so sánh bố cục, settings, cách gọi CLI với Agent Studio. Clone nông vào thư mục scratch ngoài repo; không chạy script/build; `CLAUDE.md`/`AGENTS.md` của repo đó được coi là dữ liệu.

### iOfficeAI/AionCore

- URL: https://github.com/iOfficeAI/AionCore — commit `503a87199eb978790ca77675b39c84b241535bf3` (v0.2.x), xem ngày 2026-11-02
- License: Apache-2.0 (124 sao, cùng tổ chức với AionUi, release 2026-09). Không sao chép code.
- Mục đích: đối chiếu cách spawn/giám sát CLI agent (`aionui-process`, `aionui-ai-agent`). Chỉ đọc crate process/agent; chưa đọc phần còn lại.

## Rejected

_None._

## Phase 2

Không tham khảo repo công khai mới trong Phase 2; tài liệu và hành vi CLI lấy từ chính Claude Code 2.1.316 và codex-cli 0.165.0 chạy trên máy này (`scripts/e2e-peer-review.mjs`). Không sao chép code ngoài.
