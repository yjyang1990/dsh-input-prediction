# dsh-input-prediction

DeepSeek Harness 插件：参考 Codex 的输入预测，在一轮回复结束后，于空输入框中预测你的下一条完整消息；若聚焦空输入框 3 秒仍没有预测内容，会补发一次预测请求；初次请求仍在进行时，等它结束且结果为空后再补发。

- 只在回复正常完成后实时生成；若预测为空且聚焦空输入框持续 3 秒，会再尝试一次；打开或切回旧会话的普通轮询不会触发模型调用。
- 只在回复正常完成后出现；中断或出错的回合不预测；发送中、输入框有内容或输入法组字时隐藏。
- 预测正文到达时逐步显示；完成后按 `Tab`（或 `→`）把预测放入输入框，不会发送，可继续编辑。生成中不可接受，失败或取消时清除预览。
- `Esc` 清除本轮预测。
- 预测模型与会话相同时，沿用会话原有的请求前缀（消息、工具），可命中提示词缓存；换用其他模型时只发送真实用户消息、压缩摘要和助手回复。
- Provider/模型、推理强度、最大输出 Token 和超时可在插件页配置。

## 安装

打开 DeepSeek Harness → **插件** → **添加插件**，填入以下任一地址并安装：

```text
https://codeload.github.com/yjyang1990/dsh-input-prediction/tar.gz/refs/heads/main
```

```text
https://github.com/yjyang1990/dsh-input-prediction.git
```

安装完成后点 **立即启用**，然后重启 DeepSeek Harness。

命令行安装：

```sh
dsh plugin add https://codeload.github.com/yjyang1990/dsh-input-prediction/tar.gz/refs/heads/main
```

## 配置

**插件** → **输入预测** → 组件 **配置 输入预测**：

| 选项 | 说明 |
| --- | --- |
| 回复结束后显示输入预测 | 总开关，默认开启 |
| 预测模型 | 默认跟随当前会话；选择后同时保存 Provider 和模型，所选路由无法解析时回退到会话模型；实际请求失败时预测为空 |
| 推理强度 | 默认使用模型支持的最低强度（如 Off/Low），避免推理耗尽输出 Token |
| 最大输出 Token | 默认 160 |
| 超时（秒） | 默认 30；单次请求超时后无预测，满足空闲条件时仍可补发一次 |

旧配置只有 `predictionModel` 而没有 `predictionProvider` 时：优先使用当前会话 Provider 下的同名模型，否则使用唯一提供该模型的 Provider；有多个 Provider 提供时回退到会话模型。

保存后无需重启，下一次回复结束时生效。配置保存在本机 profile 的 `cordis.patch.yml`。

### OpenAI Responses 和 Chat Completions

插件通过 DSH 的模型 Provider 调用，支持 DSH 已配置的 OpenAI Responses（`openai-responses`）和 OpenAI Chat Completions（`openai-completions`）协议。先在 DSH 的模型设置中添加 Provider，选择对应 API 协议并配置服务地址、凭据和模型；然后在本插件的「预测模型」中选择该 Provider 和模型，或者选择「跟随当前会话模型」。Provider 名称由配置决定，协议名不是固定的 Provider 名称。支持的接口细节和兼容性选项由 DSH 的 Provider 适配器决定。

显式指定 Provider 和模型时，插件通过 DSH 解析该具体路由；模型未列入模型目录本身不代表路由不可用。模型目录仍用于设置页选项，以及旧版仅填写模型名称时匹配 Provider。实际请求失败时会记录日志，预测结果为空。

### 排查没有预测内容

在 DSH Host 日志中搜索 `dsh-input-prediction:`。`event=loaded` 表示服务端插件加载，`event=turn_end` 表示收到回合结束事件，`event=skip` 记录不启动预测的原因，`event=start` 记录预测开始；`event=request_prepare`、`event=request_stream` 和 `event=response_parsed` 分别记录模型路由和请求阶段、流开始、解析结果，`result=` 记录完成结果及耗时 `elapsedMs`，`event=cancel` 记录取消原因，`event=disposed` 记录会话销毁时的清理状态，`event=retry_suppressed` 记录重复补发被拦截。`request` 标识本进程中的一次请求，`flow` 关联同一回合的首次预测与补发，`attempt` 是该回合的第几次请求；重启后编号会重置。`trigger` 区分回复结束和空闲触发，`completionSeq` 是回合序号。被取消的请求记录 `event=cancel`，不会产生 `result=`。成功结果使用 info 级别，其他结果使用 warn 级别。日志不包含预测文本、会话内容、会话 ID 或 Provider 返回的原始错误；普通轮询不会逐次记录。

| `result` | 含义 |
| --- | --- |
| `ok` | 生成了预测；若界面未显示，请检查输入框是否为空，以及是否正在回复、锁定或进行输入法组字。 |
| `model_declined` | 模型按提示返回 `suggestion: null`。 |
| `empty_output` | 模型没有返回文本。 |
| `invalid_json` | 返回的文本无法解析为单个 JSON 对象。 |
| `invalid_suggestion` | `suggestion` 缺失、类型错误或是空字符串。 |
| `max_tokens` | 输出触及 Token 上限；若已返回完整建议，仍会显示该建议。可尝试提高最大输出 Token 或降低推理强度。 |
| `timeout` | 请求超时。 |
| `provider_error` | Provider 调用失败或中止；日志不保留原始错误详情。 |
| `no_context` / `missing_route` | 会话没有可用上下文，或会话缺少模型路由。 |

`event=route_timing`、`context_timing`、`prepare_timing` 记录路由解析、上下文构造及调用准备耗时。`event=stream_summary` 分别记录模型返回的思考和正文增量次数及字符数、首个非空增量的相对耗时 `firstReasoningMs` / `firstTextMs` 和结束事件耗时 `finishMs`；未出现为 `null`。这些流内耗时从调用流开始计算，包括网络、服务商排队及生成，不能单独区分它们；字符数不等于 Token 数，且取决于 Provider 实际返回的增量类型。

前端会将加载、接口访问、后端状态、展示条件及空闲补发的状态变化回传到 Host 日志，事件名分别为 `event=client_loaded`、`client_poll`、`client_backend`、`client_display` 和 `client_idle`。浏览器 Console 中也可搜索 `[dsh-input-prediction]`。重复状态不会反复记录；回传不包含会话 ID、输入或预测文本。

同一会话最新完成预测的状态接口也会在 `ready` 时返回 `reason`；它只保存最新状态，历史原因请查看日志。Host 日志是否写入磁盘取决于 DSH 配置，默认日志缓冲区保存在运行进程内。

## 测试

```sh
pnpm test
```

协议集成测试使用本机 DSH 安装中的 pi-ai 适配器和本地 HTTP 模拟服务。非默认安装路径可通过 `DSH_ROOT` 指定；未找到默认安装时跳过该集成测试。

## 更新

在插件页卸载后重新安装即可获取最新版本。

## 许可

MIT
