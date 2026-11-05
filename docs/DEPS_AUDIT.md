# DEPS_AUDIT — P4-11 (lane DEPS), 2026-11-05

Nguồn cho `SECURITY.md`. Mọi số liệu lấy từ lệnh thật chạy ngày 2026-11-05; ngày publish lấy từ npm registry / crates.io / `gh api`.

## 1. Kết quả audit

### `pnpm audit` — 2 cảnh báo moderate, 0 high/critical

| Gói                  | Advisory                                                        | Vulnerable      | Patched  | Đường phụ thuộc                                                                                | Quyết định    |
| -------------------- | --------------------------------------------------------------- | --------------- | -------- | ---------------------------------------------------------------------------------------------- | ------------- |
| `esbuild` (bản lồng) | GHSA-67mh-4wv8-2f99 (dev server nhận request từ website bất kỳ) | <=0.24.2        | >=0.25.0 | `packages/storage > drizzle-kit > @esbuild-kit/esm-loader > @esbuild-kit/core-utils > esbuild` | **CHẤP NHẬN** |
| `minimatch`          | GHSA-g3hv-75wg-m249 (DoS qua khuếch đại globparts)              | >=7.0.0 <11.0.1 | >=11.0.1 | `eslint > minimatch`                                                                           | **CHẤP NHẬN** |

Lý do:

- esbuild: chỉ nằm trong `drizzle-kit` (devDependency của `packages/storage`, dùng sinh migration). Lỗi chỉ xảy ra khi chạy `esbuild --serve` dev server; không bao giờ chạy trong app/sidecar phát hành. Bản esbuild gốc của repo là `0.28.2` (không bị ảnh hưởng). `drizzle-kit@0.31.11` (latest) vẫn kéo `@esbuild-kit/*` (đã deprecated), nên không có bản vá nâng được qua drizzle-kit. Phương án nếu muốn dứt điểm: `pnpm.overrides` ép esbuild >=0.25 (0.28.2 đã 89 ngày tuổi) cho nhánh này — CHƯA thử, có thể làm hỏng drizzle-kit; để người dùng quyết.
- minimatch: chỉ dùng bởi ESLint (devDependency, chạy trên mã của chính repo, không nhận glob từ nguồn không tin cậy). Bản vá `11.0.1` publish 2026-10-27 (9 ngày), 11.0.4 publish 2026-11-02 — **chưa đủ 2 tuần**; mốc đủ tuổi của 11.0.1 là 2026-11-10. Ngoài ra eslint@10.13.0 phụ thuộc dải minimatch cũ (`<11`), muốn vá phải đợi eslint nâng, hoặc ép override major — không làm ở đây.

### `cargo audit` (cargo-audit đã cài sẵn trên máy; advisory-db 1409 advisory; 424 crate) — 0 vulnerability, 2 warning

| Crate                    | Advisory          | Loại                                     | Đường phụ thuộc                                                     | Quyết định    |
| ------------------------ | ----------------- | ---------------------------------------- | ------------------------------------------------------------------- | ------------- |
| `proc-macro-error 1.0.4` | RUSTSEC-2024-0370 | unmaintained (proc-macro, chỉ lúc build) | `glib-macros 0.18.5` ← `glib` ← `gtk 0.18.2` ← `tauri`/`tao`/`muda` | **CHẤP NHẬN** |
| `glib 0.18.5`            | RUSTSEC-2024-0429 | unsound (`VariantStrIter`)               | `gtk 0.18.2` ← `tauri`/`tauri-runtime-wry`/`tao`/`muda`/`wry`       | **CHẤP NHẬN** |

Lý do: cả hai chỉ vào qua chồng GTK3 (`gtk-rs 0.18`) của Tauri cho Linux. `cargo tree --target x86_64-pc-windows-msvc` không chứa `glib` hay `proc-macro-error` (0 khớp) → **không được biên dịch/liên kết vào bản Windows**. Bản vá `glib >=0.20` hiện ở `0.22.10` (2026-09-19) nhưng `gtk 0.18` (GTK3) bị Tauri ghim ở `glib 0.18`; chỉ khi Tauri chuyển khỏi gtk3 mới bỏ được — không nâng được riêng lẻ. `proc-macro-error` không có bản mới (1.0.4, 2020). Cần xem lại nếu có build Linux.

## 2. Ghim GitHub Actions theo SHA (`.github/workflows/ci.yml`)

SHA lấy bằng `gh api repos/<r>/tags|commits`; giữ nguyên major v4 (không nhảy major). Tất cả ≥ 2 tuần tuổi.

| Action                  | Trước     | Sau (SHA đầy đủ)                                            | Ngày commit |
| ----------------------- | --------- | ----------------------------------------------------------- | ----------- |
| actions/checkout        | `@v4`     | `11d5960a326750d5838078e36cf38b85af677262` # v4.4.0         | 2026-07-16  |
| pnpm/action-setup       | `@v4`     | `fc06bc1257f339d1d5d8b3a19a8cae5388b55320` # v4.4.0         | 2026-03-13  |
| actions/setup-node      | `@v4`     | `49933ea5288caeca8642d1e84afbd3f7d6820020` # v4.4.0         | 2025-04-02  |
| actions/upload-artifact | `@v4`     | `ea165f8d65b6e75b540449e92b4886f43607fa02` # v4.6.2         | 2025-03-19  |
| dtolnay/rust-toolchain  | `@stable` | `b725eda525362e7cf34af9a7243cac1e3f01a7ec` # nhánh `stable` | 2026-10-16  |

Lưu ý: `dtolnay/rust-toolchain` không có tag phiên bản; "stable" là nhánh, nên SHA là ảnh chụp nhánh đó (hành vi cài toolchain `stable` giữ nguyên). Các action này có bản major mới hơn (checkout/setup-node/upload-artifact v6–v7); chưa nâng vì ngoài phạm vi. SHA là "tag v4.x.y trỏ tới" theo API tags, chưa xác minh chữ ký.

## 3. Tuổi và ghim chính xác của dependency hiện dùng

- npm: 23 gói trực tiếp (mọi `package.json`), **không có `^`/`~`/`*`/dải** (chỉ `engines.node >=22`). Gói mới nhất: eslint 10.13.0 (20 ngày), vitest 5.0.5 / react 19.3.1 / react-dom / @tauri-apps/api 2.12.4 / @tauri-apps/cli 2.12.3 (21 ngày). **Không gói nào < 14 ngày.**
- Cargo (ghim `=`): tauri 2.12.5 và tauri-build 2.7.4 (2026-10-21, 15 ngày), tauri-plugin-dialog 2.8.3 (2026-10-14), keyring-core 1.0.1 (2026-10-13), windows-native-keyring-store 1.1.0 (2026-05-24), windows-sys 0.61.2 (2025-10-06). **Không crate trực tiếp nào < 14 ngày.**
- **Không ghim chính xác trong Cargo.toml:** `serde = "1"`, `serde_json = "1"`. Bị khoá bởi `Cargo.lock` (serde 1.0.229 — 2026-07-18; serde_json 1.0.154 — 2026-10-11, cả hai ≥ 2 tuần) nên bản dựng `--locked` là xác định. KHÔNG sửa vì lane RUST có thể đang sửa `Cargo.toml`; gợi ý đổi thành `=1.0.229` / `=1.0.154` khi gộp.
- Chưa kiểm tuổi từng crate/gói **transitive** (hàng trăm); chỉ kiểm trực tiếp. Có thể kiểm bằng `Cargo.lock`/`pnpm-lock.yaml` nếu cần.

## 4. Kiểm chứng

`pnpm install --frozen-lockfile` 0; `prettier --check .github/workflows/ci.yml` 0; `pnpm typecheck` 0; `pnpm test` 0 (67 file, 662 pass, 6 expected fail, 3 skipped); `pnpm build` 0. Không đụng `Cargo.toml`/`Cargo.lock`/`pnpm-lock.yaml`/`package.json` nên không chạy `cargo test`. Workflow chưa chạy trên GitHub thật (không push): CHƯA xác minh các SHA chạy được trên runner.
