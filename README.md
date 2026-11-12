# dsh-input-prediction

DeepSeek Harness 插件：参考 Codex 的输入预测，在一轮回复结束后，于空输入框中预测你的下一条完整消息；若聚焦空输入框 3 秒仍没有预测内容，会补发一次预测请求；初次请求仍在进行时，等它结束且结果为空后再补发。

- 只在回复正常完成后实时生成；若预测为空且聚焦空输入框持续 3 秒，会再尝试一次；打开或切回旧会话的普通轮询不会触发模型调用。
- 只在回复正常完成后出现；中断或出错的回合不预测；发送中、输入框有内容或输入法组字时隐藏。
- `Tab`（或 `→`）把预测放入输入框，不会发送，可继续编辑。
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
| 预测模型 | 默认跟随当前会话；选择后同时保存 Provider 和模型，该模型不可用时回退到会话模型 |
| 推理强度 | 默认使用模型支持的最低强度（如 Off/Low），避免推理耗尽输出 Token |
| 最大输出 Token | 默认 160 |
| 超时（秒） | 默认 30；超时后本轮不显示预测 |

旧配置只有 `predictionModel` 而没有 `predictionProvider` 时：优先使用当前会话 Provider 下的同名模型，否则使用唯一提供该模型的 Provider；有多个 Provider 提供时回退到会话模型。

保存后无需重启，下一次回复结束时生效。配置保存在本机 profile 的 `cordis.patch.yml`。

### OpenAI Responses 和 Chat Completions

插件通过 DSH 的模型 Provider 调用，支持 DSH 已配置的 OpenAI Responses（`openai-responses`）和 OpenAI Chat Completions（`openai-completions`）协议。先在 DSH 的模型设置中添加 Provider，选择对应 API 协议并配置服务地址、凭据和模型；然后在本插件的「预测模型」中选择该 Provider 和模型，或者选择「跟随当前会话模型」。Provider 名称由配置决定，协议名不是固定的 Provider 名称。支持的接口细节和兼容性选项由 DSH 的 Provider 适配器决定。

显式指定 Provider 和模型时，插件通过 DSH 解析该具体路由；模型未列入模型目录本身不代表路由不可用。模型目录仍用于设置页选项，以及旧版仅填写模型名称时匹配 Provider。实际请求失败时会记录日志，预测结果为空。

### 排查没有预测内容

在 DSH 日志中搜索 `dsh-input-prediction: result=`。每次请求完成都会记录结果、触发方式（`turn-end` 或 `focus-idle`）和回合序号；自动补发也会单独记录，因此首次请求的原因不会被补发结果覆盖。成功结果使用 info 级别，其他结果使用 warn 级别。日志不包含预测文本、会话内容或 Provider 返回的原始错误。

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

同一会话最新完成预测的状态接口也会在 `ready` 时返回 `reason`；它只保存最新状态，历史原因请查看日志。

## 测试

```sh
pnpm test
```

协议集成测试使用本机 DSH 安装中的 pi-ai 适配器和本地 HTTP 模拟服务。非默认安装路径可通过 `DSH_ROOT` 指定；未找到默认安装时跳过该集成测试。

## 更新

在插件页卸载后重新安装即可获取最新版本。

## 许可

MIT
