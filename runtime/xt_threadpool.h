// xt_threadpool.h — 玄铁轻量级工作窃取线程池 v1.0
// M 个 OS 线程执行 N 个用户任务，类 Go 协程模型
//
// 设计原则：
//   1. 固定数量 worker 线程（默认 CPU 核数）
//   2. 全局任务队列 + 每 worker 本地队列（工作窃取）
//   3. 任务函数签名：int64_t func(int64_t arg)
//   4. 单头文件包含，零外部依赖（除 pthread / Win32 threads）

#ifndef XT_THREADPOOL_H
#define XT_THREADPOOL_H

#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0600
#endif

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

// === 平台抽象：线程 + 互斥锁 + 条件变量 ===

#if defined(_WIN32)
#include <windows.h>
typedef HANDLE xt_thread_t;
typedef CRITICAL_SECTION xt_mutex_t;
typedef CONDITION_VARIABLE xt_cond_t;
#else
#include <pthread.h>
typedef pthread_t xt_thread_t;
typedef pthread_mutex_t xt_mutex_t;
typedef pthread_cond_t xt_cond_t;
#endif

// 互斥锁操作
void xt_mutex_init(xt_mutex_t* m);
void xt_mutex_destroy(xt_mutex_t* m);
void xt_mutex_lock(xt_mutex_t* m);
void xt_mutex_unlock(xt_mutex_t* m);

// 条件变量操作
void xt_cond_init(xt_cond_t* c);
void xt_cond_destroy(xt_cond_t* c);
void xt_cond_wait(xt_cond_t* c, xt_mutex_t* m);
void xt_cond_signal(xt_cond_t* c);
void xt_cond_broadcast(xt_cond_t* c);

// 线程创建
typedef void* (*xt_thread_func)(void* arg);
int xt_thread_create(xt_thread_t* t, xt_thread_func f, void* arg);
int xt_thread_join(xt_thread_t t);

// === 线程池 ===

// 任务函数签名：接受一个指针参数，返回 void* 结果
typedef void* (*xt_pool_task)(void* arg);

// 初始化线程池（worker_count=0 表示 CPU 核数）
void xt_threadpool_init(int worker_count);

// 关闭线程池，等待所有 worker 退出
void xt_threadpool_shutdown(void);

// 提交异步任务，返回任务 ID（非负整数）
int xt_threadpool_submit(xt_pool_task func, void* arg);

// 阻塞等待指定任务完成，返回任务结果
void* xt_threadpool_wait(int task_id);
void* xt_threadpool_try_wait(int task_id);

// 获取当前 worker 数量
int xt_threadpool_worker_count(void);

// 获取待处理任务数量（近似值）
int xt_threadpool_pending_count(void);

#ifdef __cplusplus
}
#endif

#endif // XT_THREADPOOL_H
