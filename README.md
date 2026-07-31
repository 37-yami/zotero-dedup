# Zotero Dedup

一个 Zotero 去重插件（面向 **Zotero 9 / 7+** 的 bootstrap 架构）。

在「工具」菜单中提供「开始扫描（去重）」，扫描当前收藏夹或选中条目所在分类中的重复文章，并在弹窗中让你逐组决定如何处理，最后把要删除的文献**移入回收站**（可在回收站中恢复，不会彻底删除）。

## 功能

- **入口**：Zotero 顶部菜单「工具」→「开始扫描（去重）」。
- **扫描范围**（可在设置中切换默认项）：
  - 当前选中的收藏夹；
  - 当前选中条目所在分类。
- **查重规则**（可在「设置」→「Zotero Dedup」中切换）：
  - 按 DOI（最严格，无 DOI 不参与匹配）；
  - 标题 + 作者 + 年份（推荐）；
  - 仅按标题归一化。
- **结果窗口（单窗口）**：
  - 每一组重复文章可独立选择：**保留一篇（删除其余）** / **全部删除** / **跳过**；
  - 选择「保留一篇」时，可指定保留哪一篇（默认保留第一篇）；
  - 顶部「为所有任务都执行」可一键把某个选项应用到全部重复组；
  - 底部「执行删除」将选中的文献移入回收站。
- **关闭行为**：
  - 每个重复组卡片右上角的 `×` = 只关闭这一组（跳过）；
  - 关闭整个窗口（× / 取消）会弹出确认：可选择「仅关闭当前组（跳过本组）」或「关闭所有窗口（放弃全部）」。

## 安装

1. 到 [Releases](https://github.com/37-yami/zotero-dedup/releases) 下载 `zotero-dedup.xpi`；
2. 在 Zotero 中：`工具` → `插件`（或 `Add-ons`）→ 齿轮图标 → `Install Add-on From File...` → 选择下载的 `.xpi`；
3. 重启 Zotero。

> 若浏览器把 `.xpi` 当作文本，请右键「另存为」或下载后手动选择文件安装。



## 目录结构

```
addon/                 # 直接对应 .xpi 的内容
  manifest.json        # 插件清单（Zotero 7+ bootstrap）
  bootstrap.js         # 生命周期、工具菜单、扫描与打开对话框
  chrome.manifest      # content 包注册
  prefs.js             # 首选项默认值
  content/
    dedupDialog.xhtml  # 扫描结果窗口
    options.xhtml      # 设置面板
build.mjs              # 打包脚本
update.json            # 自动更新清单
```

## 许可

MIT — 见 [LICENSE](LICENSE)。
