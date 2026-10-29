# AI 标签整理

一个 Chrome 扩展：只在你点「一键整理」时，按你正在做的事把标签页分进 Chrome 原生标签组。

- **你不点，它不动。** 新开的标签页不会被自动分组。
- **只动没归属的标签页。** 已有分组不改名、不拆、不移动组内标签页。
- **拿不准就留在组外**，并告诉你有几个；按域名整理是一个需要你点的按钮，不会自动退回去。
- **关标签页必须你确认。** 重复页和空白页只给建议。
- **撤销只回退它自己做的事。** 你之后手动调整过的标签页不会被撤销覆盖。
- **默认不向云端发送浏览数据。** 模型来源由你选择：本地 Gemini Nano、自定义接口（如 Ollama）或云端 OpenAI 兼容接口。

## 开发

需要 Node 20+ 和 Chrome 138+。

```bash
npm install
npm run build      # 输出到 dist/
npm test           # 单元测试
```

在 Chrome 打开 `chrome://extensions`，开启「开发者模式」，点「加载已解压的扩展程序」，选择 `dist/` 目录。开发时可以用 `npm run dev` 持续构建，改动后在扩展页点刷新。

### 端到端测试

用 Chrome for Testing 加载构建好的扩展，配一个本地假模型服务，检查整理、保护已有分组、纠正记录、撤销、清理建议和按域名整理：

```bash
npm run e2e:chrome   # 下载 Chrome for Testing 到 .cache/chrome
CHROME_PATH=".cache/chrome/chrome/<版本目录>/.../Google Chrome for Testing" npm run e2e
```

截图保存在 `.e2e/`。

## 效果评测（M0）

在设置页底部的「效果评测」里：

1. 打开 30–50 个真实在用的标签页，点「导出当前标签页」，得到 `tab-sample-日期.csv`（只含标题和去掉参数的网址）。
2. 在 `expected` 列写每个标签页应该属于的项目名；最好留在组外的写 `-`；不评的留空。
3. 载入文件，勾选要对比的方式（按域名基线、本地模型、自定义接口、云端），运行。

指标：

| 指标 | 含义 |
| --- | --- |
| 覆盖率 | 已分组 / 已标注 |
| 错分率 | 分错组的（或标了 `-` 却被分组的）/ 已分组。每个组按多数标签认定它代表哪个项目 |
| 漏分率 | 属于项目却留在组外的 / 属于项目的 |
| 拆分 | 一个项目被拆成多个组的次数 |
| 格式失败 | 模型返回无法解析的次数，含重试 |

模型评测走的是和一键整理相同的分批、校验代码，从零开始（没有已知项目和纠正记录）。报告可以下载成 JSON。

## 结构

| 路径 | 作用 |
| --- | --- |
| `src/core/planner.ts` | 选出可整理的标签页，按已确认的网址规则和打开关系先分 |
| `src/core/prompt.ts` | 构造 prompt、校验模型输出（模型只能建议归组） |
| `src/core/models/` | Gemini Nano 与 OpenAI 兼容接口 |
| `src/core/organize.ts` | 一键整理的完整流程 |
| `src/core/actions.ts` | 执行分组、关闭所选标签页、撤销 |
| `src/core/undo.ts` | 根据操作日志计算撤销动作 |
| `src/core/learning.ts` | 记录手动调整、锁定、网址规则建议 |
| `src/core/cleanup.ts` | 重复页和空白页建议 |
| `src/core/classify.ts` | 分批调用模型并校验，一键整理和评测共用 |
| `src/core/eval.ts` | 评测样本 CSV、域名基线、指标 |
| `src/background/` | Service worker：消息和事件监听（只记录，不分组） |
| `src/popup/`、`src/options/` | 弹出窗口和设置页 |

## 许可

MIT
