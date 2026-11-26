import { mountScaffold } from "../mount.js";

mountScaffold({
  kicker: "Dentalbook system",
  title: "MCP App 兼容性探针",
  description: "验证内联渲染、浅色样式、标准 tools/call，以及宿主可选的全屏能力。它不访问任何论文或用户数据。",
  resourceUri: "ui://dentalbook/system-probe/v2",
  probe: true,
});
