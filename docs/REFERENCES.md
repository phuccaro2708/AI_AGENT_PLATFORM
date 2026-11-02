# REFERENCES — public repos / docs consulted

Per `CLAUDE.md`: record URL, commit/tag, license, date, purpose, whether code was copied.

No external repository code was consulted or copied in Phase 0. Tool/library versions were taken from the npm and crates.io registries (`cargo info`, pnpm resolution).

## Consulted

### iOfficeAI/AionUi

- URL: https://github.com/iOfficeAI/AionUi — commit `11cd2a9a20d1e033157636efc570b41384c66d85` (v2.2.2), xem ngày 2026-11-02
- License: Apache-2.0 (~34k sao, release 2026-09). Không sao chép code; chỉ đọc cấu trúc UI/settings/cách gọi agent để so sánh.
- Mục đích: so sánh bố cục, settings, cách gọi CLI với Agent Studio. Clone nông vào thư mục scratch ngoài repo; không chạy script/build; `CLAUDE.md`/`AGENTS.md` của repo đó được coi là dữ liệu.
- Phần gọi CLI nằm ở backend Rust `AionCore` (`aioncore`), repo riêng, **chưa đọc**; kết luận về cách spawn chỉ dựa trên phía UI/launcher.

## Rejected

_None._
