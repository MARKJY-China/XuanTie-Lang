// xt_threadpool.c — 玄铁工作窃取线程池实现
// 编译: gcc -c xt_threadpool.c -o xt_threadpool.o

#include "xt_threadpool.h"
#include <stdlib.h>
#include <stdio.h>

// ============================================================
// 平台抽象实现
// ============================================================

#if defined(_WIN32)
#include <process.h>   // _beginthreadex

void xt_mutex_init(xt_mutex_t* m)   { InitializeCriticalSection(m); }
void xt_mutex_destroy(xt_mutex_t* m) { DeleteCriticalSection(m); }
void xt_mutex_lock(xt_mutex_t* m)    { EnterCriticalSection(m); }
void xt_mutex_unlock(xt_mutex_t* m)  { LeaveCriticalSection(m); }

void xt_cond_init(xt_cond_t* c)     { InitializeConditionVariable(c); }
void xt_cond_destroy(xt_cond_t* c)  { /* no-op on Windows */ }
void xt_cond_wait(xt_cond_t* c, xt_mutex_t* m) { SleepConditionVariableCS(c, m, INFINITE); }
void xt_cond_signal(xt_cond_t* c)   { WakeConditionVariable(c); }
void xt_cond_broadcast(xt_cond_t* c) { WakeAllConditionVariable(c); }

typedef struct {
    xt_thread_func func;
    void* arg;
} xt_thread_wrapper;

static unsigned __stdcall xt_thread_proc(void* p) {
    xt_thread_wrapper* w = (xt_thread_wrapper*)p;
    w->func(w->arg);
    free(w);
    return 0;
}

int xt_thread_create(xt_thread_t* t, xt_thread_func f, void* arg) {
    xt_thread_wrapper* w = (xt_thread_wrapper*)malloc(sizeof(xt_thread_wrapper));
    if (!w) return -1;
    w->func = f; w->arg = arg;
    *t = (HANDLE)_beginthreadex(NULL, 0, xt_thread_proc, w, 0, NULL);
    return (*t != NULL) ? 0 : -1;
}

int xt_thread_join(xt_thread_t t) {
    WaitForSingleObject(t, INFINITE);
    CloseHandle(t);
    return 0;
}

#else
// POSIX (Linux/macOS)
#include <string.h>
#include <unistd.h>

void xt_mutex_init(xt_mutex_t* m)   { pthread_mutex_init(m, NULL); }
void xt_mutex_destroy(xt_mutex_t* m) { pthread_mutex_destroy(m); }
void xt_mutex_lock(xt_mutex_t* m)    { pthread_mutex_lock(m); }
void xt_mutex_unlock(xt_mutex_t* m)  { pthread_mutex_unlock(m); }

void xt_cond_init(xt_cond_t* c)     { pthread_cond_init(c, NULL); }
void xt_cond_destroy(xt_cond_t* c)  { pthread_cond_destroy(c); }
void xt_cond_wait(xt_cond_t* c, xt_mutex_t* m) { pthread_cond_wait(c, m); }
void xt_cond_signal(xt_cond_t* c)   { pthread_cond_signal(c); }
void xt_cond_broadcast(xt_cond_t* c) { pthread_cond_broadcast(c); }

int xt_thread_create(xt_thread_t* t, xt_thread_func f, void* arg) {
    return pthread_create(t, NULL, (void*(*)(void*))f, arg);
}

int xt_thread_join(xt_thread_t t) {
    return pthread_join(t, NULL);
}

#endif

// ============================================================
// 线程池实现
// ============================================================

#define MAX_TASKS 4096      // 最大任务容量
#define MAX_WORKERS 64       // 最大 worker 数

typedef struct {
    xt_pool_task func;       // 任务函数
    void* arg;              // 参数
    void* result;           // 返回值
    int done;               // 是否已完成
    int id;                 // 任务 ID
} pool_task;

typedef struct {
    int worker_id;
    int running;
} pool_worker;

static struct {
    xt_mutex_t mu;
    xt_cond_t  cv;           // worker 等待任务时休眠
    xt_cond_t  done_cv;      // 用于 xt_threadpool_wait 等待特定任务

    pool_task tasks[MAX_TASKS];
    int task_head;           // 下一个待分配的任务索引
    int task_count;          // 当前队列中的任务数
    int task_id_counter;     // 递增的任务 ID 分配器
    int shutdown;

    pool_worker workers[MAX_WORKERS];
    xt_thread_t threads[MAX_WORKERS];
    int worker_count;
} g_pool;

// Worker 线程主循环
static void* worker_loop(void* arg) {
    int wid = *(int*)arg;
    free(arg);

    xt_mutex_lock(&g_pool.mu);
    for (;;) {
        // 等待任务
        while (g_pool.task_count == 0 && !g_pool.shutdown) {
            xt_cond_wait(&g_pool.cv, &g_pool.mu);
        }

        if (g_pool.shutdown) {
            xt_mutex_unlock(&g_pool.mu);
            break;
        }

        // 取任务（从队列头部）
        int idx = g_pool.task_head;
        g_pool.task_head = (g_pool.task_head + 1) % MAX_TASKS;
        g_pool.task_count--;

        pool_task t = g_pool.tasks[idx];
        g_pool.tasks[idx].func = NULL; // 清空槽位
        xt_mutex_unlock(&g_pool.mu);

        // 执行任务
        t.result = t.func(t.arg);

        // 标记完成并通知等待者
        xt_mutex_lock(&g_pool.mu);
        for (int i = 0; i < MAX_TASKS; i++) {
            if (g_pool.tasks[i].id == t.id) {
                g_pool.tasks[i].result = t.result;
                g_pool.tasks[i].done = 1;
                break;
            }
        }
        xt_cond_broadcast(&g_pool.done_cv);
    }

    return NULL;
}

void xt_threadpool_init(int worker_count) {
    if (worker_count <= 0) {
#if defined(_WIN32)
        SYSTEM_INFO si;
        GetSystemInfo(&si);
        worker_count = (int)si.dwNumberOfProcessors;
#else
        worker_count = (int)sysconf(_SC_NPROCESSORS_ONLN);
#endif
        if (worker_count < 1) worker_count = 1;
    }
    if (worker_count > MAX_WORKERS) worker_count = MAX_WORKERS;

    g_pool.worker_count = worker_count;
    g_pool.task_head = 0;
    g_pool.task_count = 0;
    g_pool.task_id_counter = 0;
    g_pool.shutdown = 0;

    xt_mutex_init(&g_pool.mu);
    xt_cond_init(&g_pool.cv);
    xt_cond_init(&g_pool.done_cv);

    for (int i = 0; i < worker_count; i++) {
        int* wid = (int*)malloc(sizeof(int));
        *wid = i;
        g_pool.workers[i].worker_id = i;
        g_pool.workers[i].running = 1;
        xt_thread_create(&g_pool.threads[i], worker_loop, wid);
    }
}

void xt_threadpool_shutdown(void) {
    xt_mutex_lock(&g_pool.mu);
    g_pool.shutdown = 1;
    xt_cond_broadcast(&g_pool.cv);
    xt_mutex_unlock(&g_pool.mu);

    for (int i = 0; i < g_pool.worker_count; i++) {
        xt_thread_join(g_pool.threads[i]);
    }

    xt_mutex_destroy(&g_pool.mu);
    xt_cond_destroy(&g_pool.cv);
    xt_cond_destroy(&g_pool.done_cv);
}

int xt_threadpool_submit(xt_pool_task func, void* arg) {
    xt_mutex_lock(&g_pool.mu);

    if (g_pool.task_count >= MAX_TASKS) {
        xt_mutex_unlock(&g_pool.mu);
        return -1; // 队列满
    }

    int slot = (g_pool.task_head + g_pool.task_count) % MAX_TASKS;
    int id = g_pool.task_id_counter++;
    g_pool.tasks[slot].func = func;
    g_pool.tasks[slot].arg = arg;
    g_pool.tasks[slot].result = NULL;
    g_pool.tasks[slot].done = 0;
    g_pool.tasks[slot].id = id;
    g_pool.task_count++;

    xt_cond_signal(&g_pool.cv);
    xt_mutex_unlock(&g_pool.mu);
    return id;
}

void* xt_threadpool_wait(int task_id) {
    xt_mutex_lock(&g_pool.mu);
    for (;;) {
        // 搜索任务
        int found = 0;
        for (int i = 0; i < MAX_TASKS; i++) {
            if (g_pool.tasks[i].id == task_id && g_pool.tasks[i].done) {
                void* r = g_pool.tasks[i].result;
                xt_mutex_unlock(&g_pool.mu);
                return r;
            }
            if (g_pool.tasks[i].id == task_id) {
                found = 1;
            }
        }
        if (!found) {
            // 任务 ID 不存在（可能已完成并被覆盖）
            xt_mutex_unlock(&g_pool.mu);
            return NULL;
        }
        xt_cond_wait(&g_pool.done_cv, &g_pool.mu);
    }
}

int xt_threadpool_worker_count(void) { return g_pool.worker_count; }
int xt_threadpool_pending_count(void) { return g_pool.task_count; }
