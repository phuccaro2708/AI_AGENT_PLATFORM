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
- Tuổi gói **transitive**: đã kiểm ở mục 5 (2026-11-06).

## 4. Kiểm chứng

`pnpm install --frozen-lockfile` 0; `prettier --check .github/workflows/ci.yml` 0; `pnpm typecheck` 0; `pnpm test` 0 (67 file, 662 pass, 6 expected fail, 3 skipped); `pnpm build` 0. Không đụng `Cargo.toml`/`Cargo.lock`/`pnpm-lock.yaml`/`package.json` nên không chạy `cargo test`. Workflow chưa chạy trên GitHub thật (không push): CHƯA xác minh các SHA chạy được trên runner.

## 5. Tuổi gói transitive (2026-11-06)

Công cụ: `node scripts/deps-age-audit.mjs [--npm] [--cargo] [--days 14] [--json file]` (không dependency mới; chỉ GET metadata công khai từ `registry.npmjs.org` và `crates.io/api`; npm 4 request song song, crates.io 1 request/giây kèm User-Agent; không cài, không chạy script của gói). Mã thoát: 0 đủ tuổi, 1 có gói trẻ hơn ngưỡng, 2 có gói không tra được. Thời điểm tham chiếu 2026-11-06T18:10Z, ngưỡng 14 ngày. Số liệu dưới đây là kết quả chạy thật.

| Hệ sinh thái                                                | Số gói khoá                     | Tra được | Không tra được | < 14 ngày | Gói trẻ nhất                      |
| ----------------------------------------------------------- | ------------------------------- | -------- | -------------- | --------- | --------------------------------- |
| npm (`pnpm-lock.yaml`, mục `packages`)                      | 315 (23 trực tiếp)              | 315      | 0              | **0**     | eslint 10.13.0 (21,2 ngày)        |
| Cargo (`apps/desktop/src-tauri/Cargo.lock`, nguồn registry) | 423 (8 cạnh từ crate workspace) | 423      | 0              | **13**    | log 0.4.35 (6,9 ngày, 2026-10-30) |

Mỗi phiên bản npm khác nhau của cùng một gói được đếm riêng. Ngày publish là `time[version]` của npm hoặc `created_at` của phiên bản trên crates.io.

### 13 crate transitive < 14 ngày (Cargo.lock KHÔNG bị sửa)

| Crate                              | Publish (UTC) | Tuổi (ngày) | Đường phụ thuộc kéo vào                                                   |
| ---------------------------------- | ------------- | ----------- | ------------------------------------------------------------------------- |
| brotli 9.1.1                       | 2026-10-27    | 10,6        | agent-studio > tauri 2.12.5 > tauri-utils 2.10.2 > brotli                 |
| brotli-decompressor 6.2.0          | 2026-10-25    | 12,4        | ... > tauri-utils > brotli 9.1.1 > brotli-decompressor                    |
| erased-serde 0.4.11                | 2026-10-25    | 12,6        | ... > tauri-utils > serde-untagged 0.1.9 > erased-serde                   |
| js-sys 0.3.107                     | 2026-10-30    | 7,5         | agent-studio > tauri > reqwest 0.13.5 > js-sys                            |
| log 0.4.35                         | 2026-10-30    | 6,9         | agent-studio > keyring-core 1.0.1 > log (cũng được nhiều crate khác dùng) |
| utf8_iter 1.1.0                    | 2026-10-29    | 8,0         | agent-studio > tauri > url 2.5.8 > idna 1.1.0 > utf8_iter                 |
| utf_types 1.0.0                    | 2026-10-29    | 8,0         | ... > idna 1.1.0 > utf8_iter 1.1.0 > utf_types                            |
| wasm-bindgen 0.2.130               | 2026-10-30    | 7,5         | agent-studio > tauri > reqwest 0.13.5 > wasm-bindgen                      |
| wasm-bindgen-futures 0.4.80        | 2026-10-30    | 7,5         | ... > reqwest > wasm-bindgen-futures                                      |
| wasm-bindgen-macro 0.2.130         | 2026-10-30    | 7,5         | ... > reqwest > wasm-bindgen > wasm-bindgen-macro                         |
| wasm-bindgen-macro-support 0.2.130 | 2026-10-30    | 7,5         | ... > wasm-bindgen-macro > wasm-bindgen-macro-support                     |
| wasm-bindgen-shared 0.2.130        | 2026-10-30    | 7,5         | ... > reqwest > wasm-bindgen > wasm-bindgen-shared                        |
| web-sys 0.3.107                    | 2026-10-30    | 7,5         | agent-studio > tauri > reqwest 0.13.5 > web-sys                           |

Đường là đường ngắn nhất tìm được (BFS) từ crate workspace; đây không phải mọi đường. Lưu ý:

- `cargo tree --locked --offline -i <crate> --target x86_64-pc-windows-msvc` (2026-11-06): `js-sys`, `web-sys`, `wasm-bindgen`/`-futures`/`-macro`/`-macro-support`/`-shared` (7 crate) **không** nằm trong đồ thị build Windows (chỉ target wasm của `reqwest`); `brotli`, `brotli-decompressor`, `erased-serde`, `log`, `utf8_iter`, `utf_types` (6 crate) **có** được biên dịch (qua `tauri-utils`/`tauri-codegen`, `html5ever`, `icu_collections`/`idna`). Chuỗi kéo vào đầy đủ lấy bằng lệnh trên.
- Chưa đối chiếu với chính sách: Cargo không có tương đương `minimumReleaseAge` của pnpm, nên ngưỡng 14 ngày với crate transitive hiện chưa được cưỡng chế. `Cargo.lock` + `--locked` chỉ đảm bảo xác định, không đảm bảo tuổi.
- Việc phải làm khi người dùng quyết định (KHÔNG làm tự động): (a) chấp nhận có ghi nhận (các crate đã có trên crates.io ≥ 6,9 ngày, không có advisory tại `cargo audit` ngày 2026-11-05), hoặc (b) hạ các crate này về bản cũ hơn bằng `cargo update -p <crate> --precise <ver>` rồi chạy lại `cargo test --locked`, hoặc (c) đợi đủ 14 ngày (muộn nhất 2026-11-13 cho `log`) rồi chạy lại script. Chạy lại script sau mỗi lần đổi lockfile.
- Giới hạn: kiểm tuổi không phải kiểm an toàn; script không kiểm yanked, chữ ký hay nội dung. Metadata registry là dữ liệu không đáng tin tuyệt đối (ngày do registry ghi, chưa xác minh độc lập).

### Chặn bằng CI và allowlist có hạn (2026-11-07)

Job `security` trong `.github/workflows/ci.yml` chạy `node scripts/deps-age-audit.mjs`; thoát khác 0 nếu có gói < 14 ngày (không có ngoại lệ còn hạn) hoặc không tra được. Ngoại lệ ghi trong `scripts/deps-age-allowlist.json` (mảng `{id, reason, expires}`; thiếu lý do hoặc quá hạn thì không có hiệu lực).

Chạy lại audit cargo thật (registry chỉ-đọc) lúc 2026-11-07T02:36Z: vẫn đúng 13 crate trên (trẻ nhất `log` 0.4.35, 7,2 ngày; 423/423 tra được). File allowlist đã tạo với 13 mục, mỗi mục có lý do (đường kéo vào + có/không nằm trong đồ thị build Windows, theo `cargo tree -i`) và `expires` = ngày đầu tiên crate đủ 14 ngày (publish + 14 ngày, làm tròn lên ngày kế): `erased-serde`, `brotli-decompressor` 2026-11-09; `brotli` 2026-11-11; `utf8_iter`, `utf_types` 2026-11-13; `log`, `js-sys`, `web-sys`, 5 crate `wasm-bindgen*` 2026-11-14. Vì hạn trùng thời điểm đủ tuổi, mục hết hạn thì crate đã đủ 14 ngày và CI vẫn xanh; nếu `Cargo.lock` được cập nhật lên bản mới hơn (id khác) mà chưa có mục, hoặc mục bị gia hạn thủ công quá hạn thật, bước CI đỏ.

Kiểm chứng (local, không sửa lockfile, không sửa dữ liệu thật):

- `node scripts/deps-age-audit.mjs --cargo --rows-from <cargo.json> --now 2026-11-07T02:36:00Z` (dùng lại dữ liệu registry vừa lấy, cờ test mới `--rows-from`): exit 0, 0 crate < 14 ngày. Không có allowlist: 13 crate YOUNG, exit 1.
- Giả lập quá hạn: allowlist tạm với mọi `expires` = 2026-11-08 và `--now 2026-11-09` → 11 crate YOUNG, exit 1.
- `tests/contract/deps-age-audit.test.ts` (offline, fixture tổng hợp, cờ `--allowlist`/`--rows-from`): không có mục → exit 1; mục còn hạn → exit 0; mục hết hạn trong khi gói còn trẻ → exit 1; mục thiếu lý do bị bỏ qua; file thật có đủ id/lý do/hạn hợp lệ.
- Rà soát lần chạy `pnpm test` toàn bộ: một lần fail ở `packages/adapter-codex/src/app-server.test.ts` do `EPERM` trên thư mục temp `policy-engine-*` (nhiều phiên song song dùng chung temp); chạy riêng lại pass.

Giới hạn: chỉ kiểm tuổi, không kiểm an toàn. **CI NOT_RUN**: workflow chưa chạy trên runner thật (không push). Bản đầy đủ npm chưa chạy lại ở lần này (npm trước đó 0 gói < 14 ngày). Allowlist không thay thế quyết định (b) hạ bản `cargo update -p ... --precise` nếu người dùng muốn loại crate khỏi lockfile.
