# DOM Window

只窗口化 ST 的消息 DOM，不改 `chat` 数据。默认关闭。

当前版本 **0.4.2**。历次改动见 [CHANGELOG.md](CHANGELOG.md)。

## 安装

把仓库文件夹放进 SillyTavern 的用户扩展目录（文件夹名可以自己定，例如 `dom-window`）：

```
SillyTavern/data/<用户名>/extensions/dom-window
```

刷新酒馆，控制台出现 `STDOMWindow` 即加载成功。

也可以在酒馆的「扩展程序 → 安装扩展程序」里填入这个仓库的地址，由酒馆直接安装。

## 开关

打开酒馆的「扩展程序」，底部会出现 `DOM Window`。勾选「进入聊天时自动开启」后，当前页面立即启用，并且以后进入酒馆会自动开启；取消勾选会立即关闭并保持关闭。开关保存在本机 `localStorage`，默认关闭。

自动开启使用抽屉里保存的预加载层数（默认 5）：

```js
STDOMWindow.enable({ minWindow: 预加载层数, maxWindow: Math.max(9, 预加载层数), batch: 2, manageTruncation: true })
```

`manageTruncation` 会把 `chat_truncation` 设为 `maxWindow + 10`，减少首次渲染楼层数；关闭时会恢复本次启用前记录的值。

## 预加载楼层

抽屉里的「预加载楼层」默认 5，可填 1–100。它控制首次挂载的楼层数，滚动时仍可按 `maxWindow`（至少 9）扩展。点「保存」会写入本机并弹出「保存后刷新生效」：确认立即刷新并应用，取消只保存、不刷新，下次刷新或重新开启时生效。

## 状态

抽屉里每秒刷新一行状态：运行计时、开启/关闭、窗口楼层范围、已加载/总楼层、DOM 节点数、JS 堆内存。关闭窗口后状态仍然保留，继续显示「已关闭」和当前聊天实际的已加载楼层。内存读数来自 `performance.memory`，仅 Chromium 内核可用，其他浏览器显示 `—`。

## 手动启用

```js
STDOMWindow.enable({ minWindow: 5, maxWindow: 9, batch: 2 })
```

URL 加 `?domwindow=1` 也会自动启用。

## 关闭

```js
STDOMWindow.disable()
```

`disable()` 会移除占位、解除监听，并调用 ST 的 `printMessages()` 恢复原始渲染。

## 兼容接口

```js
STDOMWindow.getChat()                 // 完整 chat 数组
STDOMWindow.getMessageElement(mesid)  // 按需挂载某一层
STDOMWindow.audit()                   // 当前窗口状态
```

## 楼层界面

重新挂载的楼层会调用酒馆助手的 `refreshOneMessage`，补发消息渲染事件，恢复状态栏、立绘等 iframe 界面；`disable()` 恢复原始渲染后也会刷新一遍。没有启用酒馆助手时只做原生渲染，界面不会补回。

## 已知边界

- 只保留视口附近和最后一条消息。直接查 `.mes` 的扩展需要改用 `getMessageElement`。
- 未挂载楼层的编辑/删除需要先滚到该楼层，窗口会自动挂载。
- 楼层里的 iframe/脚本在重新挂载时会重新初始化；界面恢复依赖酒馆助手，未安装时只有正文。
- 手动 `enable()` 默认不改 `chat_truncation`；自动开启会临时调整并在关闭时恢复记录值。

## 版本记录

本版 0.4.2 修复了进入长聊天后源码与渲染无限闪烁的问题，根因和验证结果见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

自定义许可（Copyleft，非商业）：允许作为附加组件使用、复制、修改和分发；修改版必须以同一许可证公开完整源代码；禁止商用。完整条款见 [LICENSE](LICENSE)。这不是 OSI 认可的开源许可证。