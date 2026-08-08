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
#define XT_FIBER_RUNNING  4  // 正在被 poll(出队即置位;poll 裸返回 PENDING 时若仍为此态,须重新入队)

// 调度器配置
#define XT_MAX_FIBERS      65535 // fiber 池;句柄=下标+1,须 ≤0x10000 以与指针对象区分
#define XT_TIMER_HEAP_SIZE 8192 // 小顶堆容量(原128,压测200fiber睡眠会溢出静默丢fiber)
#define XT_SCHED_TICK_US   1000  // 调度滴答 1ms

typedef struct XTFiber {
    void* state;              // 状态结构体指针
    int   (*poll)(void*);     // poll 函数
    int   status;
    int64_t wakeup_at;        // 唤醒时间（微秒，仅 SLEEPING）
    void* wait_target;        // 等待目标（task ptr，仅 WAITING）
    uintptr_t result;         // 完成返回值(XTValue)，由 xt_fiber_set_result 写入，默认 0(空)
    int   result_consumed;    // 结果已被 等待/xt_task_result 消费(回收前置条件)
    int   in_free_list;       // 已在回收空闲栈中(防重复入栈)
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
void      xt_fiber_set_result(uintptr_t v);   // 当前 fiber 写入完成返回值

// 内部
void      xt_scheduler_enqueue(XTFiber* f);
XTFiber*  xt_scheduler_dequeue();
void      xt_scheduler_timer_add(XTFiber* f, int64_t wakeup_at);
void      xt_scheduler_timer_tick(int64_t now);

#endif
