// file:/// URI ↔ 本机路径
// 服务器端(lsp/xt_lsp.xt 的 路径转URI,:709-728)格式:
//   file:/// + 反斜杠转斜杠 + ":" → "%3A" + 多字节字符逐字节百分号编码
// 本端编码用 encodeURIComponent 分段(冒号/中文都会编码,格式兼容,服务器只当 dict 键用);
// 本端解码必须 decodeURIComponent 兜底,再斜杠转回反斜杠。

export function pathToUri(path: string): string {
  const norm = path
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return 'file:///' + norm;
}

export function uriToPath(uri: string): string {
  let p = uri.startsWith('file:///') ? uri.slice('file:///'.length) : uri;
  try {
    p = decodeURIComponent(p);
  } catch {
    // 非法百分号序列(路径含字面 % 等)保留原样
  }
  return p.replace(/\//g, '\\');
}
