// xt_scheduler.h — 用户态调度器（无栈状态机调度）
// P5: 就绪队列 + 定时器堆 + suspend/resume
#ifndef XT_SCHEDULER_H
#define XT_SCHEDULER_H

#include <stdint.h>

// Fiber 状态
#define XT_FIBER_READY    0
#define XT_FIBER_WAITING  1  // 等待任务完成
#define XT_FIBER_SLEEPING 2  // 定时睡眠
#define XT_FIBER_DONE     3  // 已完成

// 调度器配置
#define XT_MAX_FIBERS      256
#define XT_TIMER_HEAP_SIZE 128
#define XT_SCHED_TICK_US   1000  // 调度滴答 1ms

typedef struct XTFiber {
    void* state;              // 状态结构体指针
    int   (*poll)(void*);     // poll 函数
    int   status;
    int64_t wakeup_at;        // 唤醒时间（微秒，仅 SLEEPING）
    void* wait_target;        // 等待目标（task ptr，仅 WAITING）
    struct XTFiber* next;     // 链表指针
} XTFiber;

typedef struct {
    XTFiber* fibers;          // fiber 池（预分配数组）
    int      fiber_count;

    XTFiber* ready_head;      // 就绪队列（FIFO）
    XTFiber* ready_tail;

    XTFiber* timer_heap[XT_TIMER_HEAP_SIZE]; // 小顶堆（按 wakeup_at）
    int      timer_count;

    int64_t  now_us;          // 当前时间（微秒）
    int      running;
    XTFiber* current;         // 当前运行的 fiber
} XTScheduler;

// 全局调度器
extern XTScheduler* g_scheduler;

// API
void      xt_scheduler_init();
XTFiber*  xt_scheduler_spawn(void* state, int (*poll)(void*));
void      xt_scheduler_run();       // 主事件循环
void      xt_scheduler_yield();     // 当前 fiber 让出，重新入队
void      xt_scheduler_sleep_us(int64_t us); // 当前 fiber 睡眠
void      xt_scheduler_wait_task(void* task); // 当前 fiber 等待任务
void      xt_scheduler_wake_task(void* task); // 任务完成时唤醒等待 fiber

// 内部
void      xt_scheduler_enqueue(XTFiber* f);
XTFiber*  xt_scheduler_dequeue();
void      xt_scheduler_timer_add(XTFiber* f, int64_t wakeup_at);
void      xt_scheduler_timer_tick(int64_t now);

#endif
