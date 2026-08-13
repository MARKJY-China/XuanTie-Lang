// xt_net.c — 玄铁跨平台网络栈 v1.1 (Phase 2)
// HTTP GET + TCP 连接/监听 + Socket GC 集成
// Windows: Winsock2    Linux/macOS: POSIX sockets

#include "xt_net.h"
#include "xt_runtime.h"
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <process.h>
#pragma comment(lib, "ws2_32.lib")
typedef SOCKET xt_sock_t;
#define XT_INVALID_SOCK INVALID_SOCKET
#define xt_sock_close closesocket
#else
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <netdb.h>
#include <unistd.h>
#include <pthread.h>
typedef int xt_sock_t;
#define XT_INVALID_SOCK (-1)
#define xt_sock_close close
#endif

// 前向声明
static int resolve_host(const char* host, struct sockaddr_in* addr);
static xt_sock_t create_connection(const char* host, int port);
// ============================================================
// 平台初始化
// ============================================================
int xt_net_init(void) {
#if defined(_WIN32)
    WSADATA wsa;
    return WSAStartup(MAKEWORD(2, 2), &wsa) == 0 ? 0 : -1;
#else
    return 0;
#endif
}

void xt_net_cleanup(void) {
#if defined(_WIN32)
    WSACleanup();
#endif
}

// ============================================================
// DNS 解析
// ============================================================
static int resolve_host(const char* host, struct sockaddr_in* addr) {
    struct hostent* he = gethostbyname(host);
    if (!he) return -1;
    memset(addr, 0, sizeof(*addr));
    addr->sin_family = AF_INET;
    memcpy(&addr->sin_addr, he->h_addr, he->h_length);
    return 0;
}

// ============================================================
// Socket 创建与连接
// ============================================================
static xt_sock_t create_connection(const char* host, int port) {
    struct sockaddr_in addr;
    if (resolve_host(host, &addr) != 0) return XT_INVALID_SOCK;
    addr.sin_port = htons((unsigned short)port);

    xt_sock_t sock = socket(AF_INET, SOCK_STREAM, 0);
    if (sock == XT_INVALID_SOCK) return XT_INVALID_SOCK;
    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        xt_sock_close(sock); return XT_INVALID_SOCK;
    }
    return sock;
}

// ============================================================
// Socket 对象生命周期
// ============================================================

// 创建 XTSocket（由 XT 内存管理，ref_count 归零时自动清理）
XTSocket* xt_net_new_socket(xt_sock_t raw_sock, int is_listener) {
    XTSocket* s = (XTSocket*)xt_malloc(sizeof(XTSocket), XT_TYPE_SOCKET);
    s->sock = (void*)(uintptr_t)raw_sock;
    s->is_closed = 0;
    s->is_listener = is_listener;
    return s;
}

// 关闭 socket 并标记为已关闭（由 xt_free_obj 或用户显式调用）
void xt_net_close_obj(XTSocket* s) {
    if (!s || s->is_closed) return;
    xt_sock_t raw = (xt_sock_t)(uintptr_t)s->sock;
    if (raw != XT_INVALID_SOCK) {
        xt_sock_close(raw);
    }
    s->is_closed = 1;
    s->sock = (void*)(uintptr_t)XT_INVALID_SOCK;
}

// ============================================================
// HTTP GET
// ============================================================

typedef struct { char* data; int len; int cap; } http_buf;
static void buf_add(http_buf* b, const char* d, int n) {
    if (b->len + n >= b->cap) { b->cap = (b->cap + n) * 2; b->data = (char*)realloc(b->data, b->cap); }
    memcpy(b->data + b->len, d, n); b->len += n;
}

void* xt_net_http_get(const char* url) {
    int use_tls = 0;
    const char* p = NULL;
    if (url && strncmp(url, "http://", 7) == 0) {
        p = url + 7;
    } else if (url && strncmp(url, "https://", 8) == 0) {
        use_tls = 1;
        p = url + 8;
    }
    if (!p) {
        char* e = (char*)malloc(256);
        snprintf(e, 256, "不支持的协议: %s", url ? url : "(null)");
        return e;
    }

    char host[256] = {0}; int port = use_tls ? 443 : 80; const char* path = "/";
    const char* slash = strchr(p, '/');
    const char* colon = strchr(p, ':');
    if (colon && (!slash || colon < slash)) {
        size_t hl = (size_t)(colon - p); if (hl >= 256) hl = 255;
        memcpy(host, p, hl); port = atoi(colon + 1);
    } else if (slash) {
        size_t hl = (size_t)(slash - p); if (hl >= 256) hl = 255;
        memcpy(host, p, hl);
    } else { size_t l = strlen(p); if (l >= 256) l = 255; memcpy(host, p, l); }
    if (slash) path = slash;

    xt_sock_t sock = create_connection(host, port);
    if (sock == XT_INVALID_SOCK) {
        char* e = (char*)malloc(256); snprintf(e, 256, "无法连接到 %s:%d", host, port); return e;
    }

    // HTTPS:先建立 TLS 会话(Schannel,系统原生,零外部依赖)
    void* tls = NULL;
    if (use_tls) {
        if (xt_tls_handshake(sock, host, &tls) != 0) {
            xt_sock_close(sock);
            char* e = (char*)malloc(256); snprintf(e, 256, "TLS 握手失败: %s:%d", host, port); return e;
        }
    }

    char req[1024];
    snprintf(req, sizeof(req), "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", path, host);

    if (use_tls) {
        if (xt_tls_send(tls, req, (int)strlen(req)) != 0) {
            xt_tls_close(tls); xt_sock_close(sock);
            char* e = (char*)malloc(256); snprintf(e, 256, "发送请求失败"); return e;
        }
    } else {
        if (send(sock, req, (int)strlen(req), 0) <= 0) {
            xt_sock_close(sock); char* e = (char*)malloc(256); snprintf(e, 256, "发送请求失败"); return e;
        }
    }

    http_buf buf = {NULL, 0, 0}; char chunk[4096]; int n;
    if (use_tls) {
        while ((n = xt_tls_recv(tls, chunk, sizeof(chunk)-1)) > 0) buf_add(&buf, chunk, n);
        xt_tls_close(tls);
    } else {
        while ((n = recv(sock, chunk, sizeof(chunk)-1, 0)) > 0) buf_add(&buf, chunk, n);
    }
    xt_sock_close(sock);
    if (buf.len == 0) { free(buf.data); char* e = (char*)malloc(256); snprintf(e, 256, "响应为空"); return e; }

    buf_add(&buf, "", 1);
    char* body = strstr(buf.data, "\r\n\r\n");
    if (body) { body += 4; char* r = strdup(body); free(buf.data); return r; }
    return buf.data;
}

// ============================================================
// 增强 HTTP 客户端:求(url, 选项) 双参形态
// 选项: {"方法": "POST", "头": {键: 值}, "体": "...", "超时": 毫秒}
// 返回 结果;成功时 值 = {"状态码": 整, "体": 字, "头": 字典}
// ============================================================

static const char* xt_opt_str(XTValue opts, const char* key, const char* dflt) {
    if (!XT_IS_REAL_PTR(opts)) return dflt;
    XTObject* o = (XTObject*)opts;
    if (o->type_id != XT_TYPE_DICT) return dflt;
    XTString* k = xt_string_new(key);
    XTValue v = xt_dict_get(opts, (XTValue)k);
    xt_release((XTValue)k);
    if (!XT_IS_REAL_PTR(v)) return dflt;
    XTObject* vo = (XTObject*)v;
    if (vo->type_id != XT_TYPE_STRING) return dflt;
    return ((XTString*)v)->data;
}

static int64_t xt_opt_int(XTValue opts, const char* key, int64_t dflt) {
    if (!XT_IS_REAL_PTR(opts)) return dflt;
    XTObject* o = (XTObject*)opts;
    if (o->type_id != XT_TYPE_DICT) return dflt;
    XTString* k = xt_string_new(key);
    XTValue v = xt_dict_get(opts, (XTValue)k);
    xt_release((XTValue)k);
    if (XT_IS_INT(v)) return XT_TO_INT(v);
    return dflt;
}

// 在限定区域内大小写不敏感地找子串
static int xt_region_icontains(const char* hay, size_t haylen, const char* needle) {
    size_t nl = strlen(needle);
    if (nl == 0 || haylen < nl) return 0;
    for (size_t i = 0; i + nl <= haylen; i++) {
        size_t j = 0;
        while (j < nl) {
            char a = hay[i + j], b = needle[j];
            if (a >= 'A' && a <= 'Z') a += 32;
            if (b >= 'A' && b <= 'Z') b += 32;
            if (a != b) break;
            j++;
        }
        if (j == nl) return 1;
    }
    return 0;
}

// chunked 解码(Transfer-Encoding: chunked)
static char* xt_http_decode_chunked(const char* src, size_t len, size_t* outlen) {
    char* out = (char*)malloc(len + 1);
    size_t o = 0, i = 0;
    while (i < len) {
        size_t chunk = 0; int got = 0;
        while (i < len && src[i] != '\r') {
            char ch = src[i]; unsigned d;
            if (ch >= '0' && ch <= '9') d = (unsigned)(ch - '0');
            else if (ch >= 'a' && ch <= 'f') d = (unsigned)(ch - 'a' + 10);
            else if (ch >= 'A' && ch <= 'F') d = (unsigned)(ch - 'A' + 10);
            else break;
            chunk = chunk * 16 + d; got = 1; i++;
        }
        if (!got) break;
        if (i < len && src[i] == '\r') i++;
        if (i < len && src[i] == '\n') i++;
        if (chunk == 0) break;
        if (i + chunk > len) chunk = len - i;
        memcpy(out + o, src + i, chunk);
        o += chunk; i += chunk;
        if (i < len && src[i] == '\r') i++;
        if (i < len && src[i] == '\n') i++;
    }
    out[o] = '\0';
    *outlen = o;
    return out;
}

XTValue xt_http_request_ex(XTValue url_val, XTValue opts_val) {
    if (!XT_IS_REAL_PTR(url_val) || ((XTObject*)url_val)->type_id != XT_TYPE_STRING)
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("URL无效"));
    const char* url = ((XTString*)url_val)->data;

    const char* method = xt_opt_str(opts_val, "方法", "GET");
    int64_t timeout_ms = xt_opt_int(opts_val, "超时", 0);

    const char* body = NULL; size_t body_len = 0;
    if (XT_IS_REAL_PTR(opts_val) && ((XTObject*)opts_val)->type_id == XT_TYPE_DICT) {
        XTString* bk = xt_string_new("体");
        XTValue bv = xt_dict_get(opts_val, (XTValue)bk);
        xt_release((XTValue)bk);
        if (XT_IS_REAL_PTR(bv) && ((XTObject*)bv)->type_id == XT_TYPE_STRING) {
            body = ((XTString*)bv)->data;
            body_len = ((XTString*)bv)->length;
        }
    }

    // URL 解析(与 GET 同款)
    int use_tls = 0;
    const char* p = NULL;
    if (strncmp(url, "http://", 7) == 0) { p = url + 7; }
    else if (strncmp(url, "https://", 8) == 0) { use_tls = 1; p = url + 8; }
    if (!p) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("不支持的协议(仅 http/https)"));

    char host[256] = {0}; int port = use_tls ? 443 : 80; const char* path = "/";
    const char* slash = strchr(p, '/');
    const char* colon = strchr(p, ':');
    if (colon && (!slash || colon < slash)) {
        size_t hl = (size_t)(colon - p); if (hl >= 256) hl = 255;
        memcpy(host, p, hl); port = atoi(colon + 1);
    } else if (slash) {
        size_t hl = (size_t)(slash - p); if (hl >= 256) hl = 255;
        memcpy(host, p, hl);
    } else { size_t l = strlen(p); if (l >= 256) l = 255; memcpy(host, p, l); }
    if (slash) path = slash;

    xt_sock_t sock = create_connection(host, port);
    if (sock == XT_INVALID_SOCK) {
        char e[256]; snprintf(e, sizeof(e), "无法连接到 %s:%d", host, port);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(e));
    }

    // 收发超时(连接超时暂不支持)
    if (timeout_ms > 0) {
#if defined(_WIN32)
        DWORD tv = (DWORD)timeout_ms;
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, (const char*)&tv, sizeof(tv));
#else
        struct timeval tv;
        tv.tv_sec = timeout_ms / 1000; tv.tv_usec = (timeout_ms % 1000) * 1000;
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
#endif
    }

    void* tls = NULL;
    if (use_tls) {
        if (xt_tls_handshake(sock, host, &tls) != 0) {
            xt_sock_close(sock);
            return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("TLS 握手失败"));
        }
    }

    // 组装请求
    http_buf req = {NULL, 0, 0};
    char line[1100];
    snprintf(line, sizeof(line), "%s %s HTTP/1.1\r\nHost: %s\r\n", method, path, host);
    buf_add(&req, line, (int)strlen(line));

    // 自定义请求头(字典逐键)
    XTValue hdrs = XT_NULL;
    if (XT_IS_REAL_PTR(opts_val) && ((XTObject*)opts_val)->type_id == XT_TYPE_DICT) {
        XTString* hk = xt_string_new("头");
        hdrs = xt_dict_get(opts_val, (XTValue)hk);
        xt_release((XTValue)hk);
    }
    if (XT_IS_REAL_PTR(hdrs) && ((XTObject*)hdrs)->type_id == XT_TYPE_DICT) {
        XTValue keys = xt_dict_keys(hdrs);
        if (XT_IS_REAL_PTR(keys)) {
            XTArray* ka = (XTArray*)keys;
            for (size_t ki = 0; ki < ka->length; ki++) {
                XTValue k = (XTValue)ka->elements[ki];
                if (!XT_IS_REAL_PTR(k) || ((XTObject*)k)->type_id != XT_TYPE_STRING) continue;
                XTValue v = xt_dict_get(hdrs, k);
                if (!XT_IS_REAL_PTR(v) || ((XTObject*)v)->type_id != XT_TYPE_STRING) continue;
                snprintf(line, sizeof(line), "%s: %s\r\n", ((XTString*)k)->data, ((XTString*)v)->data);
                buf_add(&req, line, (int)strlen(line));
            }
            xt_release(keys);
        }
    }

    if (body_len > 0) {
        snprintf(line, sizeof(line), "Content-Length: %zu\r\n", body_len);
        buf_add(&req, line, (int)strlen(line));
    }
    buf_add(&req, "Connection: close\r\n\r\n", 21);
    if (body_len > 0) buf_add(&req, body, (int)body_len);

    // 发送(处理部分发送)
    int send_fail = 0;
    size_t off = 0;
    while (off < (size_t)req.len) {
        int n;
        if (use_tls) {
            n = (xt_tls_send(tls, req.data + off, req.len - (int)off) == 0) ? (req.len - (int)off) : -1;
        } else {
            n = send(sock, req.data + off, req.len - (int)off, 0);
        }
        if (n <= 0) { send_fail = 1; break; }
        off += (size_t)n;
    }
    free(req.data);
    if (send_fail) {
        if (tls) xt_tls_close(tls);
        xt_sock_close(sock);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("发送请求失败"));
    }

    // 读取全部响应
    http_buf buf = {NULL, 0, 0};
    char chunk[4096]; int n;
    if (use_tls) {
        while ((n = xt_tls_recv(tls, chunk, sizeof(chunk))) > 0) buf_add(&buf, chunk, n);
        xt_tls_close(tls);
    } else {
        while ((n = recv(sock, chunk, sizeof(chunk), 0)) > 0) buf_add(&buf, chunk, n);
    }
    xt_sock_close(sock);
    if (buf.len == 0) {
        free(buf.data);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("响应为空或读取超时"));
    }
    buf_add(&buf, "", 1);

    // 状态行: HTTP/1.1 200 OK
    int status = 0;
    const char* sp = strchr(buf.data, ' ');
    if (sp) status = atoi(sp + 1);

    // 响应头
    XTValue hdrDict = xt_dict_new(8);
    char* hdrEnd = strstr(buf.data, "\r\n\r\n");
    if (hdrEnd) {
        char* firstNl = strchr(buf.data, '\n');
        char* cur = firstNl ? firstNl + 1 : NULL;
        while (cur && cur < hdrEnd) {
            char* eol = strstr(cur, "\r\n");
            if (!eol || eol > hdrEnd) break;
            char* col = memchr(cur, ':', (size_t)(eol - cur));
            if (col) {
                *col = '\0';
                char* val = col + 1;
                while (*val == ' ') val++;
                *eol = '\0';
                XTString* ks = xt_string_new(cur);
                XTString* vs = xt_string_new(val);
                xt_dict_set(hdrDict, (XTValue)ks, (XTValue)vs);
                xt_release((XTValue)ks);
                xt_release((XTValue)vs);
                *col = ':';
            }
            cur = eol + 2;
        }
    }

    // 响应体(chunked 自动解码)
    char* bodyStart = hdrEnd ? hdrEnd + 4 : buf.data + buf.len;
    size_t rawBodyLen = (size_t)(buf.data + buf.len - bodyStart);
    char* finalBody = bodyStart;
    size_t finalLen = rawBodyLen;
    char* decoded = NULL;
    if (hdrEnd && xt_region_icontains(buf.data, (size_t)(hdrEnd - buf.data), "chunked") &&
        xt_region_icontains(buf.data, (size_t)(hdrEnd - buf.data), "transfer-encoding")) {
        decoded = xt_http_decode_chunked(bodyStart, rawBodyLen, &finalLen);
        finalBody = decoded;
    }

    XTValue bodyStr = (XTValue)xt_string_new_len(finalBody, finalLen);
    free(decoded);

    XTValue out = xt_dict_new(8);
    XTString* k1 = xt_string_new("状态码");
    xt_dict_set(out, (XTValue)k1, (XTValue)XT_FROM_INT(status));
    xt_release((XTValue)k1);
    XTString* k2 = xt_string_new("体");
    xt_dict_set(out, (XTValue)k2, bodyStr);
    xt_release((XTValue)k2);
    xt_release(bodyStr);
    XTString* k3 = xt_string_new("头");
    xt_dict_set(out, (XTValue)k3, hdrDict);
    xt_release((XTValue)k3);
    xt_release(hdrDict);

    free(buf.data);
    return (XTValue)xt_result_new(1, (void*)out, NULL);
}

// ============================================================
// TCP Connect
// ============================================================

XTSocket* xt_net_connect_sock(const char* host, int port) {
    xt_sock_t sock = create_connection(host, port);
    if (sock == XT_INVALID_SOCK) return NULL;
    return xt_net_new_socket(sock, 0);
}

// xt_net_connect 保持旧版 void* 签名兼容
void* xt_net_connect(const char* host, int port) {
    return xt_net_connect_sock(host, port);
}

// ============================================================
// TCP Listen + Accept Loop
// ============================================================

// ============================================================
// TCP Listen + Accept Loop
// ============================================================

typedef struct {
    xt_sock_t listen_sock;
    void (*callback)(void* stream);
    XTValue fn_val;   // 闭包版:非空时优先用 xt_closure_call1 调它
    int running;
} listener_ctx;

// 引用主运行时 arena
struct XTArena;
extern struct XTArena* g_current_arena;

// 每个连接独立线程处理：禁用 arena，调用回调，释放 socket
struct conn_ctx { void (*cb)(void*); XTSocket* sock; XTValue fn; };
static unsigned __stdcall conn_handler(void* arg) {
    struct conn_ctx* cc = (struct conn_ctx*)arg;
    struct XTArena* saved = g_current_arena;
    g_current_arena = NULL;
    if (cc->fn) {
        xt_closure_call1(cc->fn, (XTValue)cc->sock);
    } else {
        cc->cb(cc->sock);
    }
    g_current_arena = saved;
    xt_release((XTValue)cc->sock);
    free(cc);
    return 0;
}

static void* accept_thread(void* arg) {
    listener_ctx* ctx = (listener_ctx*)arg;

    while (ctx->running) {
        struct sockaddr_in client_addr;
        socklen_t addr_len = sizeof(client_addr);
        xt_sock_t client = accept(ctx->listen_sock, (struct sockaddr*)&client_addr, &addr_len);
        if (client == XT_INVALID_SOCK) {
            if (ctx->running) continue; else break;
        }

        XTSocket* client_sock = xt_net_new_socket(client, 0);

        // 每个连接在独立线程中处理——不阻塞 accept 循环
        struct conn_ctx* cc = malloc(sizeof(struct conn_ctx));
        cc->cb = ctx->callback;
        cc->fn = ctx->fn_val;
        cc->sock = client_sock;

#if defined(_WIN32)
        _beginthreadex(NULL, 0, (unsigned(__stdcall*)(void*))conn_handler, cc, 0, NULL);
#else
        pthread_t t;
        pthread_create(&t, NULL, conn_handler, cc);
        pthread_detach(t);
#endif
    }
    xt_sock_close(ctx->listen_sock);
    free(ctx);
    return NULL;
}

static int xt_net_listen_impl(int port, void (*callback)(void*), XTValue fn_val);

int xt_net_listen(int port, void (*callback)(void* stream)) {
    return xt_net_listen_impl(port, callback, 0);
}

// 闭包版:直接收 XTFunction,由 conn_handler 走 xt_closure_call1(带 env)
int xt_net_listen_fn(int port, XTValue fn_val) {
    return xt_net_listen_impl(port, NULL, fn_val);
}

static int xt_net_listen_impl(int port, void (*callback)(void*), XTValue fn_val) {
    xt_sock_t listen_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_sock == XT_INVALID_SOCK) return -1;

    int opt = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons((unsigned short)port);

    if (bind(listen_sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) { xt_sock_close(listen_sock); return -1; }
    if (listen(listen_sock, 5) != 0) { xt_sock_close(listen_sock); return -1; }

    listener_ctx* ctx = (listener_ctx*)malloc(sizeof(listener_ctx));
    ctx->listen_sock = listen_sock;
    ctx->callback = callback;
    ctx->fn_val = fn_val;
    ctx->running = 1;

    // 创建独立线程运行 accept 循环
#if defined(_WIN32)
    HANDLE h = CreateThread(NULL, 0, (LPTHREAD_START_ROUTINE)accept_thread, ctx, 0, NULL);
    if (!h) { free(ctx); xt_sock_close(listen_sock); return -1; }
    CloseHandle(h);
#else
    pthread_t t;
    if (pthread_create(&t, NULL, accept_thread, ctx) != 0) { free(ctx); xt_sock_close(listen_sock); return -1; }
    pthread_detach(t);
#endif
    return 0;
}

// ============================================================
// Socket I/O
// ============================================================

void* xt_net_read(void* sock_obj, int max_bytes) {
    if (!sock_obj) return NULL;
    XTSocket* s = (XTSocket*)sock_obj;
    if (s->is_closed) return NULL;
    xt_sock_t raw = (xt_sock_t)(uintptr_t)s->sock;
    char* buf = (char*)malloc(max_bytes + 1);
    int n = recv(raw, buf, max_bytes, 0);
    if (n <= 0) { free(buf); return NULL; }
    buf[n] = '\0';
    return buf;
}

int xt_net_write(void* sock_obj, const char* data, int len) {
    if (!sock_obj) return -1;
    XTSocket* s = (XTSocket*)sock_obj;
    if (s->is_closed) return -1;
    return send((xt_sock_t)(uintptr_t)s->sock, data, len, 0);
}

void xt_net_close(void* sock_obj) {
    xt_net_close_obj((XTSocket*)sock_obj);
}
