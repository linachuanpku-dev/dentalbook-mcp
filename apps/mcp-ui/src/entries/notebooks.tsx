import { mountScaffold } from "../mount.js";

mountScaffold({
  kicker: "Dentalbook notebooks",
  title: "笔记本管理",
  description: "业务工具尚未实现。未来此处显示最近笔记本、篇数、同步与抓取状态；所有写入必须通过 MCP tools/call 获得真实回执。",
  resourceUri: "ui://dentalbook/notebooks/v1",
});
