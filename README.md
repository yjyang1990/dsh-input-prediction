# dsh-input-prediction

DeepSeek Harness 插件：参考 Codex 的输入预测，在一轮回复结束后，于空输入框中预测你的下一条完整消息。

- 只在回复结束后出现；发送中、输入框有内容或输入法组字时隐藏。
- `Tab`（或 `→`、`Enter`）把预测放入输入框，不会发送，可继续编辑。
- `Esc` 清除本轮预测。
- 预测始终使用当前会话的 Provider；模型、推理强度和最大输出 Token 可在插件页配置。

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
| 预测模型 | 默认跟随当前会话模型；所选模型不在当前会话 Provider 下时，回退到会话模型 |
| 推理强度 | 默认在同模型时沿用会话强度 |
| 最大输出 Token | 默认 160 |

保存后无需重启，下一次回复结束时生效。配置保存在本机 profile 的 `cordis.patch.yml`。

## 更新

在插件页卸载后重新安装即可获取最新版本。

## 许可

MIT
