# dsh-session-archive

会话闲置归档插件（宿主内，路线甲）。闲置超过阈值（默认 2 天）的会话自动归档到
`~/.dsh/sessions-archive/`，连带清理 projcache 与 workspace 记账（官方 API）。

架构参考 [dsh-session-pruner](https://www.npmjs.com/package/dsh-session-pruner) 0.3.3
（Apache-2.0, mrzhangkris），代码自写。关键差异：多帧 zstd 解压自带实现（node zlib），
不依赖系统 zstd 命令。

## 安全三层

1. **live fail-closed**：宿主内存 store 挂着的会话绝不归档（查询异常也算 live）
2. **pin 三层**：《痕》账本全部 lead（实时重读，新一代自动受保护，含裸 UUID 落盘形态）
   + `hub/pin-sessions.txt` + 面板白名单
3. **脑 fail-closed**：《痕》最后一条 lead 指向的会话，出现在候选即拒绝

## 判型

闲置 = 会话日志文件 mtime（DSH 追加写保证活跃会话永不误判）。
闲置即归档，不分类（2026-11-05 熙枫拍板）；类型判定保留供容量保底排序用。

## 与 dsh-session-pruner 的差异

- 闲置全类型归档（pruner 默认 main/continuable 关闭）
- 无归档到期自动删除：保留期只在面板状态行提醒，删原文必须人手动
- zstd 自带实现
- 容量保底默认关闭

## 安装

```sh
dsh plugin --profile desktop add D:/Code/dsh-session-archive
```

## 配置（设置 → 会话闲置归档，热加载）

闲置天数（2）/ 扫描间隔（60min）/ one-shot 宽限（3min）/ Pin 白名单 / 容量保底（0=关）/ 保留期（0=永久，到期只提醒）

手动触发：面板「立即扫描」按钮，或 POST /plugins/dsh-session-archive/run-once。
