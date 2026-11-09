// HTTP流桥.c — 玄铁 HTTP/1.1 客户端流式桥(HTTPS 走系统 TLS:Windows=Schannel / macOS=SecureTransport)
//
// 与 HTTP.xt 的服务端(听/连)互补:本桥给「客户端」提供增量读取——响应体一旦到达就能
// 按行取出,不必像 求() 那样等连接关闭才一次性返回。SSE(Chat Completions stream)与
// chunked 分块都在这里解码。
//
// 编译(与编译器 clang 同一 target):
//   clang -target x86_64-w64-windows-gnu -O2 -c HTTP流桥.c -o HTTP流桥.o
// 链接: 编译器经 tiepm.toml [原生] 对象 自动并入(与 xt_runtime.c/xt_net.c/xt_tls.c 同链接)
//
// 线程模型: 句柄内部带互斥锁,同一句柄的并发调用被串行化;但阻塞等待会持有锁,
// 因此约定: 一个句柄同一时刻只能被一个线程驱动(UI 线程轮询或后台线程阻塞读,二选一)。
//
// 平台: Windows(Schannel) 与 macOS(SecureTransport) 有 TLS;Linux 无系统 TLS 通道,
// https 会明确失败(见 runtime/xt_tls.c 的存根),http 明文仍可用。
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stddef.h>

#if defined(_WIN32)
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET xt_sock_t;
#define XT_INVALID_SOCK INVALID_SOCKET
typedef CRITICAL_SECTION xt_mutex_t;
static void xt_mtx_init(xt_mutex_t* m) { InitializeCriticalSection(m); }
static void xt_mtx_lock(xt_mutex_t* m) { EnterCriticalSection(m); }
static void xt_mtx_unlock(xt_mutex_t* m) { LeaveCriticalSection(m); }
static void xt_mtx_free(xt_mutex_t* m) { DeleteCriticalSection(m); }
#else
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <netdb.h>
#include <unistd.h>
#include <errno.h>
#include <pthread.h>
typedef int xt_sock_t;
#define XT_INVALID_SOCK (-1)
typedef pthread_mutex_t xt_mutex_t;
static void xt_mtx_init(xt_mutex_t* m) { pthread_mutex_init(m, NULL); }
static void xt_mtx_lock(xt_mutex_t* m) { pthread_mutex_lock(m); }
static void xt_mtx_unlock(xt_mutex_t* m) { pthread_mutex_unlock(m); }
static void xt_mtx_free(xt_mutex_t* m) { pthread_mutex_destroy(m); }
#endif

// ============================================================
// XT 对象布局(与 runtime/xt_runtime.h 对齐;SQLite桥.c 同款精简模型)
// ============================================================
#define XT_TAG_INT      0x1ULL
#define XT_FROM_INT(i)  (((uintptr_t)(i) << 1) | XT_TAG_INT)
#define XT_TO_INT(v)    ((int64_t)((intptr_t)(v) >> 1))
#define IS_INT(v)       (((uintptr_t)(v)) & XT_TAG_INT)
#define XT_TRUE_V       ((uintptr_t)0x4ULL)
#define XT_FALSE_V      ((uintptr_t)0x2ULL)
#define XT_NULL_V       ((uintptr_t)0x0ULL)

#define XT_TYPE_FLOAT   2
#define XT_TYPE_STRING  3
#define XT_TYPE_DICT    6
#define XT_TYPE_HANDLE  16

typedef struct { uint32_t magic; uint32_t ref_count; uint32_t type_id; } XTObject;
typedef struct {
    uint32_t magic; uint32_t ref_count; uint32_t type_id;
    char* data; size_t length; size_t capacity; uint8_t data_in_arena;
} XTString;
typedef struct {
    uint32_t magic; uint32_t ref_count; uint32_t type_id;
    void* payload;
    void (*dtor)(void*);
} XTHandle;
typedef struct {
    uint32_t magic; uint32_t ref_count; uint32_t type_id;
    void* sock; int is_closed; int is_listener; int nb_set;
} XTSocket;
typedef struct { uint32_t magic; uint32_t ref_count; uint32_t type_id; double value; } XTFloat;
typedef struct { XTObject h; uintptr_t* elements; size_t length; size_t capacity; uint8_t in_arena; } XTArray;

// ============================================================
// runtime 导出(xt_runtime.o / xt_net.o / xt_tls.o 链接时提供)
// ============================================================
extern void* xt_string_new(const char*);
extern void* xt_string_new_len(const char*, size_t);
extern void* xt_result_new(int, void*, void*);
extern void* xt_handle_new(void*, void (*)(void*));
extern uintptr_t xt_dict_get(uintptr_t, uintptr_t);
extern uintptr_t xt_dict_keys(uintptr_t);
extern void* xt_net_connect(const char*, int);
extern void  xt_release(uintptr_t);
extern int64_t xt_now_ms(void);
extern int   xt_tls_handshake(uintptr_t, const char*, void**);
extern int   xt_tls_send(void*, const char*, int);
extern int   xt_tls_recv(void*, char*, int);
extern void  xt_tls_close(void*);

// ============================================================
// 句柄
// ============================================================
typedef enum { CH_SIZE = 0, CH_DATA, CH_CRLF, CH_TRAILER, CH_DONE } chunk_state;

typedef struct {
    xt_sock_t sock;
    XTSocket* sock_obj;
    void* tls;                 // NULL = 明文 http
    xt_mutex_t mu;

    // 原始网络缓冲(TLS 解密后 / 明文);net_pos 之前为已消费
    char* net;
    size_t net_len, net_cap, net_pos;

    // 解码后的响应体缓冲;body_pos 之前为已消费
    char* body;
    size_t body_len, body_cap, body_pos;

    int status;
    int chunked;
    long long content_len;     // -1 = 未知
    long long produced;        // content-length 模式下已产出
    int eof;
    int closed;
    const char* err;           // 非 NULL = 永久错误(字符串字面量)

    chunk_state ch_state;
    long long ch_rem;

    char* headers;             // 响应头原文(不含空行)
    size_t headers_len;
} http_stream;

static char* buf_grow(char* p, size_t* cap, size_t need) {
    if (need <= *cap) return p;
    size_t nc = *cap ? *cap : 1024;
    while (nc < need) nc *= 2;
    char* np = (char*)realloc(p, nc);
    if (!np) return NULL;
    *cap = nc;
    return np;
}

static int buf_append(char** p, size_t* len, size_t* cap, const char* d, size_t n) {
    if (n == 0) return 1;
    char* np = buf_grow(*p, cap, *len + n);
    if (!np) return 0;
    memcpy(np + *len, d, n);
    *p = np;
    *len += n;
    return 1;
}

static void stream_free(void* payload) {
    http_stream* st = (http_stream*)payload;
    if (!st) return;
    if (st->tls) { xt_tls_close(st->tls); st->tls = NULL; }
    if (st->sock_obj) { xt_release((uintptr_t)st->sock_obj); st->sock_obj = NULL; }
    free(st->net); free(st->body); free(st->headers);
    xt_mtx_free(&st->mu);
    free(st);
}

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// 大小写不敏感前缀比较:s 前 m 字节是否等于 lit
static int ci_prefix(const char* s, size_t n, const char* lit) {
    size_t m = strlen(lit);
    if (n < m) return 0;
    for (size_t i = 0; i < m; i++) {
        char a = s[i], b = lit[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
        if (a != b) return 0;
    }
    return 1;
}

static int find_crlf(const char* p, size_t from, size_t len, size_t* out) {
    for (size_t i = from; i + 1 < len; i++) {
        if (p[i] == '\r' && p[i + 1] == '\n') { *out = i; return 1; }
    }
    return 0;
}

// 从选项字典取字符串值;不存在返回 NULL
static XTString* opt_str(uintptr_t opts, const char* key) {
    if (opts == 0 || IS_INT(opts)) return NULL;
    XTObject* o = (XTObject*)opts;
    if (o->type_id != XT_TYPE_DICT) return NULL;
    XTString* k = (XTString*)xt_string_new(key);
    if (!k) return NULL;
    uintptr_t v = (uintptr_t)xt_dict_get(opts, (uintptr_t)k);
    xt_release((uintptr_t)k);
    if (v == 0 || IS_INT(v)) return NULL;
    XTObject* vo = (XTObject*)v;
    if (vo->type_id != XT_TYPE_STRING) return NULL;
    return (XTString*)v;
}

static int64_t val_int(uintptr_t v) {
    if (IS_INT(v)) return XT_TO_INT(v);
    if (v == 0) return 0;
    XTObject* o = (XTObject*)v;
    if (o->type_id == XT_TYPE_FLOAT) return (int64_t)((XTFloat*)v)->value;
    return 0;
}

// ============================================================
// 网络层
// ============================================================
static int sock_wait_readable(http_stream* st, int timeout_ms) {
    fd_set rs;
    FD_ZERO(&rs);
    FD_SET(st->sock, &rs);
    struct timeval tv;
    tv.tv_sec = timeout_ms / 1000;
    tv.tv_usec = (timeout_ms % 1000) * 1000;
#if defined(_WIN32)
    int r = (timeout_ms < 0)
        ? select(0, &rs, NULL, NULL, NULL)
        : select(0, &rs, NULL, NULL, &tv);
#else
    int r = (timeout_ms < 0)
        ? select(st->sock + 1, &rs, NULL, NULL, NULL)
        : select(st->sock + 1, &rs, NULL, NULL, &tv);
#endif
    if (r > 0) return 1;
    return r == 0 ? 0 : -1;
}

// 返回 >0 字节数;0 = 对端关闭;-1 = 错误
static int stream_raw_read(http_stream* st, char* out, int cap) {
    if (st->tls) return xt_tls_recv(st->tls, out, cap);
    int n = recv(st->sock, out, cap, 0);
    if (n > 0) return n;
    return n == 0 ? 0 : -1;
}

static int stream_raw_write(http_stream* st, const char* data, int len) {
    if (st->tls) return xt_tls_send(st->tls, data, len) == 0 ? 0 : -1;
    int off = 0;
    while (off < len) {
        int n = send(st->sock, data + off, len - off, 0);
        if (n <= 0) return -1;
        off += n;
    }
    return 0;
}

// 把 net 中已到达的字节搬运进 body(chunked 解码 / 固定长度 / 读到关闭)
// 返回 1=有进展或已 EOF,0=需要更多网络数据,-1=错误
static int pump(http_stream* st) {
    int progress = 0;
    for (;;) {
        size_t avail = st->net_len - st->net_pos;
        if (st->chunked) {
            if (st->ch_state == CH_DONE) { st->eof = 1; break; }
            if (st->ch_state == CH_SIZE) {
                size_t crlf;
                if (!find_crlf(st->net, st->net_pos, st->net_len, &crlf)) break;
                long long sz = 0;
                int got = 0;
                for (size_t i = st->net_pos; i < crlf; i++) {
                    int c = (unsigned char)st->net[i];
                    if (c == ';') break;           // 块扩展,忽略
                    if (c == ' ' || c == '\t') continue;
                    int d = hexval(c);
                    if (d < 0) { st->err = "chunked 块长度无效"; return -1; }
                    if (sz > (0x7fffffffffffffffLL - d) / 16) { st->err = "chunked 块长度溢出"; return -1; }
                    sz = sz * 16 + d; got = 1;
                }
                if (!got) { st->err = "chunked 块长度无效"; return -1; }
                st->net_pos = crlf + 2;
                if (sz == 0) { st->ch_state = CH_TRAILER; }
                else { st->ch_rem = sz; st->ch_state = CH_DATA; }
                progress = 1;
                continue;
            }
            if (st->ch_state == CH_DATA) {
                if (avail == 0) break;
                size_t take = (avail < (size_t)st->ch_rem) ? avail : (size_t)st->ch_rem;
                if (!buf_append(&st->body, &st->body_len, &st->body_cap, st->net + st->net_pos, take)) {
                    st->err = "内存不足"; return -1;
                }
                st->net_pos += take;
                st->ch_rem -= (long long)take;
                if (st->ch_rem == 0) st->ch_state = CH_CRLF;
                progress = 1;
                continue;
            }
            if (st->ch_state == CH_CRLF) {
                if (avail < 2) break;
                if (st->net[st->net_pos] != '\r' || st->net[st->net_pos + 1] != '\n') {
                    st->err = "chunked 分块边界无效"; return -1;
                }
                st->net_pos += 2;
                st->ch_state = CH_SIZE;
                progress = 1;
                continue;
            }
            if (st->ch_state == CH_TRAILER) {
                size_t crlf;
                if (!find_crlf(st->net, st->net_pos, st->net_len, &crlf)) break;
                if (crlf == st->net_pos) {
                    st->net_pos = crlf + 2;
                    st->ch_state = CH_DONE;
                    st->eof = 1;
                    progress = 1;
                    break;
                }
                st->net_pos = crlf + 2;
                progress = 1;
                continue;
            }
            break;
        }

        if (st->content_len >= 0) {
            if (st->produced >= st->content_len) { st->eof = 1; break; }
            if (avail == 0) break;
            long long remain = st->content_len - st->produced;
            size_t take = avail;
            if ((long long)take > remain) take = (size_t)remain;
            if (!buf_append(&st->body, &st->body_len, &st->body_cap, st->net + st->net_pos, take)) {
                st->err = "内存不足"; return -1;
            }
            st->net_pos += take;
            st->produced += (long long)take;
            progress = 1;
            continue;
        }
        if (avail == 0) break;
        if (!buf_append(&st->body, &st->body_len, &st->body_cap, st->net + st->net_pos, avail)) {
            st->err = "内存不足"; return -1;
        }
        st->net_pos = st->net_len;
        progress = 1;
        continue;
    }

    if (st->net_pos > 0 && st->net_pos == st->net_len) { st->net_pos = 0; st->net_len = 0; }
    if (st->body_pos > 0 && st->body_pos == st->body_len) { st->body_pos = 0; st->body_len = 0; }
    return progress;
}

// 填 body: 返回 1=有数据/已 EOF,0=超时,-1=错误
static int fill_stream(http_stream* st, int64_t deadline_ms, int has_deadline) {
    for (;;) {
        if (st->err) return -1;
        int p = pump(st);
        if (p < 0) return -1;
        if (p > 0) return 1;
        if (st->eof) return 1;

        int wait_ms = -1;
        if (has_deadline) {
            int64_t left = deadline_ms - xt_now_ms();
            if (left <= 0) return 0;
            wait_ms = (int)(left > 0x7fffffff ? 0x7fffffff : left);
        }
        int w = sock_wait_readable(st, wait_ms);
        if (w == 0) return 0;
        if (w < 0) { st->err = "等待可读失败"; return -1; }

        char tmp[16384];
        int n = stream_raw_read(st, tmp, (int)sizeof(tmp));
        if (n < 0) { st->err = "读取响应失败"; return -1; }
        if (n == 0) {
            if (st->chunked && st->ch_state != CH_DONE) { st->err = "chunked 数据不完整(连接提前关闭)"; return -1; }
            st->eof = 1;
            return 1;
        }
        if (!buf_append(&st->net, &st->net_len, &st->net_cap, tmp, (size_t)n)) {
            st->err = "内存不足"; return -1;
        }
    }
}

// ============================================================
// 响应头解析
// ============================================================
// 返回 0=需要更多数据,1=完成,-1=错误(内存)
static int parse_headers(http_stream* st) {
    // 头块结束 = 连续 \r\n\r\n:从头部逐行找,遇到「空行」即结束
    size_t head_end = 0;
    size_t body_start = 0;
    size_t cursor = st->net_pos;
    size_t found = 0;
    while (find_crlf(st->net, cursor, st->net_len, &found)) {
        size_t next = found + 2;
        if (next >= st->net_len) return 0;   // 还看不出是不是空行
        if (st->net[next] == '\r') {
            if (next + 1 >= st->net_len) return 0;
            if (st->net[next + 1] == '\n') {
                head_end = found;
                body_start = next + 2;
                break;
            }
        }
        cursor = next;
    }
    if (body_start == 0) return 0;           // 头未完整

    // 状态行: "HTTP/1.1 200 OK"
    size_t sp;
    for (sp = st->net_pos; sp < head_end && st->net[sp] != ' '; sp++) {}
    st->status = (sp < head_end) ? atoi(st->net + sp + 1) : 0;

    // 头原文(末尾补 \r\n,使最后一行也能被 find_crlf 正常切出)
    free(st->headers);
    st->headers = NULL;
    st->headers_len = 0;
    size_t hlen = head_end - st->net_pos;
    if (hlen > 0) {
        st->headers = (char*)malloc(hlen + 3);
        if (!st->headers) return -1;
        memcpy(st->headers, st->net + st->net_pos, hlen);
        st->headers[hlen] = '\r';
        st->headers[hlen + 1] = '\n';
        st->headers[hlen + 2] = '\0';
        st->headers_len = hlen + 2;
    }

    // 关键头(在 headers 副本上扫,末尾 CRLF 已补齐)
    st->chunked = 0;
    st->content_len = -1;
    size_t i = 0;
    {
        size_t eol;
        if (!find_crlf(st->headers, 0, st->headers_len, &eol)) return -1;
        i = eol + 2;                            // 跳过状态行
    }
    while (i + 1 < st->headers_len) {
        size_t eol;
        if (!find_crlf(st->headers, i, st->headers_len, &eol)) break;
        size_t n = eol - i;
        if (ci_prefix(st->headers + i, n, "transfer-encoding:")) {
            const char* v = st->headers + i + 18;
            size_t vn = n - 18;
            for (size_t k = 0; k + 7 <= vn; k++) {
                if (ci_prefix(v + k, vn - k, "chunked")) { st->chunked = 1; break; }
            }
        } else if (ci_prefix(st->headers + i, n, "content-length:")) {
            long long cl = atoll(st->headers + i + 15);
            if (cl >= 0) st->content_len = cl;
        }
        i = eol + 2;
    }

    // 1xx 中间响应:丢掉该头块,继续等真正的响应
    if (st->status >= 100 && st->status < 200) {
        size_t rest = st->net_len - body_start;
        memmove(st->net, st->net + body_start, rest);
        st->net_len = rest;
        st->net_pos = 0;
        return 0;
    }

    // 剩余字节前移,进入 body 解析
    if (body_start > 0) {
        size_t rest = st->net_len - body_start;
        memmove(st->net, st->net + body_start, rest);
        st->net_len = rest;
        st->net_pos = 0;
    }
    if (st->chunked) st->ch_state = CH_SIZE;
    return 1;
}

// ============================================================
// 对外 API(玄铁 外 函 入口;返回 XTValue)
// ============================================================
static uintptr_t make_err(const char* msg) {
    return (uintptr_t)xt_result_new(0, NULL, xt_string_new(msg ? msg : "未知错误"));
}

static int parse_url(const char* url, char* host, size_t hostcap, int* port, const char** path, int* tls) {
    *port = 80;
    *tls = 0;
    const char* p;
    if (strncmp(url, "http://", 7) == 0) { p = url + 7; }
    else if (strncmp(url, "https://", 8) == 0) { *tls = 1; *port = 443; p = url + 8; }
    else return 0;

    const char* slash = strchr(p, '/');
    const char* colon = strchr(p, ':');
    if (colon && (!slash || colon < slash)) {
        size_t hl = (size_t)(colon - p);
        if (hl >= hostcap) return 0;
        memcpy(host, p, hl);
        host[hl] = '\0';
        *port = atoi(colon + 1);
        if (*port <= 0 || *port > 65535) return 0;
        *path = slash ? slash : "/";
    } else if (slash) {
        size_t hl = (size_t)(slash - p);
        if (hl >= hostcap) return 0;
        memcpy(host, p, hl);
        host[hl] = '\0';
        *path = slash;
    } else {
        size_t hl = strlen(p);
        if (hl >= hostcap) return 0;
        memcpy(host, p, hl);
        host[hl] = '\0';
        *path = "/";
    }
    if (host[0] == '\0') return 0;
    return 1;
}

// 用户头字典 → 逐行追加;记录是否已自带 Content-Length / Connection
static int append_user_headers(char** req, size_t* len, size_t* cap, uintptr_t headers, int* has_cl, int* has_conn) {
    if (headers == 0 || IS_INT(headers)) return 1;
    XTObject* o = (XTObject*)headers;
    if (o->type_id != XT_TYPE_DICT) return 1;
    uintptr_t keys = (uintptr_t)xt_dict_keys(headers);
    if (keys == 0 || IS_INT(keys)) return 1;
    XTArray* arr = (XTArray*)keys;
    int ok = 1;
    for (size_t i = 0; i < arr->length && ok; i++) {
        uintptr_t k = arr->elements[i];
        if (k == 0 || IS_INT(k) || ((XTObject*)k)->type_id != XT_TYPE_STRING) continue;
        XTString* ks = (XTString*)k;
        uintptr_t v = (uintptr_t)xt_dict_get(headers, k);
        if (v == 0 || IS_INT(v) || ((XTObject*)v)->type_id != XT_TYPE_STRING) continue;
        XTString* vs = (XTString*)v;
        if (ci_prefix(ks->data, ks->length, "content-length")) *has_cl = 1;
        if (ci_prefix(ks->data, ks->length, "connection")) *has_conn = 1;
        if (!buf_append(req, len, cap, ks->data, ks->length)) { ok = 0; break; }
        if (!buf_append(req, len, cap, ": ", 2)) { ok = 0; break; }
        if (!buf_append(req, len, cap, vs->data, vs->length)) { ok = 0; break; }
        if (!buf_append(req, len, cap, "\r\n", 2)) { ok = 0; break; }
    }
    xt_release(keys);
    return ok;
}

// 打开流式请求
// 选项: {"方法","头"(字典),"体"(字符串)} 与 求() 的选项约定一致
uintptr_t xt_http_stream_open(uintptr_t url_v, uintptr_t opts) {
    XTString* url = NULL;
    if (url_v != 0 && !IS_INT(url_v)) {
        XTObject* o = (XTObject*)url_v;
        if (o->type_id == XT_TYPE_STRING) url = (XTString*)url_v;
    }
    if (!url) return make_err("网址必须是字符串");

    XTString* method_s = NULL;
    XTString* body_s = NULL;
    uintptr_t headers = 0;
    if (opts != 0 && !IS_INT(opts) && ((XTObject*)opts)->type_id == XT_TYPE_DICT) {
        method_s = opt_str(opts, "方法");
        body_s = opt_str(opts, "体");
        XTString* hk = (XTString*)xt_string_new("头");
        if (hk) {
            headers = (uintptr_t)xt_dict_get(opts, (uintptr_t)hk);
            xt_release((uintptr_t)hk);
        }
    }
    const char* method = (method_s && method_s->length > 0) ? method_s->data : "GET";
    const char* body = body_s ? body_s->data : NULL;
    size_t body_len = body_s ? body_s->length : 0;

    char host[256];
    int port = 0, use_tls = 0;
    const char* path = "/";
    if (!parse_url(url->data, host, sizeof(host), &port, &path, &use_tls)) {
        return make_err("网址格式不正确(仅支持 http/https)");
    }

    XTSocket* so = (XTSocket*)xt_net_connect(host, port);
    if (!so) return make_err("无法连接服务器(域名解析或 TCP 连接失败)");

    http_stream* st = (http_stream*)calloc(1, sizeof(http_stream));
    if (!st) { xt_release((uintptr_t)so); return make_err("内存不足"); }
    xt_mtx_init(&st->mu);
    st->sock = (xt_sock_t)(uintptr_t)so->sock;
    st->sock_obj = so;
    st->content_len = -1;
    st->chunked = 0;
    st->ch_state = CH_SIZE;

    if (use_tls) {
        void* tls = NULL;
        if (xt_tls_handshake((uintptr_t)so->sock, host, &tls) != 0) {
            stream_free(st);
            return make_err("TLS 握手失败(证书校验/协议协商失败,或该平台无系统 TLS 通道)");
        }
        st->tls = tls;
    }

    char* req = NULL;
    size_t rlen = 0, rcap = 0;
    char line[1400];
    int has_cl = 0, has_conn = 0;

    snprintf(line, sizeof(line), "%s %s HTTP/1.1\r\n", method, path);
    if (!buf_append(&req, &rlen, &rcap, line, strlen(line))) goto oom;

    if ((use_tls && port != 443) || (!use_tls && port != 80)) {
        snprintf(line, sizeof(line), "Host: %s:%d\r\n", host, port);
    } else {
        snprintf(line, sizeof(line), "Host: %s\r\n", host);
    }
    if (!buf_append(&req, &rlen, &rcap, line, strlen(line))) goto oom;

    {
        const char* base = "User-Agent: XuanTie-HTTP/1.1\r\n"
                           "Accept: */*\r\n"
                           "Accept-Encoding: identity\r\n";
        if (!buf_append(&req, &rlen, &rcap, base, strlen(base))) goto oom;
    }
    if (!append_user_headers(&req, &rlen, &rcap, headers, &has_cl, &has_conn)) goto oom;
    if (!has_conn && !buf_append(&req, &rlen, &rcap, "Connection: close\r\n", 19)) goto oom;
    {
        int method_has_body = !(strcmp(method, "GET") == 0 || strcmp(method, "HEAD") == 0);
        if (!has_cl && (body_len > 0 || method_has_body)) {
            snprintf(line, sizeof(line), "Content-Length: %zu\r\n", body_len);
            if (!buf_append(&req, &rlen, &rcap, line, strlen(line))) goto oom;
        }
    }
    if (!buf_append(&req, &rlen, &rcap, "\r\n", 2)) goto oom;
    if (body_len > 0 && !buf_append(&req, &rlen, &rcap, body, body_len)) goto oom;

    if (stream_raw_write(st, req, (int)rlen) != 0) {
        free(req);
        stream_free(st);
        return make_err("发送请求失败");
    }
    free(req);
    req = NULL;

    // 读响应头(上限 1MB,防失控)
    for (;;) {
        size_t before = st->net_len;
        int r = parse_headers(st);
        if (r < 0) { stream_free(st); return make_err("解析响应头失败"); }
        if (r > 0) break;
        // 1xx 中间响应被消费后缓冲已推进:立刻用现有数据重试,不要误等网络
        if (st->net_len != before) continue;
        if (st->net_len > 1024 * 1024) { stream_free(st); return make_err("响应头过长"); }
        int w = sock_wait_readable(st, -1);
        if (w <= 0) { stream_free(st); return make_err("读取响应头超时或连接中断"); }
        char tmp[16384];
        int n = stream_raw_read(st, tmp, (int)sizeof(tmp));
        if (n <= 0) { stream_free(st); return make_err("连接在响应头到达前关闭"); }
        if (!buf_append(&st->net, &st->net_len, &st->net_cap, tmp, (size_t)n)) {
            stream_free(st);
            return make_err("内存不足");
        }
    }

    return (uintptr_t)xt_result_new(1, xt_handle_new(st, stream_free), NULL);

oom:
    free(req);
    stream_free(st);
    return make_err("内存不足");
}

static http_stream* stream_of(uintptr_t h) {
    if (h == 0 || IS_INT(h)) return NULL;
    XTObject* o = (XTObject*)h;
    if (o->type_id != XT_TYPE_HANDLE) return NULL;
    http_stream* st = (http_stream*)((XTHandle*)h)->payload;
    if (!st || st->closed) return NULL;
    return st;
}

uintptr_t xt_http_stream_status(uintptr_t h) {
    http_stream* st = stream_of(h);
    if (!st) return XT_FROM_INT(-1);
    return XT_FROM_INT(st->status);
}

uintptr_t xt_http_stream_eof(uintptr_t h) {
    http_stream* st = stream_of(h);
    if (!st) return XT_TRUE_V;
    xt_mtx_lock(&st->mu);
    int e = st->eof;
    xt_mtx_unlock(&st->mu);
    return e ? XT_TRUE_V : XT_FALSE_V;
}

// 读一行:成功=1 值=行(不含行尾);失败 错误="EOF"/"超时"/...
// 超时: <0 永久等待; =0 不等待; >0 毫秒
uintptr_t xt_http_stream_readline(uintptr_t h, uintptr_t timeout_v) {
    http_stream* st = stream_of(h);
    if (!st) return make_err("句柄无效或已关闭");
    int64_t timeout = val_int(timeout_v);

    xt_mtx_lock(&st->mu);

    int64_t deadline = 0;
    int has_deadline = 0;
    if (timeout >= 0) {
        deadline = xt_now_ms() + timeout;
        has_deadline = 1;
    }

    for (;;) {
        if (st->err) {
            const char* e = st->err;
            xt_mtx_unlock(&st->mu);
            return make_err(e);
        }
        size_t i;
        for (i = st->body_pos; i < st->body_len; i++) {
            if (st->body[i] == '\n') break;
        }
        if (i < st->body_len) {
            size_t start = st->body_pos;
            size_t n = i - start;
            if (n > 0 && st->body[i - 1] == '\r') n -= 1;
            void* out = xt_string_new_len(st->body + start, n);
            st->body_pos = i + 1;
            xt_mtx_unlock(&st->mu);
            if (!out) return make_err("内存不足");
            return (uintptr_t)xt_result_new(1, out, NULL);
        }
        if (st->eof) {
            if (st->body_pos < st->body_len) {
                size_t n = st->body_len - st->body_pos;
                if (n > 0 && st->body[st->body_len - 1] == '\r') n -= 1;
                void* out = xt_string_new_len(st->body + st->body_pos, n);
                st->body_pos = st->body_len;
                xt_mtx_unlock(&st->mu);
                if (!out) return make_err("内存不足");
                return (uintptr_t)xt_result_new(1, out, NULL);
            }
            xt_mtx_unlock(&st->mu);
            return make_err("EOF");
        }
        int r = fill_stream(st, deadline, has_deadline);
        if (r < 0) {
            const char* e = st->err ? st->err : "读取失败";
            xt_mtx_unlock(&st->mu);
            return make_err(e);
        }
        if (r == 0) {
            xt_mtx_unlock(&st->mu);
            return make_err("超时");
        }
    }
}

// 读原始块(最多 max 字节,最多等 timeout_ms):成功=1 值=字符串;失败 错误="EOF"/"暂无数据"/...
uintptr_t xt_http_stream_read(uintptr_t h, uintptr_t max_v, uintptr_t timeout_v) {
    http_stream* st = stream_of(h);
    if (!st) return make_err("句柄无效或已关闭");
    int64_t max = val_int(max_v);
    if (max <= 0) max = 65536;
    int64_t timeout = val_int(timeout_v);

    xt_mtx_lock(&st->mu);
    int64_t deadline = 0;
    int has_deadline = 0;
    if (timeout >= 0) {
        deadline = xt_now_ms() + timeout;
        has_deadline = 1;
    }
    while (!st->err && !st->eof && st->body_pos >= st->body_len) {
        int r = fill_stream(st, deadline, has_deadline);
        if (r < 0) break;
        if (r == 0) break;
    }
    if (st->err) {
        const char* e = st->err;
        xt_mtx_unlock(&st->mu);
        return make_err(e);
    }
    size_t avail = st->body_len - st->body_pos;
    if (avail == 0) {
        int eof = st->eof;
        xt_mtx_unlock(&st->mu);
        return eof ? make_err("EOF") : make_err("暂无数据");
    }
    size_t take = (size_t)max < avail ? (size_t)max : avail;
    void* out = xt_string_new_len(st->body + st->body_pos, take);
    st->body_pos += take;
    xt_mtx_unlock(&st->mu);
    if (!out) return make_err("内存不足");
    return (uintptr_t)xt_result_new(1, out, NULL);
}

// 响应头查询(不区分大小写);未找到返回空串
uintptr_t xt_http_stream_header(uintptr_t h, uintptr_t name_v) {
    http_stream* st = stream_of(h);
    if (!st) return (uintptr_t)xt_string_new("");
    XTString* name = NULL;
    if (name_v != 0 && !IS_INT(name_v) && ((XTObject*)name_v)->type_id == XT_TYPE_STRING) {
        name = (XTString*)name_v;
    }
    if (!name || !st->headers) return (uintptr_t)xt_string_new("");

    size_t i = 0;
    while (i + 1 < st->headers_len) {
        size_t eol;
        if (!find_crlf(st->headers, i, st->headers_len, &eol)) break;
        size_t colon = i;
        while (colon < eol && st->headers[colon] != ':') colon++;
        if (colon < eol) {
            size_t kn = colon - i;
            int same = (kn == name->length) ? 1 : 0;
            for (size_t k = 0; same && k < kn; k++) {
                char a = st->headers[i + k], b = name->data[k];
                if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
                if (b >= 'A' && b <= 'Z') b = (char)(b - 'A' + 'a');
                if (a != b) same = 0;
            }
            if (same) {
                const char* v = st->headers + colon + 1;
                size_t vn = eol - (colon + 1);
                while (vn > 0 && (*v == ' ' || *v == '\t')) { v++; vn--; }
                while (vn > 0 && (v[vn - 1] == ' ' || v[vn - 1] == '\t')) vn--;
                return (uintptr_t)xt_string_new_len(v, vn);
            }
        }
        i = eol + 2;
    }
    return (uintptr_t)xt_string_new("");
}

// 显式关闭(幂等);句柄对象由 ARC 回收
uintptr_t xt_http_stream_close(uintptr_t h) {
    if (h == 0 || IS_INT(h)) return make_err("句柄无效");
    XTObject* o = (XTObject*)h;
    if (o->type_id != XT_TYPE_HANDLE) return make_err("不是 HTTP 流句柄");
    XTHandle* hd = (XTHandle*)h;
    http_stream* st = (http_stream*)hd->payload;
    if (!st) return (uintptr_t)xt_result_new(1, (void*)XT_TRUE_V, NULL);
    if (!st->closed) {
        xt_mtx_lock(&st->mu);
        st->closed = 1;
        xt_mtx_unlock(&st->mu);
        if (st->tls) { xt_tls_close(st->tls); st->tls = NULL; }
        if (st->sock_obj) { xt_release((uintptr_t)st->sock_obj); st->sock_obj = NULL; }
        st->sock = XT_INVALID_SOCK;
    }
    return (uintptr_t)xt_result_new(1, (void*)XT_TRUE_V, NULL);
}
