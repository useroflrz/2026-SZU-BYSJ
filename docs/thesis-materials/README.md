# 毕业论文素材索引

本目录存放面向**中文毕业论文**撰写的结构化素材，与仓库实现保持一致。若与 [docs/README.md](../README.md) 中“后端为扩展方向”等历史表述不一致，**以当前代码与本文档为准**。

## 与论文章节的对照

| 论文章节（建议） | 推荐阅读素材 |
|------------------|--------------|
| 摘要、关键词 | [01-摘要与关键词建议.md](./01-摘要与关键词建议.md) |
| 绪论 / 研究意义 / 创新点 | [02-技术亮点与创新点.md](./02-技术亮点与创新点.md)、[03-问题背景与解决方案.md](./03-问题背景与解决方案.md) |
| 需求分析、功能描述 | [04-系统功能与模块对照表.md](./04-系统功能与模块对照表.md) |
| 总体设计、架构与流程 | [05-架构与数据流（论文叙述版）.md](./05-架构与数据流（论文叙述版）.md) |
| 系统实现（前后端） | [04-系统功能与模块对照表.md](./04-系统功能与模块对照表.md)、[02-技术亮点与创新点.md](./02-技术亮点与创新点.md) |
| 实验、测试与评价 | [06-实验与评价指标建议.md](./06-实验与评价指标建议.md) |
| 致谢、工具声明 | [07-致谢与声明用语参考.md](./07-致谢与声明用语参考.md) |

## 本目录文件列表

- [01-摘要与关键词建议.md](./01-摘要与关键词建议.md)
- [02-技术亮点与创新点.md](./02-技术亮点与创新点.md)
- [03-问题背景与解决方案.md](./03-问题背景与解决方案.md)
- [04-系统功能与模块对照表.md](./04-系统功能与模块对照表.md)
- [05-架构与数据流（论文叙述版）.md](./05-架构与数据流（论文叙述版）.md)
- [06-实验与评价指标建议.md](./06-实验与评价指标建议.md)
- [07-致谢与声明用语参考.md](./07-致谢与声明用语参考.md)

## 延伸阅读（仓库原有设计文档）

- [01-项目概述.md](../01-项目概述.md)
- [02-技术架构.md](../02-技术架构.md)
- [03-前端设计.md](../03-前端设计.md)
- [04-后端API设计.md](../04-后端API设计.md)（草案；实际路由以 `backend/main.py` 为准）
- [05-功能模块设计.md](../05-功能模块设计.md)
- [06-数据流程.md](../06-数据流程.md)
- [07-部署方案.md](../07-部署方案.md)

## 关键实现路径（写“系统实现”章节时可引用）

- 前端格网渲染与拾取：`frontend/src/stores/map.js`、`frontend/src/Rendering/BeiDouGridPrimitive.js`、`frontend/src/components/MapViewer.vue`
- 可视域分析调用链：`frontend/src/stores/analysis.js`、`frontend/src/components/AnalysisPanel.vue`、`frontend/src/Analysis/apiClient.js`
- 后端 API 入口：`backend/main.py`
- 可视域计算：`backend/app/core/viewshed_engine.py`
- 分析作业调度：`backend/app/core/job_manager.py`
- 柱掩膜作业：`backend/app/core/mask_job_manager.py`（及前端 `runColumnMaskJobAndWait`）

## 代码证据索引（论文写作优先引用）

为避免“描述正确但无法追溯”，建议在每节正文后用“实现依据：路径 + 关键常量/函数名”的方式标注。若历史文档与此处不一致，以代码实现为准。

| 素材文档 | 前端证据路径 | 关键常量/函数（建议写进正文） |
|---|---|---|
| `01-摘要与关键词建议.md` | `frontend/src/stores/map.js`、`frontend/src/Rendering/BeiDouGridPrimitive.js`、`frontend/src/stores/analysis.js` | `MAX_GEOMETRY_INSTANCES=120000`、`pick()`、`runGridViewshedAnalysis()` |
| `02-技术亮点与创新点.md` | `frontend/src/stores/map.js`、`frontend/src/Rendering/BeiDouGridPrimitive.js`、`frontend/src/components/MapViewer.vue` | `showBeiDouGrid()` 分流、`MAX_BATCH_INSTANCES=65535`、GPU pick 解码 |
| `03-问题背景与解决方案.md` | `frontend/src/stores/map.js`、`frontend/src/Analysis/apiClient.js`、`frontend/src/stores/analysis.js` | `prepareBeiDouGridDataset()`、`runColumnMaskJobAndWait()`、`_sleep(500)` 轮询 |
| `04-系统功能与模块对照表.md` | `frontend/src/components/GridConfig.vue`、`frontend/src/components/GridPerformanceLab.vue`、`frontend/src/components/SignalStrengthLab.vue` | 参数输入字段、跑批采样窗口、FSPL 参数组 |
| `05-架构与数据流（论文叙述版）.md` | `frontend/src/components/MapViewer.vue`、`frontend/src/stores/map.js`、`frontend/src/stores/analysis.js` | pick 分流链路、`groundHeights` 采样与缓存、`uncoveredIndices` 结果回写 |
| `06-实验与评价指标建议.md` | `frontend/src/components/GridPerformanceLab.vue`、`frontend/src/components/SignalStrengthLab.vue` | 预热/采样时长、`LARGE_ONLY_TARGET_MIN=2000000`、FSPL 变量 |
| `论文.md` | `frontend/src/components/*.vue`、`frontend/src/stores/*.js`、`frontend/src/Rendering/BeiDouGridPrimitive.js` | 阈值口径、批次上限口径、分析轮询口径 |

## 统一口径（建议全文保持一致）

- 渲染模式：总格元数 `> 120000` 时默认切换 `instanced`，否则 `geometryInstances`。
- 大规模绘制：实例分批上限 `65535`，超过后自动拆批提交。
- 分析任务：前端提交作业后按约 `500ms` 周期轮询状态，完成后拉取结果。
- 性能跑批：默认“预热 + 采样”窗口统计 FPS；目标规模 `>=2000000` 时仅测 instanced。
- 摘要与正文中不要写未实测结论；可保留“待补实测”占位。
