Keynote 导演台（兼容入口）—— 早期中间件形态：左侧对话 + 独立 Keynote
舞台 + 桥控制台。其能力（语义指令、版式成稿、截图回传、dsh 内嵌）已
全部并入「Keynote 一体工作台」（keystudio），指令分发收敛到
ppt-bridge/src/core/ops.js 单一实现。

本作品保留图标入口，打开即拉起一体工作台；不再单独维护一套轮询/分发。
