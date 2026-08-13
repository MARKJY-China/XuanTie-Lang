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

// 精确读满 want 字节(协议帧用):成功返回 malloc 缓冲区(out_got 为实际字节数),
// 对端提前关闭/出错返回 NULL
char* xt_net_read_exact(void* sock_obj, int64_t want, int64_t* out_got);

// 向 socket 写入数据
int xt_net_write(void* sock_obj, const char* data, int len);

// 关闭 socket
void xt_net_close(void* sock_obj);

// ============================================================
// fiber 感知 socket I/O(方案三:网络与线程调度整合)
// 仅供异步块状态机切分点调用;阻塞上下文仍走 xt_net_read/write。
// 三者约定一致:返回 0=已挂起(等待已注册,槽位已按需更新),1=完成(结果在槽位)。
// slot_ptr 指向状态机槽位:跨挂起持久化中间态(读:数据/空;写:tagged已发字节数;连:在途sock)。
int  xt_socket_read_fiber(XTValue sock_val, XTValue max_v, int64_t* slot_ptr);
int  xt_socket_write_fiber(XTValue sock_val, XTValue data_val, int64_t* slot_ptr);
int  xt_socket_connect_fiber(XTValue addr_val, int64_t* slot_ptr);
// 调度器主循环每拍调用:对注册表内 socket 做零超时就绪轮询,唤醒对应 fiber。
// 注册表为空时零开销。仅调度器线程访问(单驱动保证串行)。
void xt_net_sched_poll(void);

#ifdef __cplusplus
}
#endif

#endif
