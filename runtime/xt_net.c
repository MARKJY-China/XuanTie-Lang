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
    if (!url || strncmp(url, "http://", 7) != 0) {
        char* e = (char*)malloc(256);
        snprintf(e, 256, "不支持的协议: %s", url ? url : "(null)");
        return e;
    }

    const char* p = url + 7;
    char host[256] = {0}; int port = 80; const char* path = "/";
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

    char req[1024];
    snprintf(req, sizeof(req), "GET %s HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", path, host);
    if (send(sock, req, (int)strlen(req), 0) <= 0) {
        xt_sock_close(sock); char* e = (char*)malloc(256); snprintf(e, 256, "发送请求失败"); return e;
    }

    http_buf buf = {NULL, 0, 0}; char chunk[4096]; int n;
    while ((n = recv(sock, chunk, sizeof(chunk)-1, 0)) > 0) buf_add(&buf, chunk, n);
    xt_sock_close(sock);
    if (buf.len == 0) { free(buf.data); char* e = (char*)malloc(256); snprintf(e, 256, "响应为空"); return e; }

    buf_add(&buf, "", 1);
    char* body = strstr(buf.data, "\r\n\r\n");
    if (body) { body += 4; char* r = strdup(body); free(buf.data); return r; }
    return buf.data;
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

typedef struct {
    xt_sock_t listen_sock;
    void (*callback)(void* stream);
    int running;
} listener_ctx;

// 引用主运行时 arena
struct XTArena;
extern struct XTArena* g_current_arena;

// 每个连接独立线程处理：禁用 arena，调用回调，释放 socket
struct conn_ctx { void (*cb)(void*); XTSocket* sock; };
static unsigned __stdcall conn_handler(void* arg) {
    struct conn_ctx* cc = (struct conn_ctx*)arg;
    struct XTArena* saved = g_current_arena;
    g_current_arena = NULL;
    cc->cb(cc->sock);
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
        struct conn_ctx {
            void (*cb)(void*);
            XTSocket* sock;
        };
        struct conn_ctx* cc = malloc(sizeof(struct conn_ctx));
        cc->cb = ctx->callback;
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

int xt_net_listen(int port, void (*callback)(void* stream)) {
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
