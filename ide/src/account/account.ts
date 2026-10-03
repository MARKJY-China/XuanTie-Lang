// 账号:对接玄铁社区(XuanTieCommunity)现有账号端点,中枢决策记录见 ide/NOTES.md
// 契约(以 server/auth.go 为准):
//   POST /api/auth/code     {email}
//   POST /api/auth/register {email, code, username, password, invite_code?}
//   POST /api/auth/login    {account, password}   → Set-Cookie: xt_session=…(30 天)
//   GET  /api/me            (Cookie)              → {ok, data:{user:{username,…}, unread}}
//   POST /api/auth/logout   (Cookie)
//   响应统一 {ok:true, data:…} / {ok:false, error:"…"}
import * as backend from '../backend';

interface ApiEnvelope {
  ok?: boolean;
  error?: string;
  data?: { user?: { username?: string } | null } | null;
}

interface ApiCall {
  status: number;
  sessionCookie: string;
  json: ApiEnvelope;
}

async function api(
  base: string,
  method: string,
  path: string,
  body?: unknown,
  cookie?: string,
): Promise<ApiCall> {
  // 服务端用 c.Cookie("xt_session") 解析,Cookie 头必须带名;裸值会被静默忽略
  const cookieHeader = cookie ? `xt_session=${cookie}` : undefined;
  const res = await backend.httpJson(
    method,
    base.replace(/\/+$/, '') + path,
    body ?? null,
    cookieHeader,
  );
  let json: ApiEnvelope = {};
  try {
    json = JSON.parse(res.body) as ApiEnvelope;
  } catch {
    // 非 JSON 响应(反代错误页等):保留 status 供上层报错
  }
  return { status: res.status, sessionCookie: res.sessionCookie, json };
}

export async function login(
  base: string,
  account: string,
  password: string,
): Promise<{ cookie: string; username: string }> {
  const r1 = await api(base, 'POST', '/api/auth/login', { account, password });
  if (!r1.json.ok) {
    throw new Error(r1.json.error ?? `登录失败(HTTP ${r1.status})`);
  }
  const cookie = r1.sessionCookie;
  if (!cookie) throw new Error('服务端未返回会话令牌');
  const r2 = await api(base, 'GET', '/api/me', undefined, cookie);
  const username = r2.json.data?.user?.username || account;
  return { cookie, username };
}

export async function sendCode(base: string, email: string): Promise<void> {
  const r = await api(base, 'POST', '/api/auth/code', { email });
  if (!r.json.ok) throw new Error(r.json.error ?? '验证码发送失败');
}

export async function register(
  base: string,
  email: string,
  code: string,
  username: string,
  password: string,
  inviteCode: string,
): Promise<void> {
  const r = await api(base, 'POST', '/api/auth/register', {
    email,
    code,
    username,
    password,
    invite_code: inviteCode || undefined,
  });
  if (!r.json.ok) throw new Error(r.json.error ?? `注册失败(HTTP ${r.status})`);
}

export async function logout(base: string, cookie: string): Promise<void> {
  try {
    await api(base, 'POST', '/api/auth/logout', undefined, cookie);
  } catch {
    // 服务端登出失败也照常清理本地状态
  }
}

// 校验本地会话是否仍有效,有效则返回用户名
export async function verify(base: string, cookie: string): Promise<string | null> {
  try {
    const r = await api(base, 'GET', '/api/me', undefined, cookie);
    if (r.json.ok && r.json.data?.user?.username) return r.json.data.user.username;
    return null;
  } catch {
    return null;
  }
}
