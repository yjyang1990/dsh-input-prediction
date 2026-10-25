# dsh-input-prediction

DeepSeek Harness 插件：参考 Codex 的输入预测，在一轮回复结束后，于空输入框中预测你的下一条完整消息。

- 只在回复正常完成后实时生成；打开或切回旧会话不会触发模型调用。
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

## 测试

```sh
pnpm test
```

## 更新

在插件页卸载后重新安装即可获取最新版本。

## 许可

MIT
