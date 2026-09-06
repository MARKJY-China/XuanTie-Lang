/**
 * @file xt_tls.c
 * @brief 玄铁运行时 TLS 客户端(Schannel/SSPI 实现)
 *
 * 设计目标:
 * 1. 零新增依赖——使用 Windows 系统自带 Schannel(secur32.dll),不引入 OpenSSL/mbedTLS,
 *    发行包重量零增长,无 llvm/gcc 环境的机器即装即用。
 * 2. 对上层只暴露 握手/发送/接收/关闭 四个原语,xt_net.c 的 https:// 路由调用。
 *
 * 仅实现客户端模式(玄铁作为 HTTPS 客户端拉取索引/下载包)。
 */

#ifdef _WIN32

#ifndef SECURITY_WIN32
#define SECURITY_WIN32
#endif

#include <winsock2.h>
#include <windows.h>
#include <ws2tcpip.h>
#include <schannel.h>
#include <security.h>
#include <sspi.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#pragma comment(lib, "secur32.lib")

typedef struct {
    SOCKET sockfd;
    CredHandle cred;
    CtxtHandle ctx;
    int ctx_valid;
    SecPkgContext_StreamSizes sizes;
    // 接收侧解密余量缓冲(DecryptMessage 可能一次吐出部分应用数据)
    char* leftover;
    int leftover_len;
    // 接收侧密文输入缓冲(持久化):DecryptMessage 的 SECBUFFER_EXTRA(下一条记录的密文头)
    // 必须跨调用存活——原实现放在栈上,交付数据即丢弃,导致流错位(间歇性乱码/截断,实测实锤)
    char* inbuf;
    int inlen;
    int incap;
} xt_tls_conn;

// 发送全部数据(循环直到发完)
static int tls_send_all(SOCKET s, const char* data, int len) {
    int off = 0;
    while (off < len) {
        int n = send(s, data + off, len - off, 0);
        if (n <= 0) return -1;
        off += n;
    }
    return 0;
}

/**
 * 建立 TLS 会话。成功返回 0,失败返回 -1。
 * hostname 用于 SNI 与证书校验。
 */
int xt_tls_handshake(uintptr_t sock_v, const char* hostname, void** ctx_out) {
    SOCKET sock = (SOCKET)sock_v;
    *ctx_out = NULL;

    SCHANNEL_CRED cred = {0};
    cred.dwVersion = SCHANNEL_CRED_VERSION;
    cred.grbitEnabledProtocols = 0;          // 跟随系统默认(TLS1.2+)
    cred.dwFlags = SCH_CRED_AUTO_CRED_VALIDATION // 自动校验服务器证书链
                 | SCH_CRED_NO_DEFAULT_CREDS;    // 客户端无证书

    CredHandle hCred;
    SECURITY_STATUS ss = AcquireCredentialsHandleA(
        NULL, (SEC_CHAR*)UNISP_NAME_A, SECPKG_CRED_OUTBOUND,
        NULL, &cred, NULL, NULL, &hCred, NULL);
    if (ss != SEC_E_OK) return -1;

    CtxtHandle hCtx;
    SecBufferDesc out_desc;
    SecBuffer out_buf;
    out_desc.ulVersion = SECBUFFER_VERSION;
    out_desc.cBuffers = 1;
    out_desc.pBuffers = &out_buf;
    out_buf.BufferType = SECBUFFER_TOKEN;
    out_buf.cbBuffer = 0;
    out_buf.pvBuffer = NULL;

    ULONG attrs = ISC_REQ_ALLOCATE_MEMORY | ISC_REQ_CONFIDENTIALITY |
                  ISC_REQ_REPLAY_DETECT | ISC_REQ_SEQUENCE_DETECT | ISC_REQ_STREAM;

    // 首次调用产生 ClientHello
    ss = InitializeSecurityContextA(
        &hCred, NULL, (SEC_CHAR*)hostname, attrs, 0, 0,
        NULL, 0, &hCtx, &out_desc, &attrs, NULL);
    if (ss != SEC_I_CONTINUE_NEEDED) {
        FreeCredentialsHandle(&hCred);
        return -1;
    }
    if (out_buf.pvBuffer && out_buf.cbBuffer > 0) {
        if (tls_send_all(sock, (char*)out_buf.pvBuffer, out_buf.cbBuffer) != 0) {
            FreeContextBuffer(out_buf.pvBuffer);
            FreeCredentialsHandle(&hCred);
            return -1;
        }
    }
    if (out_buf.pvBuffer) FreeContextBuffer(out_buf.pvBuffer);

    // 握手循环:收发令牌直到完成
    char inbuf[16384];
    int inlen = 0;
    int done = 0;
    while (!done) {
        int n = recv(sock, inbuf + inlen, sizeof(inbuf) - inlen, 0);
        if (n <= 0) {
            DeleteSecurityContext(&hCtx);
            FreeCredentialsHandle(&hCred);
            return -1;
        }
        inlen += n;

        SecBuffer in_bufs[2];
        SecBufferDesc in_desc;
        in_bufs[0].BufferType = SECBUFFER_TOKEN;
        in_bufs[0].cbBuffer = inlen;
        in_bufs[0].pvBuffer = inbuf;
        in_bufs[1].BufferType = SECBUFFER_EMPTY;
        in_bufs[1].cbBuffer = 0;
        in_bufs[1].pvBuffer = NULL;
        in_desc.ulVersion = SECBUFFER_VERSION;
        in_desc.cBuffers = 2;
        in_desc.pBuffers = in_bufs;

        out_buf.BufferType = SECBUFFER_TOKEN;
        out_buf.cbBuffer = 0;
        out_buf.pvBuffer = NULL;

        ss = InitializeSecurityContextA(
            &hCred, &hCtx, (SEC_CHAR*)hostname, attrs, 0, 0,
            &in_desc, 0, NULL, &out_desc, &attrs, NULL);

        if (ss == SEC_E_OK || ss == SEC_I_CONTINUE_NEEDED ||
            ss == SEC_I_INCOMPLETE_CREDENTIALS) {
            // 处理未消费的额外数据(下次握手输入)
            if (in_bufs[1].BufferType == SECBUFFER_EXTRA && in_bufs[1].cbBuffer > 0) {
                memmove(inbuf, inbuf + (inlen - in_bufs[1].cbBuffer), in_bufs[1].cbBuffer);
                inlen = in_bufs[1].cbBuffer;
            } else {
                inlen = 0;
            }
            if (out_buf.pvBuffer && out_buf.cbBuffer > 0) {
                if (tls_send_all(sock, (char*)out_buf.pvBuffer, out_buf.cbBuffer) != 0) {
                    FreeContextBuffer(out_buf.pvBuffer);
                    DeleteSecurityContext(&hCtx);
                    FreeCredentialsHandle(&hCred);
                    return -1;
                }
            }
            if (out_buf.pvBuffer) FreeContextBuffer(out_buf.pvBuffer);
            if (ss == SEC_E_OK) done = 1;
        } else if (ss == SEC_E_INCOMPLETE_MESSAGE) {
            // 数据不足,继续接收(保留 inlen)
            continue;
        } else {
            DeleteSecurityContext(&hCtx);
            FreeCredentialsHandle(&hCred);
            return -1;
        }
    }

    xt_tls_conn* c = (xt_tls_conn*)calloc(1, sizeof(xt_tls_conn));
    c->sockfd = sock;
    c->cred = hCred;
    c->ctx = hCtx;
    c->ctx_valid = 1;
    QueryContextAttributesA(&hCtx, SECPKG_ATTR_STREAM_SIZES, &c->sizes);
    c->leftover = NULL;
    c->leftover_len = 0;
    *ctx_out = c;
    return 0;
}

/** TLS 加密发送。成功返回 0,失败 -1。 */
int xt_tls_send(void* ctx, const char* data, int len) {
    xt_tls_conn* c = (xt_tls_conn*)ctx;
    int header = c->sizes.cbHeader;
    int trailer = c->sizes.cbTrailer;
    int maxmsg = c->sizes.cbMaximumMessage;
    char* buf = (char*)malloc(header + maxmsg + trailer);
    if (!buf) return -1;

    int off = 0;
    while (off < len) {
        int chunk = len - off;
        if (chunk > maxmsg) chunk = maxmsg;
        memcpy(buf + header, data + off, chunk);

        SecBuffer bufs[4];
        SecBufferDesc desc;
        bufs[0].BufferType = SECBUFFER_STREAM_HEADER;
        bufs[0].cbBuffer = header;
        bufs[0].pvBuffer = buf;
        bufs[1].BufferType = SECBUFFER_DATA;
        bufs[1].cbBuffer = chunk;
        bufs[1].pvBuffer = buf + header;
        bufs[2].BufferType = SECBUFFER_STREAM_TRAILER;
        bufs[2].cbBuffer = trailer;
        bufs[2].pvBuffer = buf + header + chunk;
        bufs[3].BufferType = SECBUFFER_EMPTY;
        bufs[3].cbBuffer = 0;
        bufs[3].pvBuffer = NULL;
        desc.ulVersion = SECBUFFER_VERSION;
        desc.cBuffers = 4;
        desc.pBuffers = bufs;

        SECURITY_STATUS ss = EncryptMessage(&c->ctx, 0, &desc, 0);
        if (ss != SEC_E_OK) { free(buf); return -1; }
        int total = bufs[0].cbBuffer + bufs[1].cbBuffer + bufs[2].cbBuffer;
        if (tls_send_all(c->sockfd, buf, total) != 0) { free(buf); return -1; }
        off += chunk;
    }
    free(buf);
    return 0;
}

/**
 * TLS 接收并解密。返回读取字节数;0=连接关闭;-1=错误。
 */
int xt_tls_recv(void* ctx, char* out, int cap) {
    xt_tls_conn* c = (xt_tls_conn*)ctx;
    // 先消费上次的解密余量
    if (c->leftover_len > 0) {
        int n = c->leftover_len < cap ? c->leftover_len : cap;
        memcpy(out, c->leftover, n);
        if (n < c->leftover_len) {
            memmove(c->leftover, c->leftover + n, c->leftover_len - n);
            c->leftover_len -= n;
        } else {
            free(c->leftover);
            c->leftover = NULL;
            c->leftover_len = 0;
        }
        return n;
    }

    if (!c->inbuf) {
        c->incap = 32768;
        c->inbuf = (char*)malloc(c->incap);
        c->inlen = 0;
    }

    for (;;) {
        if (c->inlen > 0) {
            SecBuffer bufs[4];
            SecBufferDesc desc;
            bufs[0].BufferType = SECBUFFER_DATA;
            bufs[0].cbBuffer = c->inlen;
            bufs[0].pvBuffer = c->inbuf;
            bufs[1].BufferType = SECBUFFER_EMPTY;
            bufs[2].BufferType = SECBUFFER_EMPTY;
            bufs[3].BufferType = SECBUFFER_EMPTY;
            desc.ulVersion = SECBUFFER_VERSION;
            desc.cBuffers = 4;
            desc.pBuffers = bufs;

            SECURITY_STATUS ss = DecryptMessage(&c->ctx, &desc, 0, NULL);
            if (ss == SEC_E_OK || ss == SEC_I_RENEGOTIATE || ss == SEC_I_CONTEXT_EXPIRED) {
                // 收集 DATA 与 EXTRA 缓冲
                int data_len = 0;
                char* data_ptr = NULL;
                int extra_len = 0;
                char* extra_ptr = NULL;
                for (int i = 0; i < 4; i++) {
                    if (bufs[i].BufferType == SECBUFFER_DATA && bufs[i].cbBuffer > 0) {
                        data_ptr = (char*)bufs[i].pvBuffer;
                        data_len = bufs[i].cbBuffer;
                    }
                    if (bufs[i].BufferType == SECBUFFER_EXTRA && bufs[i].cbBuffer > 0) {
                        extra_ptr = (char*)bufs[i].pvBuffer;
                        extra_len = bufs[i].cbBuffer;
                    }
                }
                // 先取应用数据,再挪动 EXTRA(防止 memmove 覆盖未拷贝的数据区)
                int deliver = 0;
                if (data_len > 0) {
                    deliver = data_len < cap ? data_len : cap;
                    memcpy(out, data_ptr, deliver);
                    if (deliver < data_len) {
                        c->leftover = (char*)malloc(data_len - deliver);
                        memcpy(c->leftover, data_ptr + deliver, data_len - deliver);
                        c->leftover_len = data_len - deliver;
                    }
                }
                // EXTRA(下一条 TLS 记录的密文头)保留在持久缓冲头部,跨调用存活
                if (extra_len > 0 && extra_ptr) {
                    memmove(c->inbuf, extra_ptr, extra_len);
                    c->inlen = extra_len;
                } else {
                    c->inlen = 0;
                }
                if (ss == SEC_I_CONTEXT_EXPIRED) return 0;
                if (deliver > 0) return deliver;
                continue; // 无应用数据(控制消息),继续
            } else if (ss == SEC_E_INCOMPLETE_MESSAGE) {
                // 数据不足:落到下方接收更多
            } else {
                return -1;
            }
        }

        // 缓冲余量不足则扩容(TLS 记录最大 16KB+头部)
        if (c->incap - c->inlen < 16384 + 64) {
            c->incap *= 2;
            c->inbuf = (char*)realloc(c->inbuf, c->incap);
        }
        int n = recv(c->sockfd, c->inbuf + c->inlen, c->incap - c->inlen, 0);
        if (n <= 0) return 0; // 连接关闭
        c->inlen += n;
    }
}

void xt_tls_close(void* ctx) {
    xt_tls_conn* c = (xt_tls_conn*)ctx;
    if (!c) return;
    if (c->ctx_valid) DeleteSecurityContext(&c->ctx);
    FreeCredentialsHandle(&c->cred);
    if (c->leftover) free(c->leftover);
    if (c->inbuf) free(c->inbuf);
    free(c);
}

#else
// 非 Windows 平台：暂不支持 HTTPS/TLS（Schannel/SSPI 为 Windows 专用）。
// 与 evaluator/ffi_other.go 的平台隔离模式一致——提供明确的"暂不支持"存根，
// 使 macOS/Linux 上整套运行时可完整编译链接，HTTPS 请求运行时返回错误而非崩溃。
#include <stdint.h>
#include <stddef.h>

int xt_tls_handshake(uintptr_t sock_v, const char* hostname, void** ctx_out) {
    (void)sock_v; (void)hostname;
    if (ctx_out) *ctx_out = NULL;
    return -1;  // 调用方（xt_net.c）收到失败后返回"TLS 握手失败"错误
}
int xt_tls_send(void* ctx, const char* data, int len) { (void)ctx; (void)data; (void)len; return -1; }
int xt_tls_recv(void* ctx, char* out, int cap) { (void)ctx; (void)out; (void)cap; return -1; }
void xt_tls_close(void* ctx) { (void)ctx; }
#endif
