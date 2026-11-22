// 新建工程模板(模板内容单一来源在 Rust 侧 scaffold.rs,此处只列目录)
import * as backend from './backend';

export interface ProjectTemplate {
  id: string;
  name: string;
  desc: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'console', name: '控制台示例（可直接运行）', desc: '主.xt + 玄铁.配置.toml,建好即可 ▶ 运行' },
  { id: 'empty', name: '空白工程', desc: '仅目录骨架与工程配置' },
  { id: 'lan-im', name: '局域网即时通讯 Shell 工具', desc: '同一程序可开房/加入,在局域网里收发消息' },
  { id: 'cube3d', name: '3D 立方体渲染', desc: '运行即见缓慢自转、上下浮动的立方体' },
  { id: 'mario2d', name: '2D 游戏：马里奥', desc: '矩形/圆形精灵,无需素材;方向键移动、空格跳跃' },
];

export function createProject(parentDir: string, name: string, templateId: string): Promise<string> {
  return backend.scaffoldProject(parentDir, name, templateId);
}
