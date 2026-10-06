# dsh-memory（中文版）

![npm](https://img.shields.io/npm/v/@fooxe/dsh-memory) ![license](https://img.shields.io/badge/license-MIT-blue)

**给 DeepSeek Harness 装上跨会话持久记忆——你的 agent 记得住、醒得来、项目之间不串味。**（[English](./README.md)）

## 这个插件做什么

DSH 的 agent 每次会话都从零开始——偏好、决策、来之不易的上下文，聊完就蒸发。`dsh-memory` 解决这个问题：agent 在信息出现时自动存下重要的东西（偏好、项目决策、关键数字、经验教训），并在之后每次会话开场就带着这些记忆。

## 创新点

**1. 分层作用域——跨项目、零混乱**
- **用户级**（`~/.dsh/memory`）：个人偏好存一次，所有项目通用
- **项目级**（`<项目根>/.dsh/memory`）：决策存在它所属的项目里——任意 VCS（git/SVN/Hg）或纯目录均可，随版本库提交、全组共享
- 两级永不混淆：A 项目的决策不会漏进 B 项目，个人风格却处处跟随
- 作用域自动检测（v0.4）：环境变量覆盖 > 向上找已存在的 `.dsh/memory` 标记（支持嵌套子项目）> 任意 VCS 根（`.git`/`.svn`/`.hg`，SVN/Mercurial 项目首次使用即正确锚定）> 当前目录兜底（无 VCS 项目拥有自己的作用域而非涌入用户桶）。`$HOME`、`/`、`/tmp` 永不成为作用域——dotfiles 玩家的 `~/.git` 无法把家目录变成巨型混合桶

**2. 会话启动自动注入**——双域索引直接进系统提示词，开场就带着记忆，不靠模型"想起来去查"

**3. 上下文窗口护栏**——索引 200 行/25KB 硬上限 + 每域 500 条自动修剪 + 超长记忆给截断预览和磁盘路径

**4. Claude Code 兼容读取契约**——memory_read 字段与官方 project_memory_read 一致，习惯无缝迁移

**5. 零负担**——纯文件，无服务无账号无数据库

## 四个工具

`memory_save`（存，自动选作用域）/ `memory_search`（跨域检索）/ `memory_read`（完整读取）/ `memory_list`（双域列表）

**写入规则（v0.5，移植自 Claude Code / Gemini CLI 实践）：**
- **强证据默认**——存前自问"一个月后还有用吗？"，不确定就跳过（记忆噪音比缺口更贵）
- **去重更新**——同主题再存 → 原地更新该记忆（内容替换、时间戳刷新），不追加重复
- **日期索引**——MEMORY.md 每条带 YYYY-MM-DD，注入时模型可推理新旧
- **秘密脱敏**——凭据/令牌/密码永不入库，模型拒绝并明说

## 记忆逻辑（何时记 · 记哪级）

**何时记**：偏好/纠正、项目决策、关键数字/ID、踩坑解法——出现即存；“一个月后还有用吗？”不确定就不记。密钥永不入库。

**记哪级**——关于“这个人”还是“这个工程”？个人偏好/习惯/跨项目经验 → 用户级；项目决策/约定/关键数字 → 项目级（随版本库团队共享）。物理隔离，永不混淆。

**路径标签记忆（v0.6）**：项目记忆自动带子目录标签；根级始终注入，带标签的只在对应目录工作时注入（CLAUDE.md 式按需加载）。

**两段式可见性（v0.7）**：注入索引始终写明其他区域还有几条记忆（如 `+3 more tagged to other areas`），不静默隐藏，模型按需 `memory_search` 取回。

**项目根五级检测**：环境变量 > 已有标记（支持嵌套子项目）> 任意 VCS 根（.git/.svn/.hg）> 宿主注册表 > 当前目录兜底；$HOME、/、/tmp 永不成为作用域。

## 快速开始

```sh
dsh plugin add @fooxe/dsh-memory    # 推荐：一条命令装好并启用

# 或手动（npm / pnpm 均可）：
npm install -g @fooxe/dsh-memory   # 或 pnpm add -g @fooxe/dsh-memory
dsh web --patch ./overlay/dsh-memory.cordis.yml
```

与 DSH 官方 MCP 记忆方案完全共存。MIT 协议。
