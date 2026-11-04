Keynote —— PPTist 完整应用套件的本地应用形态：完整编辑（全部元素类型/
动画/转场）、放映（键盘/点击/滑动，保留动画与转场）、导出 PPTX/JSON、
导入 PPTX/JSON/pptist；编程面 window.PptApp（load/dump/describe/增删改
幻灯片/renderSlides/事件订阅，控制台 PptApp.help() 自述全量 API），供宿主
作品与 Agent 直接调用。

## 结构（大包不进 CODE 段）

- 4.4MB 运行时真源 = 后端资产 system_works/assets/ppt-full-app.js（与
  bundle 同信任级；exe 打包随 system_works 整目录注入）；
- CODE 段只做装载器：apiFetch 经网关 GET /api/desktop/works/app-asset
  取文（JSON {code}）→ 动态 <script> 注入，一页至多一次，之后
  window.PptApp 常驻复用；
- 预置哑 window.Work 注册面：包内自带 Work.register 适配分支是云端作品
  播放器的挂载通道，壳内无此全局——不预置它会退化成自挂 document.body
  砸掉桌面；注入完成即还原。

## 验证记录

2026-10-21：桌面实测通过——启动台/ABI 打开、编辑器完整渲染（4 页示例
deck、设计/切换/动画面板）、编程面 addSlide/removeSlide/present/
exitPresent/dump 全通、导出 PPTX 真出 1.36MB blob（MIME
presentationml.presentation）、关窗即卸载且 body 行内样式零残留、二次
打开零重下（PptApp 常驻）。闸门 check-engines/layers/content/origin
全绿；后端 app-asset 端点单测（名字白名单/404/下发形状）随 test_main。
