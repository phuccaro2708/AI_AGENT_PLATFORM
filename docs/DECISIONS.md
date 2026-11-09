# DECISIONS — Architecture Decision Records

## ADR-001: Orchestrator là Tauri sidecar, đóng gói sẵn Node runtime

- **Trạng thái:** Đã chốt. Spike đã chạy trên runner Windows của GitHub và trên máy Windows vật lý (bản debug `tauri dev`; chưa kiểm bản release/installer) — xem [`ADR-001.md`](ADR-001.md)
- **Bối cảnh:** Ứng dụng desktop cho người dùng cuối; không nên bắt họ cài Node. Orchestrator dùng TypeScript để chia sẻ types với UI.
- **Quyết định:** Đóng gói orchestrator (bundle JS) cùng Node runtime làm sidecar của Tauri. Dev mode dùng Node hệ thống theo `.nvmrc`.
- **Rủi ro chưa kiểm chứng:** native module (`better-sqlite3`, `node-pty`) có prebuild cho Windows x64 và đóng gói được vào sidecar hay không; kích thước installer.
- **Xem lại nếu:** spike Phase 0 thất bại → ghi ADR mới và chọn phương án khác (vd. Node SEA, `node:sqlite`); chưa khẳng định phương án nào hoạt động.

## ADR-002: Mức cô lập cho 1.0

- **Trạng thái:** Đã chốt
- **Quyết định:** 1.0 dùng Windows Job Object + Policy Engine (path/command/network) + allowlist executable và biến môi trường + sandbox của chính từng provider CLI. AppContainer / Windows Sandbox chỉ là spike đánh giá ở Phase 4, kết quả ghi vào `SECURITY.md`, không cam kết trong 1.0.
- **Hệ quả:** Tài liệu và UI phải nêu rõ đây **không phải** OS-level sandbox; approval không thay thế sandbox; Git worktree không phải biên bảo mật.
- **Xem lại nếu:** spike cho thấy AppContainer/Windows Sandbox khả thi với chi phí chấp nhận được.

## ADR-003: A2A gateway để sau 1.0 (v1.1)

- **Trạng thái:** Đã chốt
- **Bối cảnh:** MVP chỉ chạy trên một máy; giao thức nội bộ typed đủ dùng. A2A cần compatibility test đúng phiên bản spec.
- **Quyết định:** 1.0 chỉ có giao thức nội bộ + MCP gateway tối thiểu. A2A gateway làm ở v1.1. Message nội bộ đã có `correlationId`/`causationId` để map sau.
- **Ràng buộc:** không gọi hệ thống là "A2A-compatible" trước khi qua compatibility tests.

## ADR-005: Thứ tự phase chốt lại (2026-11-04)

- **Trạng thái:** Đã chốt theo yêu cầu người dùng, thay thế quyết định thứ tự 2 → 7 → 8 → 9 ngày 2026-11-02.
- **Bối cảnh:** thứ tự cũ có phụ thuộc ngược (7C và 8 và 9 cần Policy Engine ở Phase 4; Phase 8 cần `mcp-gateway` ở Phase 6; gate Phase 7 về diagnostics cần Phase 4; Phase 5 và 7 trùng UI).
- **Quyết định:** Phase 7 (phần không cần policy) song song Phase 3 → Phase 4 (+ 7C-2, đóng Phase 7) → Phase 5 → Phase 6 (kéo `mcp-gateway` lên đầu) → Phase 8 → Phase 9; Phase 10 xuyên suốt. Chi tiết bảng: ROADMAP, mục "Thứ tự thực hiện".
- **Đánh đổi:** không còn phụ thuộc vòng; mọi quyền ghi đi qua Policy Engine; ra 1.0 trước khi mở rộng. Đổi lại ACP và đội agent (Phase 8, 9) đến muộn hơn và Phase 4 (2–3 tuần) chen trước các tính năng mới.
- **Xem lại nếu:** có yêu cầu đưa ACP hoặc multi-agent lên sớm; khi đó phải có Policy Engine tối thiểu trước.

## ADR-006: Một sidecar duy nhất sở hữu DB; cầu nối MCP cho DeepSeek Harness chỉ dùng allowlist (2026-11-06)

- **Trạng thái:** Đề xuất, duyệt từng phần. Người dùng đã duyệt (2026-11-06) chỉ **làm mục 2d, khoá single-instance, trước** và cho phép ngoài thứ tự phase cho riêng mục này; kênh pipe, token, vai `bridge`/`ui` và cầu nối (2c, 2e, 2f) chờ sau Phase 4 và chưa được duyệt. Chủ DB (2a), 2b, việc spawn sớm sidecar và cách xử lý yêu cầu lặp (mục 5) chưa được hỏi, vẫn là đề xuất. Lưu ý khi lập kế hoạch cho 2d: cơ chế khoá đề xuất dùng một pipe chỉ để lắng nghe (chưa có giao thức, token hay vai), nên không kéo theo việc duyệt kênh 2c; việc chọn đúng cơ chế khoá là quyết định của kế hoạch riêng đó. **Cập nhật 2026-11-06: mục 2d đã được triển khai** (xem "Đã triển khai" trong 2d); phần còn lại chưa có mã. KHÔNG triển khai phần chưa duyệt. ADR này nằm ngoài thứ tự phase của [ADR-005](#adr-005-thứ-tự-phase-chốt-lại-2026-11-04): không đổi thứ tự phase, không đóng phase nào, và chưa có mục nào trong `docs/ROADMAP.md`.
- **Phạm vi phiên viết:** chỉ tài liệu. Chưa có mã khoá, kênh hay cầu nối nào. Không tuyên bố "tương thích MCP" cho đến khi qua test (nguyên tắc 9 trong `CLAUDE.md`, ADR-003).
- **Quy ước nguồn:** khẳng định về mã Agent Workspace có `file:dòng` đã đọc lại ngày 2026-11-06 (số dòng nằm trong phần chữ của link). Khẳng định về Harness đều ghi "theo tài liệu, chưa kiểm" vì chưa chạy thử với bản đã cài (xem `docs/ASSUMPTIONS.md`, mục probe 2026-11-06, và `docs/REFERENCES.md`).

### 1. Bối cảnh và vấn đề

Ý tưởng: dùng DeepSeek Harness Desktop làm giao diện tương tác, Agent Workspace làm backend điều phối. Harness có MCP client với transport stdio và Streamable HTTP, chạy server stdio như tiến trình con, có `probe`/`restart`, timeout gọi tool mặc định 60 giây (theo tài liệu, chưa kiểm). Một cầu nối MCP là cách ghép ít xâm lấn nhất, nhưng chạm vào ba điều đã kiểm trong mã:

1. **Sidecar thứ hai làm hỏng task của sidecar thứ nhất.** Constructor `SidecarService` gọi `repo.recoverInterruptedTasks()` vô điều kiện ([sidecar.ts:307](../services/orchestrator/src/sidecar.ts)). Hàm này chọn mọi task `running` hoặc `waiting_approval` và chuyển sang `needs_reconciliation` ([repo.ts:352](../packages/storage/src/repo.ts)); test ở [storage.test.ts:86](../packages/storage/src/storage.test.ts). Constructor chạy ngay khi tiến trình khởi động ([sidecar-main.ts:33](../services/orchestrator/src/sidecar-main.ts)). Không tìm thấy khoá single-instance nào trong `services/orchestrator/src`, `packages/storage/src` và `apps/desktop/src-tauri/src`. SQLite chỉ đặt `journal_mode=WAL` và `busy_timeout=5000` ([db.ts:17](../packages/storage/src/db.ts)), tức là cho phép nhiều tiến trình mở chung file chứ không ngăn.
2. **Giao thức sidecar không đính kèm từ ngoài được.** Sidecar nói JSON theo dòng qua stdin/stdout ([sidecar-main.ts:53](../services/orchestrator/src/sidecar-main.ts)); Tauri là bên giữ ống đó (`stdin(Stdio::piped())` tại [sidecar.rs:92](../apps/desktop/src-tauri/src/sidecar.rs), `child.stdin.take()` tại [sidecar.rs:107](../apps/desktop/src-tauri/src/sidecar.rs)) và Job Object giết cây tiến trình khi Tauri chết ([sidecar.rs:52](../apps/desktop/src-tauri/src/sidecar.rs)). Tiến trình khác chỉ có thể tự spawn sidecar mới, tức là rơi vào vấn đề 1.
3. **Giao thức không phân biệt người gọi.** `approvals.resolve` ([sidecar.ts:822](../services/orchestrator/src/sidecar.ts), schema [index.ts:265](../packages/contracts/src/index.ts)), `tasks.resolveReconciliation` ([sidecar.ts:730](../services/orchestrator/src/sidecar.ts), [index.ts:305](../packages/contracts/src/index.ts)) và `recovery.resolve` ([sidecar.ts:745](../services/orchestrator/src/sidecar.ts), [index.ts:331](../packages/contracts/src/index.ts)) là các request như mọi request khác. Nếu model gọi được chúng qua cầu nối, agent tự duyệt yêu cầu của chính nó.

Hệ quả kết hợp: nếu cầu nối stdio tự spawn sidecar, mỗi lần Harness `probe`/`restart`/reload server (theo tài liệu, chưa kiểm) sẽ sinh sidecar mới và đánh dấu hỏng task đang chạy.

### 2. Quyết định (đề xuất)

**2a. Chỉ một tiến trình sở hữu DB và scheduler: sidecar do Tauri spawn (giữ nguyên ADR-001).**

- Sidecar do Tauri spawn là chủ DB, scheduler và workflow engine (`Scheduler` tạo trong constructor, [sidecar.ts:374](../services/orchestrator/src/sidecar.ts)). Không thêm daemon thứ hai.
- Hệ quả: các tool Harness chỉ dùng được khi Agent Workspace đang mở. Khi nó đóng, cầu nối trả lỗi rõ ràng "Agent Workspace chưa chạy" và KHÔNG tự khởi động gì.
- **Sidecar chạy lười và bị restart, nên "đang mở" chưa chắc có pipe.** Tauri chỉ spawn sidecar khi có lời gọi đầu tiên ([lib.rs:99](../apps/desktop/src-tauri/src/lib.rs), `ensure_sidecar`) và dừng nó khi đổi secret để lần gọi sau nạp môi trường mới ([lib.rs:241](../apps/desktop/src-tauri/src/lib.rs), `restart_sidecar`, chỉ sau khi `ensure_idle` xác nhận không còn task). Hệ quả cho cầu nối: UI mở nhưng chưa dùng thì chưa có pipe; mỗi lần restart sidecar mất pipe và token cũ, cầu nối phải kết nối lại và đọc token mới, không giữ token trong bộ nhớ lâu. Việc để Tauri spawn sidecar sớm khi bật tích hợp Harness là quyết định riêng, chưa chốt ở đây.
- Phương án daemon độc lập (Tauri và Harness cùng là client) cho phép chạy khi UI đóng và giải quyết vấn đề stdio, nhưng đổi ADR-001, đổi vòng đời đóng gói/Job Object và phải làm lại UI client. Không chọn ở đây; xem "Xem lại nếu".

**2b. Cầu nối MCP KHÔNG BAO GIỜ spawn sidecar.** Cầu nối chỉ là client của kênh cục bộ ở 2c. Nếu không kết nối được thì báo lỗi, không retry bằng cách spawn. Cầu nối không import `SidecarService`, không mở file DB.

**2c. Kênh cục bộ: named pipe Windows (đề xuất), loopback HTTP có token (loại).**

| Tiêu chí                   | Named pipe                                                    | Loopback HTTP + token                                                                                            |
| -------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ai kết nối được            | giới hạn bằng DACL (chỉ SID người dùng hiện tại) nếu cài đúng | mọi tiến trình và mọi người dùng trên máy tới được cổng; cần kiểm Host/Origin chống DNS rebinding và trình duyệt |
| Cổng/cấu hình              | không chiếm cổng                                              | cần cổng, có thể đụng cổng                                                                                       |
| Hợp với kiến trúc hiện tại | sidecar thêm một nguồn request vào cùng `handle`              | sidecar thêm HTTP server; hoặc phải thành MCP server, lệch giao thức riêng đã có                                 |
| Chạy test trên CI ubuntu   | cần fallback Unix socket                                      | chạy sẵn                                                                                                         |

- **Đề xuất:** named pipe, tên gồm băm của đường dẫn DB đã chuẩn hoá (nhiều DB không đụng nhau), do chính sidecar phục vụ (nó đã sở hữu DB; không thêm tầng Rust). DACL: chỉ SID của người dùng hiện tại. **Đã đo (2026-11-06, Windows 11, Node 24.18): ACL mặc định của pipe do Node/libuv tạo KHÔNG giới hạn theo người dùng**: Everyone và Anonymous có quyền đọc (SDDL trong `docs/ASSUMPTIONS.md`). Vì vậy kênh 2c phải tự đặt DACL tường minh hoặc dựa vào token; không được coi pipe mặc định là biên theo người dùng.
- **Xác thực lớp hai:** token ngẫu nhiên mỗi lần sidecar khởi động, gửi trong request đầu của kết nối. Token KHÔNG ghi file: Tauri sinh và lưu vào OS credential store dưới service `agent-studio` (đang dùng tại [secrets.rs:11](../apps/desktop/src-tauri/src/secrets.rs), khoá dạng `index/{provider}` tại [secrets.rs:92](../apps/desktop/src-tauri/src/secrets.rs); khoá mới cho cầu nối là việc phải làm). Cầu nối là tiến trình Node do Harness spawn nên cách nó đọc credential store là câu hỏi mở: tài liệu mcp-manager của Harness mô tả `${credential:REF}` (theo tài liệu, chưa kiểm). Nếu không đọc được token an toàn thì DACL của pipe là lớp bảo vệ duy nhất, và ADR phải ghi thẳng điều đó thay vì giả vờ có hai lớp.
- **Giới hạn trung thực:** tiến trình khác chạy cùng người dùng đọc được DB và có thể tự đọc token; kênh này không phải biên chống mã độc cùng người dùng (nguyên tắc 5). Nó chỉ chặn tiến trình của người dùng khác và việc gọi nhầm.
- Mọi request qua pipe đi vào CÙNG hàng đợi tuần tự với stdio (biến `chain` tại [sidecar-main.ts:54](../services/orchestrator/src/sidecar-main.ts)); không tạo đường xử lý song song cho `handle`.

**2d. Khoá single-instance bằng chính pipe, lấy TRƯỚC khi tạo `SidecarService`.**

- Pipe có tên cố định theo băm đường dẫn DB (2c) đồng thời là khoá: nếu `listen` trả `EADDRINUSE`, tiến trình thoát với mã lỗi riêng và thông báo, trước khi chạy [sidecar-main.ts:33](../services/orchestrator/src/sidecar-main.ts) (tức là trước `recoverInterruptedTasks`). Thứ tự bắt buộc: lấy khoá, rồi mới mở DB/constructor.
- **Khoá kẹt sau crash:** trên Windows, named pipe biến mất khi handle cuối đóng và HĐH đóng handle khi tiến trình chết (kể cả bị Job Object giết), nên không có khoá mồ côi. Trên Linux/macOS (CI ubuntu) socket là file nên có thể mồ côi: khi `EADDRINUSE`, thử kết nối; nếu `ECONNREFUSED` thì xoá file rồi thử lại một lần.
- **Tiến trình giữ khoá nhưng treo:** sidecar mới thoát và báo lỗi; KHÔNG tự giết tiến trình kia. Người dùng đóng ứng dụng. Chưa kiểm hành vi này trên Windows thật.
- "Tên pipe được giải phóng khi chết" là giả định về HĐH chưa được kiểm trong repo này, nên phải có test (mục 5).
- **Đã triển khai (2026-11-06):** [sidecar-lock.ts](../services/orchestrator/src/sidecar-lock.ts) giữ một server `net` chỉ để lắng nghe (không giao thức, không token, không vai), lấy trước `SidecarService` trong [sidecar-main.ts](../services/orchestrator/src/sidecar-main.ts). Khác với đề xuất ban đầu: (a) tên khoá là `\\.\pipe\agent-studio-sidecar-<băm 16 hex>` trên Windows nhưng **socket trừu tượng** `\0agent-studio-sidecar-<băm>` trên Linux (không có file nên không có khoá mồ côi, thay cho bước connect-test/xoá file; chỉ macOS dùng socket file + connect-test, không có test); (b) băm lấy từ `realpath.native` của thư mục cha của DB (xử lý junction, tên 8.3, chữ hoa/thường); (c) thử lại mỗi 100 ms tối đa 3 giây trước khi bỏ cuộc, để che cửa sổ Tauri respawn khi sidecar cũ đang thoát; (d) sidecar thua khoá in một dòng `{"event":"fatal","message":…}` lên stdout rồi thoát mã 75, và Tauri đưa thông điệp đó vào lỗi "sidecar exited: …"; (e) DB `:memory:` không bị khoá. Không có cơ chế tự giết sidecar treo.

**2e. Allowlist (không phải denylist), ba giai đoạn, thực thi ở CẢ HAI phía.**

| Giai đoạn       | Method được phép                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Ghi chú                                                                                                                                                                                                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Chỉ đọc      | `projects.list` ([sidecar.ts:659](../services/orchestrator/src/sidecar.ts)), `tasks.list` ([sidecar.ts:766](../services/orchestrator/src/sidecar.ts)), `tasks.history` ([sidecar.ts:771](../services/orchestrator/src/sidecar.ts)), `logs.query` ([sidecar.ts:755](../services/orchestrator/src/sidecar.ts)), `artifacts.list` ([sidecar.ts:832](../services/orchestrator/src/sidecar.ts)), `artifacts.diff` ([sidecar.ts:834](../services/orchestrator/src/sidecar.ts)), `worktrees.list` ([sidecar.ts:836](../services/orchestrator/src/sidecar.ts)) | Kết quả đi vào ngữ cảnh model: phải giới hạn kích thước. Chưa đọc kỹ tham số/kết quả từng method; cần duyệt trường trả về trước khi bật.                                                                                                          |
| 2. Tạo/chạy/hủy | `workflows.create` ([sidecar.ts:661](../services/orchestrator/src/sidecar.ts)), `workflows.start` ([sidecar.ts:667](../services/orchestrator/src/sidecar.ts)), `tasks.cancel` ([sidecar.ts:707](../services/orchestrator/src/sidecar.ts))                                                                                                                                                                                                                                                                                                              | `workflows.start` trả `taskId` ngay và chạy nền ([sidecar.ts:685](../services/orchestrator/src/sidecar.ts)): hợp với timeout 60 giây (theo tài liệu, chưa kiểm). Model truy vấn tiến độ bằng `tasks.list`/`tasks.history`, không giữ kết nối chờ. |
| 3. Peer review  | `workflows.startPeerReview` ([sidecar.ts:783](../services/orchestrator/src/sidecar.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Chỉ thêm sau khi giai đoạn 2 qua đủ test.                                                                                                                                                                                                         |

- **Cấm tường minh (mỗi cái có một test riêng):** `approvals.resolve`, `tasks.resolveReconciliation`, `recovery.resolve`, `agents.setSettings` ([sidecar.ts:608](../services/orchestrator/src/sidecar.ts), [index.ts:175](../packages/contracts/src/index.ts)), `shutdown` ([sidecar.ts:840](../services/orchestrator/src/sidecar.ts), [index.ts:342](../packages/contracts/src/index.ts)), `diagnostics.export` ([sidecar.ts:838](../services/orchestrator/src/sidecar.ts), [index.ts:341](../packages/contracts/src/index.ts)).
- Vì là allowlist, mọi method không liệt kê đều bị chặn. Hai ca cần nói rõ: `projects.create` KHÔNG vào allowlist (chính sách `projects.rootPath` còn mở, `docs/TODO.md` mục "Nợ kỹ thuật còn mở"); `approvals.list` KHÔNG vào danh sách ban đầu vì nó gọi `expireDue()` nên đọc mà có side effect ([sidecar.ts:819](../services/orchestrator/src/sidecar.ts)).
- **Hai phía:** (1) cầu nối chỉ đăng ký tool cho method trong allowlist của giai đoạn đang bật; (2) kênh phía sidecar tự gắn vai `bridge` cho kết nối pipe và từ chối method ngoài allowlist TRƯỚC khi gọi `handle`. Cầu nối bị sửa hoặc thay bằng client khác vẫn không vượt được. Vai `ui` (stdio từ Tauri) giữ toàn bộ method như hiện nay.

**2f. Phê duyệt chỉ do người dùng thao tác trong giao diện Agent Workspace.** Mọi method duyệt/giải quyết nằm ngoài allowlist của vai `bridge`, nên model qua cầu nối không thể tự duyệt (chỉ đúng khi test ở mục 5 qua). Phê duyệt đang chờ hiện trong UI Agent Workspace. Hạn chế còn lại: nội dung yêu cầu duyệt có thể bị model ảnh hưởng (prompt injection); người dùng phải đọc thẻ phê duyệt, allowlist không giải quyết điều này.

### 3. Phương án đã loại

- **Cầu nối spawn sidecar riêng:** kích hoạt `recoverInterruptedTasks` ở sidecar thứ hai (mục 1.1); mỗi `probe`/`restart` của Harness (theo tài liệu, chưa kiểm) sinh thêm tiến trình tranh scheduler.
- **Hai sidecar chung DB:** WAL cho phép mở chung nhưng không có phân xử ai chạy task nào; scheduler và `needs_reconciliation` giả định một chủ duy nhất.
- **Expose toàn bộ giao thức:** biến model thành người duyệt chính nó (mục 1.3) và cho phép `shutdown`, `agents.setSettings`.
- **Denylist:** method mới thêm vào giao thức tự động lộ ra; quên cập nhật một lần là mất an toàn. Allowlist mặc định chặn.
- **Loopback HTTP + token:** xem bảng 2c; bề mặt tấn công rộng hơn pipe mà không có lợi ích tương xứng.
- **Daemon độc lập ngay bây giờ:** đổi ADR-001 và vòng đời đóng gói; hoãn.

### 4. Hệ quả, rủi ro còn lại, việc phải làm

- **Hệ quả:** Harness chỉ điều khiển được Agent Workspace khi nó đang chạy; sidecar có thêm một đường vào (pipe) cần coi là bề mặt tấn công mới; hai danh sách method (cầu nối và kênh) phải đồng bộ nên cần một nguồn duy nhất trong `packages/contracts`.
- **Rủi ro còn lại:** tiến trình cùng người dùng không bị chặn; nội dung phê duyệt chịu prompt injection; kết quả `logs.query`/`artifacts.diff` có thể chứa dữ liệu nhạy cảm mà redactor bỏ sót (`docs/HANDOFF.md`: secret có thể lọt nếu CLI in môi trường đã biến đổi); Harness là developer preview, "có thay đổi phá tương thích" nên cầu nối cần pin phiên bản (theo tài liệu, chưa kiểm).
- **Việc phải làm (KHÔNG làm trong phiên này; mỗi việc sau khi được duyệt, theo thứ tự):**
  1. Khoá single-instance bằng pipe (2d) kèm test, vì nó sửa lỗi có thật độc lập với Harness.
  2. Kênh cục bộ có vai `bridge`/`ui` và allowlist phía kênh (2c, 2e), kèm token và DACL đã test.
  3. Cầu nối MCP giai đoạn 1 (chỉ đọc), rồi 2, rồi 3.
  4. `docs/TODO.md` đã có một dòng trỏ tới ADR này; cập nhật `docs/ARCHITECTURE.md` khi triển khai.
- **Xem lại nếu:** cần Harness dùng được khi UI Agent Workspace đóng (chuyển sang daemon, đổi ADR-001); ACL pipe mặc định không đặt được owner-only; Harness không có MCP như mô tả.

### 5. Tiêu chí kiểm chứng cho từng bước triển khai sau này

Tên test bên dưới là kế hoạch, chưa tồn tại.

| Bước                   | Test cần có                                                                                                                   | Đạt khi                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Khoá single-instance   | `sidecar-lock.test.ts`: khởi động sidecar A, tạo task `running`, khởi động sidecar B trên cùng DB                             | B thoát với mã lỗi riêng; trạng thái task trong DB không đổi (không `needs_reconciliation`); không có log "tasks interrupted". |
|                        | giết A đột ngột rồi khởi động B                                                                                               | B lấy được khoá; task bị chuyển `needs_reconciliation` đúng một lần (hành vi hiện tại giữ nguyên).                             |
|                        | (Linux) socket mồ côi                                                                                                         | B xoá socket chết và chạy được.                                                                                                |
| Allowlist cầu nối      | `bridge-allowlist.test.ts`: lặp qua MỌI method trong `packages/contracts`                                                     | chỉ method trong allowlist của giai đoạn đang bật có tool; mọi method khác không có tool và không có đường gọi.                |
| Allowlist kênh         | `channel-allowlist.test.ts`: client thô trên pipe với vai `bridge` gửi từng method cấm và từng method ngoài danh sách         | bị từ chối trước `handle`; trạng thái DB không đổi; có log từ chối.                                                            |
| Không tự duyệt         | `bridge-no-self-approve.test.ts`: tạo task cần phê duyệt qua cầu nối, rồi gọi `approvals.resolve` qua cầu nối và qua pipe thô | cả hai bị chặn; approval vẫn `pending`; resolve từ vai `ui` vẫn hoạt động.                                                     |
| Xác thực kênh          | kết nối pipe không token hoặc token sai                                                                                       | bị từ chối. Ca "người dùng khác" chỉ kiểm được nếu có tài khoản thứ hai; nếu không, ghi rõ là chưa kiểm.                       |
| Mất kết nối            | cầu nối chết khi task đang chạy                                                                                               | task vẫn chạy và truy vấn lại được bằng `taskId`; không sidecar nào được sinh thêm.                                            |
| Restart sidecar        | đổi secret trong Agent Workspace khi cầu nối đang kết nối, rồi gọi lại tool                                                   | cầu nối nhận lỗi rõ ràng, kết nối lại với pipe/token mới; không dùng token cũ; không sidecar thứ hai.                          |
| Sidecar chưa spawn     | gọi tool khi UI mở nhưng chưa có sidecar                                                                                      | lỗi rõ ràng "chưa sẵn sàng", cầu nối không tự spawn.                                                                           |
| Yêu cầu lặp            | gửi `workflows.start` hai lần cùng nội dung (như Harness retry)                                                               | quyết định trước: có khoá chống lặp hay ghi rõ là hai task; test khẳng định đúng hành vi đã chọn, không retry ngầm.            |
| Hủy giữa chừng         | `tasks.cancel` khi `running` và khi `waiting_approval`                                                                        | trạng thái cuối nhất quán, worktree không rò.                                                                                  |
| `needs_reconciliation` | dừng Agent Workspace khi task `running`, mở lại, cầu nối đọc                                                                  | task hiện `needs_reconciliation`; cầu nối không có cách gọi `recovery.resolve`; không tự retry.                                |
| Tích hợp thật          | với bản Harness đã cài: thêm cầu nối, probe, restart, gọi tool giai đoạn 1                                                    | chỉ sau khi qua mới được nói "chạy được với Harness phiên bản X"; không nói "tương thích MCP" tổng quát.                       |

Gate chung: `pnpm lint && pnpm format && pnpm typecheck && pnpm test && pnpm build` (thêm `cargo clippy --all-targets -- -D warnings` và `cargo test --locked` nếu đụng `src-tauri`).

### 6. Chưa xác minh (từ `docs/ASSUMPTIONS.md`, probe 2026-11-06; theo tài liệu, chưa kiểm)

- Bản Harness đã cài (kênh `nightly`) có thật sự mount `mcp-manager` và `dsh-mcp-client` không; tài liệu mô tả nhánh `master`, bản cài có thể cũ hơn.
- Cách thêm MCP server trong Desktop thực tế (Settings hay `cordis.yml`) và nơi lưu cấu hình trên máy.
- Tool MCP có hiện thẻ phê duyệt trong Harness hay chạy ngầm tuỳ preset (`workspace-write` + `ask` là mặc định theo tài liệu).
- Hành vi khi cầu nối rơi giữa chừng (reconnect, tool call treo, `probe` đóng kết nối).
- Chưa kiểm trong repo này: ACL mặc định của named pipe do Node tạo; tên pipe được giải phóng khi tiến trình chết trên Windows thật; cách tiến trình Node đọc credential store.

## ADR-007: Bật mặc định hai cổng quyền và trần RAM cả cây (Q3, 2026-11-07)

- **Bối cảnh:** hai cổng quyền (Codex `app-server`, Claude `--permission-prompt-tool` với `askEveryTool`) đã có bằng chứng chạy CLI thật (ASSUMPTIONS d3, d6, d9) nhưng mặc định TẮT; `jobMemLimitMb` đo được (R4) nhưng chưa nối vào cấu hình.
- **Quyết định (người dùng chọn):** đặt mặc định BẬT cả hai cổng và nối `jobMemLimitMb`. Codex: người dùng chọn đăng ký thêm agent `codex-app-server` mặc định, KHÔNG chuyển `codex` (exec) sang app-server. Ràng buộc: fail-closed (thiếu launcher/`--safe-mode` đã lưu thì từ chối task), có công tắc tắt (`AGENT_STUDIO_CLAUDE_GATE`, `AGENT_STUDIO_CODEX_GATE`, `AGENT_STUDIO_JOB_MEM_LIMIT_MB`; `SidecarOptions` `false`), không tuyên bố sandbox hay "duyệt từng lệnh".
- **Đánh đổi:** cổng Claude chỉ phủ sáu tool và cần `--safe-mode` tắt (thay bằng `--setting-sources local`); task Codex chọn `codex` vẫn không qua cổng; trần RAM 8192 MB rộng vì chưa có số liệu commit thật; tác dụng phụ: `agents.list` có thêm `codex-app-server`.
- **Xem lại nếu:** kiểm lại bằng CLI thật cho thấy mặc định mới làm hỏng task hợp lệ, `.claude/settings.local.json` nới được quyền, hoặc muốn ép task Codex đi qua cổng (khi đó mất `agent-job-wrap` cho Codex).

## ADR-008: `codex` chạy bằng adapter app-server khi cổng Codex bật (2026-11-07)

- **Bối cảnh:** ADR-007 chọn "thêm agent `codex-app-server`, không chuyển `codex`". Hệ quả: task chọn `codex` (exec) không qua cổng, `codex-app-server` không qua `agent-job-wrap`, nên review báo "cổng chưa nối production".
- **Quyết định (người dùng chọn, 2026-11-07, "Chuyển `codex` sang app-server"):** khi cổng Codex bật (mặc định), agent `codex` dựng `CodexAppServerAdapter` (id `codex`), chạy trong `agent-job-wrap` và có watchdog RSS cả cây (`AGENT_STUDIO_CLI_TREE_MEM_MB`, tùy chọn). `codex-app-server` vẫn được đăng ký. Tắt: `AGENT_STUDIO_CODEX_GATE=0` / `codexAppServer:false` đưa `codex` về `codex exec` và bỏ `codex-app-server`. Thay thế một phần ADR-007 (phần "không chuyển `codex`").
- **Đánh đổi:** `args` đã lưu của `codex` (dành cho `codex exec`) không dùng khi cổng bật; production policy vẫn từ chối mọi lệnh (allow list rỗng) nên task Codex cần chạy lệnh sẽ bị decline; hành vi app-server khác `exec --json` (sự kiện, `approvalPolicy: untrusted`). Không phải sandbox.
- **Xem lại nếu:** task Codex hợp lệ hỏng vì decline lệnh, hoặc app-server thay đổi giao thức giữa các phiên bản codex.

## ADR-009: `agy` (Antigravity) ra khỏi điều kiện đóng Phase 3 (2026-11-08)

- **Bối cảnh:** `agy` chỉ kiểm bằng CLI giả và một phần CLI thật (PARTIAL); ép quyền không kiểm chứng được, adapter fail-closed với `task.permissions`; đăng ký thật còn hard-code trong `sidecar.ts`.
- **Quyết định (người dùng chọn):** chỉ bỏ `agy` khỏi **phạm vi gate Phase 3**. Code `packages/adapter-antigravity`, đăng ký trong sidecar và UI giữ nguyên, không xoá, không ẩn. Gate Phase 3 tính trên Claude, Codex, Ollama.
- **Đánh đổi:** `agy` vẫn chạy được nhưng không còn được bảo đảm bởi gate; phần PARTIAL (lỗi chưa đăng nhập/hết hạn mức, cây tiến trình con, ép quyền) trở thành nợ ngoài gate, không phải điều kiện đóng.
- **Xem lại nếu:** muốn `agy` là agent hỗ trợ chính thức (khi đó đưa lại vào gate và hoàn tất kiểm thật), hoặc quyết định gỡ hẳn khỏi codebase.
