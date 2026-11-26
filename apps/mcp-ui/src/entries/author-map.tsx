import { mountScaffold } from "../mount.js";

mountScaffold({
  kicker: "Dentalbook authors",
  title: "作者与机构地图",
  description: "业务工具尚未实现。未来此处以 MapLibre 呈现机构点位和作者详情；网络域会由 MCP 资源的最小 CSP allowlist 控制。",
  resourceUri: "ui://dentalbook/author-map/v1",
});
