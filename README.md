# dsh-session-delete

给 DeepSeek Harness 的会话"…"菜单补上真正的**删除会话**。

> **背景**：DSH 官方（含桌面端）的会话存储层只有归档 / 置顶 / 重命名 / 分叉，从未提供删除；
> 本插件补齐这一缺失能力，交互对齐主流 agent（ChatGPT / Claude 等）的删除语义。

English | 中文（下文为主，文末有 English summary）

---

## ⚠️ 删除前必读：备份什么、不备份什么

**会永久消失（不可恢复）—— 会话的对话记录本身：**

- 会话日志（每轮消息、工具调用轨迹、模型输出）与投影缓存被**物理删除**，且对其他所有会话、
  对模型、对搜索工具同时永久隐身——删了就是谁也想不起来了
- 若这个会话里有值得留的东西，**删除前先做其中一件**：
  1. 让该会话的 agent 把关键结论 / 决定 / 未完事项浓缩写入工作区一个 `.md` 摘要文件（推荐，最省事）
  2. 用 DSH 自带的会话日志导出/下载功能留一份原始日志副本

**不会被动——工作区里的文件：**

- ✅ 该会话中生成或修改的工作区文件（代码、文档、作业……）**全部原地保留**，本插件不碰 `~/.dsh` 之外的任何路径
- ❌ 反过来说：删会话**不能**用来"撤销"agent 改过的文件——文件属于工作区，不属于会话，想回滚请用 Git

## 功能

- 侧边栏每个会话行的"…"菜单新增红色**删除会话**行（位于"归档会话"之下），带垃圾桶图标、危险配色
- 确认对话框说明删除后果；对话框内含**强制删除**复选框（默认不勾选）
  - 普通删除：拒绝正在生成回复 / 有后台工作 / 有未落盘内容的会话，提示直接引导勾选强制删除
  - 勾选强制：先通过会话自身 Agent 的公开退场链把它**从内存中释放**（停止回复、释放日志句柄，
    并原生触发 `session/disposed` —— 桌面与手机端的行此刻即消失），再停掉后台工作（子代理 /
    后台任务 / 定时提醒，与官方"停止并归档"同一机制），最后彻底删除：磁盘日志 + 投影缓存 +
    注册表记账全部清除，**不留幽灵行**
  - 极端情况下若会话被其标签页持锁无法自动释放，才提示关闭该标签页后重试（罕见兜底，非常规步骤）
  - 被拒绝后复选框**保持可见**，当场勾选重试即可，无需关窗重开
- 删除成功后：已连接的所有客户端界面**即时**移除该行（无需重启）；磁盘上的会话日志目录、
  投影缓存文件被清除；工作区归属 / 置顶 / 归档记账一并清理
- 记录已丢失的"幽灵行"（历史版本遗留）再次点删除也能回收：按会话 id 清扫所有项目目录

## 安全护栏

- 只删除 `~/.dsh` 内**由会话 id 精确计算出的路径**（与官方 JSONL 存储后端同一套编码），绝不触碰工作区
- 磁盘删除真实失败时**中止流程且不修改注册表**——不会出现"账删了、日志还在"的半途状态
- 删除顺序先清磁盘与内存索引、后做记账变更，杜绝"未分组"幽灵行复活
- 接口经宿主信任栅栏（仅回环 + 同源浏览器请求），外部页面无法调用；无任何网络外发，不读取或上传对话内容

## 安装

```bash
# 发布到 GitHub / npm 后（命令以市场页展示为准）：
dsh plugin add dsh-session-delete                 # npm 源
dsh plugin add github:<owner>/dsh-session-delete   # GitHub 源
```

要求 **DSH ≥ 0.2.1-rc.1**（`dsh.bundle` 协议 + 会话菜单插槽均自该线可用）。
适用：DSH NEXT、官方桌面端及任何内置 dsh Web GUI 的第三方客户端；纯 CLI / headless 宿主没有侧栏 UI，装了不会显示。

## 卸载

设置 → 插件里直接卸载：菜单项与对话框随之消失；**已执行过的删除**是永久操作，不受卸载影响（这也是为什么弹窗标题写着"不可撤销"）。

## 给开发者：实现速览

- **Host**（`index.js`）：`webServer` 精确路由 `POST /session-delete/api/delete { sessionId, force? }`，
  过 `connection.requestRejection` 信任栅栏；流程：live（force 时先经 Agent 公开 `dispose()`
  释放内存态并等待其真正离场，释放不掉则 409 `release-failed`；非 force 一律 409）→ pending →
  （force 时 `workspace/session-stop` 停后台工作）→ activity → 磁盘删除（日志目录 + 投影缓存）→
  注册表内存索引逐出 → unarchive / unpin / detach → `emit api-session/removed`
- **Client**（`client.js`）：`window.__ModuleLoader__` 注册；菜单行 `sidebar.workspaces.session.menu.item`
  order 420（archive=400 与 session-id=450 之间）；确认框走 `shell.overlay`；样式全部取自
  `--dsw-alias-*` 主题令牌，明暗色自适应；文案 zh/en 自管 + 注册进 locale 服务
- 路径编码与 `dsh-session-persistence-jsonl` 保持一致（`projectKey` / `encodeSegment`），
  header 缺失时按 id 清扫全部项目目录兜底
- 版本线：v1.0.0 首发（新家 + 正式包名）；v1.1.0 复选框在错误下保持可见；
  v1.2.0 force 语义升级为「自动释放内存态会话后一步删净」（修复 force 拆盘在桌面/手机留幽灵行），
  UI 回到单复选框形态，无新增交互概念

## License

MIT（正式发布前在本目录补 LICENSE 文件）

---

## English summary

**dsh-session-delete** adds the missing *Delete session* row to every session's "..." menu in
DeepSeek Harness (official clients have archive/pin/rename/fork only — there is no durable delete).

- Confirmation dialog with a **Force delete** checkbox that stays visible next to refusal
  errors. Force deletes in one click, no user-side ritual: it first releases the session
  through its Agent's public teardown (stops generation, frees the log handle, and the
  native disposal event drops the row on desktop and phone alike), stops background work
  (subagents / jobs / schedules — same mechanism as the shipped "stop and archive"), then
  removes everything. Only the rare case where a tab holds the session so tightly it
  cannot be released asks the user to close it.
- **Conversation logs are permanently deleted** — invisible to every other session and to the
  model. Back up what matters *before* deleting: have the agent condense a summary into a
  workspace file, or export the session log.
- **Workspace files are never touched** — files created or edited in a session are kept
  (matching ChatGPT / Claude semantics). Deleting a session is not a file rollback.
- Only paths inside `~/.dsh` computed exactly from the session id are removed; a failed disk
  delete aborts before any bookkeeping changes; the route sits behind the host trust fence
  (loopback + same-origin), no network egress, no conversation content read or uploaded.
- Requires DSH ≥ 0.2.1-rc.1; works on DSH NEXT, the official desktop client and any host
  shipping the dsh Web GUI. Uninstall removes the menu row; executed deletions stay executed.
