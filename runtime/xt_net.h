// xt_net.h — 玄铁跨平台网络栈 v1.0
// 提供 HTTP GET、TCP 连接/监听，基于原生 socket
#ifndef XT_NET_H
#define XT_NET_H

#include <stdint.h>
#include "xt_runtime.h"

#ifdef __cplusplus
extern "C" {
#endif

// 初始化网络子系统（Windows 上调用 WSAStartup）
int xt_net_init(void);

// 清理网络子系统（Windows 上调用 WSACleanup）
void xt_net_cleanup(void);

// HTTP GET 请求，返回 XTResult（成功=字符串，失败=错误信息）
// url: "http://host:port/path" 或 "https://host/path"（HTTPS 走 Schannel 系统 TLS）
void* xt_net_http_get(const char* url);

// TLS(Schannel)客户端接口 — runtime/xt_tls.c 实现
int xt_tls_handshake(uintptr_t sock, const char* hostname, void** ctx_out);
int xt_tls_send(void* ctx, const char* data, int len);
int xt_tls_recv(void* ctx, char* out, int cap);
void xt_tls_close(void* ctx);

// TCP 连接到 host:port，返回 socket 句柄（包装在 XT 对象中）
// 失败返回 NULL
void* xt_net_connect(const char* host, int port);

// TCP 监听，对每个连接调用 callback(stream_obj)
// 在独立线程中运行，立即返回
int xt_net_listen(int port, void (*callback)(void* stream));

// 闭包版监听:直接收 XTFunction(XTValue),经 xt_closure_call1 按 env 正确调用——
// 原版只传 func_ptr,捕获环境的闭包被调用时 env 槽位是 socket 指针,必崩(自举/服务端库实测)
int xt_net_listen_fn(int port, XTValue fn_val);

// 以 env 感知约定调用一元闭包(供 C 侧回调 trampoline 使用)
XTValue xt_closure_call1(XTValue fn_val, XTValue arg);

// 从 socket 读取数据，返回 XTString
void* xt_net_read(void* sock_obj, int max_bytes);

// 向 socket 写入数据
int xt_net_write(void* sock_obj, const char* data, int len);

// 关闭 socket
void xt_net_close(void* sock_obj);

#ifdef __cplusplus
}
#endif

#endif
