// 新建工程模板(模板内容单一来源在 Rust 侧 scaffold.rs,此处只列目录)
import * as backend from './backend';

export interface ProjectTemplate {
  id: string;
  name: string;
  desc: string;
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'console', name: '控制台示例', desc: '主.xt + 玄铁.配置.toml,建好即可 ▶ 运行' },
  { id: 'empty', name: '空白工程', desc: '仅目录骨架与工程配置' },
];

export function createProject(parentDir: string, name: string, templateId: string): Promise<string> {
  return backend.scaffoldProject(parentDir, name, templateId);
}
