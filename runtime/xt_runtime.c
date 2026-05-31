/**
 * @file xt_runtime.c
 * @brief 玄铁编程语言 (XuanTie) 运行时环境实现核心
 * 
 * 本文件是玄铁语言的底层支柱，负责处理内存分配、对象生命周期管理（ARC）、
 * 核心数据结构（数组、字典、字符串）以及与操作系统的交互（文件 I/O、系统执行等）。
 * 
 * 设计核心原则：
 * 1. 标记指针 (Tagged Pointer)：利用 64 位指针的最低位 (LSB) 区分整数和对象指针。
 * 2. 自动引用计数 (ARC)：通过对象头部的原子计数器实现自动内存管理。
n// xt_net.c 提供的函数（避免循环依赖，不在头文件中声明）
 * 3. 区域分配 (Arena)：为高性能自举编译提供批量内存分配和一次性回收能力。
 * 4. 跨 ABI 兼容性：专门针对 MinGW 工具链优化了变参 FFI 调用。
 */

#define __USE_MINGW_ANSI_STDIO 1 // 强制 MinGW 使用兼容 C99 的 stdio 实现，支持 %lld 和 UTF-8
#include "xt_runtime.h"
#include "xt_threadpool.h"
#include "xt_net.h"
#include <inttypes.h>
#include <time.h>
#include <locale.h>
#include <stddef.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <math.h>

#ifdef _WIN32
#include <shellapi.h>
#endif

// --- 前置内部函数声明 ---
static void print_pool_stats();
static int xt_is_real_ptr(XTValue val);

/**
 * @struct XTArena
 * @brief 区域分配器结构体
 * 
 * 用于自举编译器等高性能场景。Arena 是一块连续的预分配内存。
 * 在 Arena 中分配的对象引用计数被设为“长生不老”(IMMORTAL)，
 * 这样在编译期间无需频繁触发 ARC 释放，最后统一销毁 Arena 即可。
 */
typedef struct XTArena {
    XTObject header;    ///< 对象头，用于兼容 ARC 检查
    char* buffer;       ///< 内存块起始地址
    size_t size;        ///< 块总大小
    size_t offset;      ///< 当前分配偏移量
    struct XTArena* next; ///< 链表指针，用于支持 Arena 自动扩容
} XTArena;

// 全局状态
XTArena* g_current_arena = NULL; ///< 当前活动的内存区域（供 xt_net.c accept 线程访问）

#ifdef _WIN32
static __declspec(thread) XTArena* g_thread_arena = NULL; // TLS: 每线程独立 Arena
#else
static __thread XTArena* g_thread_arena = NULL;
#endif

static XTValue g_xt_args = XT_NULL;      ///< 命令行参数缓存
static XTWeakSlot* g_weak_slots = NULL;   ///< 弱引用旁路链表头部
static xt_chan_mutex_t g_weak_mutex;      ///< 保护 g_weak_slots 的锁

// 弱引用全局锁操作（用于 xt_weak_init / xt_dict_weak_init / xt_weak_clear）
#define WEAK_LOCK()   XT_CHAN_MUTEX_LOCK(&g_weak_mutex)
#define WEAK_UNLOCK() XT_CHAN_MUTEX_UNLOCK(&g_weak_mutex)

// 函数原型声明
XTArena* xt_arena_new(size_t size);
void* xt_arena_alloc_raw(size_t size);
void* xt_arena_alloc(size_t size, uint32_t type_id);
static uint64_t xt_hash_value(XTValue val);

/**
 * @brief 初始化运行时环境
 * 
 * 在程序启动时由 main 函数调用。
 * 关键点：
 * 1. 设置 Windows 控制台为 UTF-8 编码 (CP 65001)，解决中文显示问题。
 * 2. 设置区域设置 (Locale) 为 UTF8，确保 MinGW 的 printf/fprintf 能正确处理多字节字符。
 */
void xt_init() {
#ifdef _WIN32
    SetConsoleOutputCP(65001);   // 将 Windows 控制台输出切换到 UTF-8
    setlocale(LC_ALL, ".UTF8");  // 设置 C 运行时区域，增强 UTF-8 兼容性
    fflush(stdout);              // 清空初始缓冲区
#endif
    XT_CHAN_MUTEX_INIT(&g_weak_mutex);  // 初始化弱引用全局锁
    xt_threadpool_init(0);              // 初始化线程池（0=自动检测CPU核数）
    xt_net_init();                      // 初始化网络子系统
}

/**
 * @brief 初始化命令行参数列表
 * 
 * 将 C 风格的 argc/argv 转换为玄铁内置的数组对象。
 */
void xt_init_args(int argc, char** argv) {
#ifdef _WIN32
    // Windows 下优先尝试获取 Unicode 命令行参数并转换为 UTF-8
    int wargc;
    LPWSTR* wargv = CommandLineToArgvW(GetCommandLineW(), &wargc);
    if (wargv) {
        g_xt_args = xt_array_new(wargc);
        for (int i = 0; i < wargc; i++) {
            int utf8_len = WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, NULL, 0, NULL, NULL);
            if (utf8_len > 0) {
                char* utf8_str = (char*)malloc(utf8_len);
                WideCharToMultiByte(CP_UTF8, 0, wargv[i], -1, utf8_str, utf8_len, NULL, NULL);
                XTString* s = xt_string_new(utf8_str);
                xt_array_append(g_xt_args, (XTValue)s);
                xt_release((XTValue)s);
                free(utf8_str);
            } else {
                XTString* s = xt_string_new("");
                xt_array_append(g_xt_args, (XTValue)s);
                xt_release((XTValue)s);
            }
        }
        LocalFree(wargv);
        return;
    }
#endif

    // 非 Windows 平台或获取 Unicode 参数失败：使用标准的 argc/argv
    g_xt_args = xt_array_new(argc);
    for (int i = 0; i < argc; i++) {
        if (argv[i]) {
            XTString* s = xt_string_new(argv[i]);
            xt_array_append(g_xt_args, (XTValue)s);
            xt_release((XTValue)s);
        } else {
            XTString* s = xt_string_new("");
            xt_array_append(g_xt_args, (XTValue)s);
            xt_release((XTValue)s);
        }
    }
}

/**
 * @brief 获取命令行参数列表 (供玄铁代码调用)
 * 
 * 返回的是一个玄铁数组对象指针。
 */
XTValue xt_get_args() {
    if (g_xt_args == XT_NULL) {
        return xt_array_new(0);
    }
    xt_retain(g_xt_args); // 增加引用计数，遵循玄铁的“返回即持有”原则
    return g_xt_args;
}

// 调试模式开关
#define XT_DEBUG_MODE 0
#if XT_DEBUG_MODE
#define XT_DEBUG_PRINT(...) do { printf("DEBUG: " __VA_ARGS__); fflush(stdout); } while(0)
#else
#define XT_DEBUG_PRINT(...)
#endif

/**
 * @brief 跨平台字符串复制
 */
static char* xt_strdup(const char* s) {
    if (!s) return NULL;
    size_t len = strlen(s) + 1;
    char* res = (char*)malloc(len);
    if (res) memcpy(res, s, len);
    return res;
}

/**
 * @brief 打印 64 位整数
 */
void xt_print_int(int64_t val) {
    printf("%" PRId64 "\n", val);
    fflush(stdout); // 实时刷新，确保输出顺序正确
}

/**
 * @brief FFI printf 安全包装器
 * 
 * 【重要】解决 MinGW 环境下的 ABI 兼容性问题。
 * 在 LLVM IR 中直接操作变参函数极易导致指针偏移。通过这个 C 包装器，
 * 我们利用 C 编译器的标准 ABI 处理逻辑来中转调用 printf。
 * 
 * @param fmt 格式化字符串对象 (XTString)
 * @param arg 传递给格式化字符串的参数
 */
int xt_ffi_printf(XTString* fmt, XTValue arg) {
    // 指针安全检查：防止从 LLVM 传来的指针是非法的堆地址
    if (!fmt || !xt_is_real_ptr((XTValue)fmt)) {
        return 0;
    }
    if (!fmt->data) return 0;
    
    // 使用 fprintf 指向 stdout，在 MinGW 环境下比直接 printf 更稳定
    int res = fprintf(stdout, fmt->data, arg);
    fflush(stdout);
    return res;
}

/**
 * @brief 创建标记整数 (Tagged Integer)
 * 
 * 玄铁不为普通整数分配堆内存。它直接将整数左移 1 位，并将 LSB 设为 1。
 * 这样 64 位空间可以存储 63 位有符号整数，且能与偶数地址的指针瞬间区分。
 */
XTValue xt_int_new(int64_t val) {
    return XT_FROM_INT(val);
}

/**
 * @brief 创建浮点数对象
 * 
 * 浮点数无法像整数那样做标记，因此需要分配堆对象。
 */
void* xt_float_new(double val) {
    typedef struct { XTObject header; double value; } XTFloat;
    XTFloat* obj = (XTFloat*)xt_malloc(sizeof(XTFloat), XT_TYPE_FLOAT);
    obj->value = val;
    return (void*)obj;
}

/**
 * @brief 创建布尔值
 * 
 * 玄铁布尔值是单例常量：XT_TRUE(4), XT_FALSE(2)。
 */
XTValue xt_bool_new(int val) {
    return XT_FROM_BOOL(val);
}

/**
 * @brief 创建指定字节长度的字符串对象
 * 
 * 核心逻辑：
 * 1. 分配 XTString 结构体。
 * 2. 如果开启了 Arena，则从 Arena 分配数据区，并设置 data_in_arena 标志。
 * 3. 否则使用标准 malloc。
 */
XTString* xt_string_new_len(const char* data, size_t len) {
    XTString* s = (XTString*)xt_malloc(sizeof(XTString), XT_TYPE_STRING);
    s->length = len;
    
    if (g_current_arena) {
        // 在 Arena 中分配数据，一次性回收，防止自举编译器产生数百万个小碎内存
        s->data = (char*)xt_arena_alloc_raw(len + 1);
        s->data_in_arena = 1;
    } else {
        s->data = (char*)malloc(len + 1);
        s->data_in_arena = 0;
    }
    
    if (s->data) {
        memcpy(s->data, data, len);
        s->data[len] = '\0'; // 强制 NULL 结尾，确保兼容 FFI
    }
    return s;
}

/**
 * @brief 从 C 字符串创建玄铁字符串
 */
XTString* xt_string_new(const char* data) {
    if (!data) data = "";
    return xt_string_new_len(data, strlen(data));
}

/**
 * @brief 从单个字符字节创建字符串
 */
XTString* xt_string_from_char(char c) {
    char buf[2] = {c, '\0'};
    return xt_string_new(buf);
}

/**
 * @brief 获取 UTF-8 字符 (逻辑字符)
 * 
 * 考虑到 UTF-8 是变长编码，本函数通过位模式判断字符边界。
 * @return XTValue 包含该 UTF-8 字符的新字符串对象。
 */
XTValue xt_string_get_char(XTValue str_val, int64_t index) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_NULL;
    XTObject* obj = (XTObject*)str_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_NULL;
    
    XTString* s = (XTString*)str_val;
    if (index < 0) return XT_NULL;
    
    const char* p = s->data;
    int64_t current = 0;
    // 算法：遍历字节，识别 UTF-8 前缀位以跳转到下一个字符
    while (*p && current < index) {
        unsigned char c = (unsigned char)*p;
        if (c < 0x80) p += 1;
        else if ((c & 0xE0) == 0xC0) p += 2;
        else if ((c & 0xF0) == 0xE0) p += 3;
        else if ((c & 0xF8) == 0xF0) p += 4;
        else p += 1; 
        current++;
    }
    
    if (!*p) return XT_NULL;
    
    // 确定当前字符的字节长度
    int len = 0;
    unsigned char c = (unsigned char)*p;
    if (c < 0x80) len = 1;
    else if ((c & 0xE0) == 0xC0) len = 2;
    else if ((c & 0xF0) == 0xE0) len = 3;
    else if ((c & 0xF8) == 0xF0) len = 4;
    else len = 1;
    
    char buf[5] = {0};
    for (int i = 0; i < len && p[i]; i++) buf[i] = p[i];
    
    return (XTValue)xt_string_new(buf);
}

/**
 * @brief 获取指定偏移处的原始字节
 */
XTValue xt_string_get_byte(XTValue str_val, int64_t byte_index) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_FROM_INT(0);
    XTObject* obj = (XTObject*)str_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_FROM_INT(0);
    
    XTString* s = (XTString*)str_val;
    if (byte_index < 0 || (size_t)byte_index >= s->length) return XT_FROM_INT(0);
    
    unsigned char b = (unsigned char)s->data[byte_index];
    return XT_FROM_INT((int64_t)b);
}

/**
 * @brief 获取字节长度 (返回标记整数)
 */
XTValue xt_string_byte_length(XTValue str_val) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_FROM_INT(0);
    XTObject* obj = (XTObject*)str_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_FROM_INT(0);
    
    XTString* s = (XTString*)str_val;
    return XT_FROM_INT((int64_t)s->length);
}

/**
 * @brief 获取逻辑字符总数
 */
XTValue xt_string_char_count(XTValue str_val) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_FROM_INT(0);
    XTObject* obj = (XTObject*)str_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_FROM_INT(0);
    
    XTString* s = (XTString*)str_val;
    const char* p = s->data;
    int64_t count = 0;
    while (*p) {
        unsigned char c = (unsigned char)*p;
        if (c < 0x80) p += 1;
        else if ((c & 0xE0) == 0xC0) p += 2;
        else if ((c & 0xF0) == 0xE0) p += 3;
        else if ((c & 0xF8) == 0xF0) p += 4;
        else p += 1;
        count++;
    }
    return XT_FROM_INT(count);
}

/**
 * @brief 字符串转十六进制转义格式
 * 
 * 用于编译器生成 LLVM IR 时的常量字面量转换（如 "中" -> "\E4\B8\AD"）。
 */
XTValue xt_string_to_hex_string(XTValue str_val) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_NULL;
    XTString* s = (XTString*)str_val;

    size_t new_len = s->length * 3;
    char* buf = (char*)malloc(new_len + 1);
    char* p = buf;
    const char* hex = "0123456789ABCDEF";

    for (size_t i = 0; i < s->length; i++) {
        unsigned char b = (unsigned char)s->data[i];
        *p++ = '\\';
        *p++ = hex[b >> 4];
        *p++ = hex[b & 0x0F];
    }
    *p = '\0';

    XTString* res = xt_string_new_len(buf, new_len);
    free(buf);
    return (XTValue)res;
}

/**
 * @brief 迭代器辅助：获取下一个 UTF-8 字符
 */
XTString* xt_string_next_char(XTString* s, int64_t* offset) {
    if (!s || *offset >= (int64_t)s->length) return xt_string_new("");
    unsigned char* d = (unsigned char*)s->data + *offset;
    int len = 1;
    if (*d >= 0xf0) len = 4;
    else if (*d >= 0xe0) len = 3;
    else if (*d >= 0xc0) len = 2;
    
    if (*offset + len > (int64_t)s->length) len = (int)(s->length - *offset);
    
    char buf[5] = {0};
    memcpy(buf, d, len);
    *offset += len;
    return xt_string_new(buf);
}

/**
 * @brief 基础输出函数
 */
void xt_print_string(XTString* str) {
    if (!str) { printf("空\n"); return; }
    printf("%s\n", str->data);
}

void xt_print_bool(int val) {
    printf("%s\n", val ? "真" : "假");
}

void xt_print_float(double val) {
    printf("%g\n", val);
}

// --- 内存管理：Arena 区域分配器实现 ---

/**
 * @brief 创建新内存区域
 */
XTArena* xt_arena_new(size_t size) {
    XTArena* arena = (XTArena*)malloc(sizeof(XTArena));
    if (!arena) return NULL;
    
    // 初始化对象头，设为长生不老，防止在使用期间被 ARC 误杀
    atomic_init(&arena->header.ref_count, XT_REF_COUNT_IMMORTAL);
    arena->header.type_id = XT_TYPE_ARENA;
    arena->header.magic = XT_MAGIC;

    arena->buffer = (char*)calloc(1, size);
    if (!arena->buffer) { free(arena); return NULL; }
    arena->size = size;
    arena->offset = 0;
    arena->next = NULL;
    return arena;
}

/**
 * @brief 在当前 Arena 分配原始内存 (8字节对齐)
 */
void* xt_arena_alloc_raw(size_t size) {
    if (!g_current_arena) return malloc(size);
    
    // 对齐到 8 字节，确保现代 CPU 访问效率及兼容性
    size = (size + 7) & ~7;
    
    // 如果当前块空间不足，自动开辟新块并挂载到链表
    if (g_current_arena->offset + size > g_current_arena->size) {
        size_t next_size = (size > 100 * 1024 * 1024) ? size : 100 * 1024 * 1024;
        XTArena* new_block = xt_arena_new(next_size);
        if (!new_block) { fprintf(stderr, "Fatal error: out of memory (Arena raw expand)\n"); exit(1); }
        
        // 关键修复：为了保持用户持有的 arena 句柄（池）始终有效且能销毁整个链表，
        // 我们将当前块的内容“推”到新块中，而让 g_current_arena 始终作为活跃的“头部”。
        
        // 交换 buffer 和元数据 (跳过 header，保持 g_current_arena 的 header 状态)
        char* old_buffer = g_current_arena->buffer;
        size_t old_size = g_current_arena->size;
        size_t old_offset = g_current_arena->offset;
        
        g_current_arena->buffer = new_block->buffer;
        g_current_arena->size = new_block->size;
        g_current_arena->offset = 0;
        
        new_block->buffer = old_buffer;
        new_block->size = old_size;
        new_block->offset = old_offset;
        
        // 将旧块挂载到活跃块（头部）之后
        new_block->next = g_current_arena->next;
        g_current_arena->next = new_block;
    }
    
    void* ptr = g_current_arena->buffer + g_current_arena->offset;
    g_current_arena->offset += size;
    return ptr;
}

/**
 * @brief 在 Arena 中分配对象，并将引用计数设为长生不老 (IMMORTAL)
 */
void* xt_arena_alloc(size_t size, uint32_t type_id) {
    void* ptr = xt_arena_alloc_raw(size);
    XTObject* obj = (XTObject*)ptr;
    // 使用特殊计数值，使 xt_release 跳过释放逻辑
    atomic_init(&obj->ref_count, XT_REF_COUNT_IMMORTAL); 
    obj->type_id = type_id;
    obj->magic = XT_MAGIC;
    return ptr;
}

/**
 * @brief 激活一个 Arena 为全局分配上下文
 */
XTValue xt_arena_use(XTArena* arena) {
    g_current_arena = arena;
    return XT_NULL;
}

XTArena* xt_arena_disable(void) {
    XTArena* old = g_current_arena;
    g_current_arena = NULL;
    return old;
}

void xt_arena_restore(XTArena* arena) {
    g_current_arena = arena;
}

/**
 * @brief 销毁 Arena 及其所有关联内存
 *
 * 此函数解绑 Arena 并释放扩容链节点，但不会立即释放首节点 buffer。
 * 首节点 buffer 的释放延迟到 Arena 壳子被 ARC 回收时（xt_free_obj）。
 * 这样可保证在 buffer 被释放前，所有引用 Arena 内对象的局部变量
 * 都已通过 ARC 扫描（看到 IMMORTAL 后安全跳过）。
 */
XTValue xt_arena_destroy(XTArena* arena) {
    if (!arena) return XT_NULL;
    
    // 如果销毁的是当前正在使用的 Arena，先解除绑定
    // 此后新分配将回退到 malloc
    if (g_current_arena == arena) {
        g_current_arena = NULL;
    }

    // 释放扩容链节点（这些是内部链表节点，不被玄铁变量引用，可安全释放）
    XTArena* curr = arena->next;
    while (curr) {
        XTArena* next = curr->next;
        if (curr->buffer) {
            free(curr->buffer);
            curr->buffer = NULL;
        }
        free(curr);
        curr = next;
    }
    arena->next = NULL;

    // 首节点 buffer 不释放——等待 ARC 在作用域结束时回收 Arena 壳子时一并释放
    // 降级：将 ref_count 从 IMMORTAL 改为 2，预留一次给编译器的调用后 release
    // 作用域退出时最后一次 release 才会触发 xt_free_obj 释放 buffer
    atomic_store(&arena->header.ref_count, 2);

    return XT_NULL;
}

/**
 * @brief 核心内存分配入口
 * 
 * 所有堆对象均需通过此函数创建。它会自动识别当前是否处于 Arena 模式。
 */
void* xt_malloc(size_t size, uint32_t type_id) {
    XTObject* obj;
    if (g_current_arena) {
        obj = (XTObject*)xt_arena_alloc(size, type_id);
    } else {
        obj = (XTObject*)malloc(size);
        if (obj) {
            atomic_init(&obj->ref_count, 1);
            obj->type_id = type_id;
        }
    }
    if (obj) {
        obj->magic = XT_MAGIC;
    } else {
        fprintf(stderr, "Fatal error: out of memory (xt_malloc)\n");
        exit(1);
    }
    return (void*)obj;
}

static inline void xt_check_obj(void* val) {
    if (!xt_is_real_ptr((XTValue)val)) return;
    XTObject* obj = (XTObject*)val;
    if (obj->magic != XT_MAGIC) {
        fprintf(stderr, "运行时错误: 检测到堆损坏或非法指针访问 (Addr=%p Type=%08x Magic=%08x)\n", val, obj->type_id, obj->magic);
        fprintf(stderr, "  值低8字节(hex): ");
        for (int di = 0; di < 32 && di < (int)sizeof(XTObject); di++) {
            fprintf(stderr, "%02x ", ((unsigned char*)val)[di]);
        }
        fprintf(stderr, "\n");
        // Windows 栈回溯（原始地址）
        #ifdef _WIN32
        {
            void* stack[16];
            unsigned short frames = CaptureStackBackTrace(0, 16, stack, NULL);
            fprintf(stderr, "  栈回溯 (%u 帧):\n", frames);
            for (unsigned short fi = 0; fi < frames; fi++) {
                fprintf(stderr, "    [%u] %p\n", fi, stack[fi]);
            }
        }
        #endif
        exit(-1);
    }
}

/**
 * @brief 注册弱引用槽位
 *
 * 将 slot_addr 注册为指向 obj 的弱引用。当 obj 被释放时，*slot_addr 会被置为 XT_NULL。
 */
void xt_weak_init(XTValue* slot_addr, XTValue obj_val) {
    if (!xt_is_real_ptr(obj_val) || obj_val == XT_NULL) return;
    XTObject* obj = (XTObject*)obj_val;
    XTWeakSlot* ws = (XTWeakSlot*)malloc(sizeof(XTWeakSlot));
    if (!ws) return;
    ws->obj = (void*)obj;
    ws->slot_addr = slot_addr;
    WEAK_LOCK();
    ws->next = g_weak_slots;
    g_weak_slots = ws;
    WEAK_UNLOCK();
}

/**
 * @brief 字典弱引用赋值：存值但不 retain，不 release 旧值
 */
void xt_dict_set_weak(XTValue dict_val, XTValue key, XTValue value) {
    if (!XT_IS_REAL_PTR(dict_val)) return;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT && obj->type_id != XT_TYPE_INSTANCE) return;
    XTDict* dict = (XTDict*)dict_val;

    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq(entry->key, key)) {
            entry->value = value;  // 不 release 旧值，不 retain 新值
            return;
        }
        entry = entry->next;
    }
    // 新建条目
    XTDictEntry* new_entry = (XTDictEntry*)malloc(sizeof(XTDictEntry));
    if (!new_entry) return;
    new_entry->key = key; new_entry->value = value;
    new_entry->next = dict->buckets[idx];
    dict->buckets[idx] = new_entry;
    dict->size++;
    xt_retain(key);   // 键仍然 retain
    // 值不 retain——弱引用核心语义
}

/**
 * @brief 注册字典弱引用槽位
 */
void xt_dict_weak_init(XTValue dict_val, XTValue key, XTValue obj_val) {
    if (!xt_is_real_ptr(obj_val) || obj_val == XT_NULL) return;
    XTObject* obj = (XTObject*)obj_val;
    XTWeakSlot* ws = (XTWeakSlot*)malloc(sizeof(XTWeakSlot));
    if (!ws) return;
    ws->obj = (void*)obj;
    ws->slot_addr = NULL;
    ws->dict_val = dict_val;
    ws->dict_key = key;
    xt_retain(key);
    WEAK_LOCK();
    ws->next = g_weak_slots;
    g_weak_slots = ws;
    WEAK_UNLOCK();
}

/**
 * @brief 清空指向特定对象的所有弱引用槽位
 */
static void xt_weak_clear(XTObject* obj) {
    XTWeakSlot** p = &g_weak_slots;
    while (*p) {
        XTWeakSlot* ws = *p;
        if (ws->obj == (void*)obj) {
            if (ws->slot_addr) {
                if (*ws->slot_addr == (XTValue)obj) { *ws->slot_addr = XT_NULL; }
            } else {
                xt_dict_set_weak(ws->dict_val, ws->dict_key, XT_NULL);
                xt_release(ws->dict_key);
            }
            *p = ws->next;
            free(ws);
        } else {
            p = &ws->next;
        }
    }
}

/**
 * @brief 深度递归释放对象
 *
 * 只有当引用计数降为 0 且非 Arena 对象时才会被调用。
 */
static void xt_free_obj(XTObject* obj) {
    if (!obj) return;


    // 安全检查：绝对不释放长生不老对象
    if (atomic_load(&obj->ref_count) >= XT_REF_COUNT_IMMORTAL) return;

    // 清空所有指向此对象的弱引用槽位
    xt_weak_clear(obj);

    switch (obj->type_id) {
        case XT_TYPE_STRING: {
            XTString* s = (XTString*)obj;
            // 如果数据区不在 Arena 中，则需要手动释放
            if (s->data && !s->data_in_arena) free(s->data);
            break;
        }
        case XT_TYPE_ARRAY: {
            XTArray* arr = (XTArray*)obj;
            // 数组销毁时，需要 release 内部所有元素
            for (size_t i = 0; i < arr->length; i++) {
                xt_release((XTValue)arr->elements[i]);
            }
            if (arr->elements) free(arr->elements);
            break;
        }
        case XT_TYPE_DICT: {
            XTDict* dict = (XTDict*)obj;
            // 字典销毁时，遍历所有桶并释放键值对
            for (size_t i = 0; i < dict->capacity; i++) {
                XTDictEntry* entry = dict->buckets[i];
                while (entry) {
                    XTDictEntry* next = entry->next;
                    xt_release(entry->key);
                    xt_release(entry->value);
                    free(entry);
                    entry = next;
                }
            }
            if (dict->buckets) free(dict->buckets);
            break;
        }
        case XT_TYPE_INSTANCE: {
            XTInstance* inst = (XTInstance*)obj;
            // 释放所有动态属性
            for (size_t i = 0; i < inst->capacity; i++) {
                XTDictEntry* entry = inst->buckets[i];
                while (entry) {
                    xt_release(entry->key);
                    xt_release(entry->value);
                    XTDictEntry* next = entry->next;
                    free(entry);
                    entry = next;
                }
            }
            if (inst->buckets) free(inst->buckets);
            break;
        }
        case XT_TYPE_RESULT: {
            XTResult* res = (XTResult*)obj;
            if (res->value) xt_release((XTValue)res->value);
            if (res->error) xt_release((XTValue)res->error);
            break;
        }
        case XT_TYPE_CHANNEL: {
            XTChannel* chan = (XTChannel*)obj;
            XT_CHAN_MUTEX_DESTROY(&chan->mu);
            if (chan->buffer) {
                for (size_t i = 0; i < chan->size; i++) {
                    size_t idx = (chan->head + i) % chan->capacity;
                    xt_release(chan->buffer[idx]);
                }
                free(chan->buffer);
            }
            break;
        }
        case XT_TYPE_SOCKET: {
            XTSocket* s = (XTSocket*)obj;
            xt_net_close_obj(s);
            break;
        }
        case XT_TYPE_BYTES: {
            XTBytes* bytes = (XTBytes*)obj;
            if (bytes->data && !bytes->header.type_id) { // 简单判断是否在 arena
                // 注意：这里需要更精确的 arena 判断，目前暂按 data_in_arena 逻辑
            }
            // 已经在 bytes_new 中处理了 data 释放逻辑 (通过 malloc/arena)
            // 如果不是 arena 分配，需要 free
            if (bytes->data) {
                // 目前 bytes 结构体没有 data_in_arena 标志，暂通过 ref_count 判断
                if (atomic_load(&bytes->header.ref_count) < XT_REF_COUNT_IMMORTAL) {
                    free(bytes->data);
                }
            }
            break;
        }
        case XT_TYPE_TASK: {
            XTTask* task = (XTTask*)obj;
            if (task->result != XT_NULL) xt_release(task->result);
            break;
        }
        case XT_TYPE_FUNCTION:
            // 函数对象（Lambda）目前仅持有纯指针，无额外堆成员
            break;
        case XT_TYPE_ARENA: {
            XTArena* arena = (XTArena*)obj;
            // 当 ARC 回收 Arena 时，释放其所有的 buffer 内存
            XTArena* curr = arena->next;
            while (curr) {
                XTArena* next = curr->next;
                if (curr->buffer) free(curr->buffer);
                free(curr);
                curr = next;
            }
            if (arena->buffer) free(arena->buffer);
            break;
        }
        default:
            break;
    }
    
    free(obj); // 释放结构体本身
}

/**
 * @brief 判断是否为真实的堆指针
 * 
 * 排除：1.标记整数(LSB=1) 2.空值(0) 3.布尔常量(2,4) 4.非法小地址
 */
static int xt_is_real_ptr(XTValue val) {
    // 委托给头文件宏 XT_IS_REAL_PTR（统一逻辑，避免不一致）
    return XT_IS_REAL_PTR(val);
}

/**
 * @brief 增加引用计数 (ARC Retain)
 */
// ARC 内存序约定 (Phase 3 安全审计通过):
//   xt_retain:  memory_order_relaxed — 仅需原子递增，无需同步其他内存操作
//   xt_release: memory_order_seq_cst — 若 old_ref==1 将析构对象，
//               seq_cst 保证所有线程对此对象的写在此线程可见
//   IMMORTAL 检查: relaxed — 仅读标志位，非同步点

void xt_retain(XTValue val) {
    if (XT_IS_INT(val)) return;
    if (xt_is_real_ptr(val)) {
        xt_check_obj((void*)val);
        XTObject* obj = (XTObject*)val;
        if (atomic_load_explicit(&obj->ref_count, memory_order_relaxed) >= XT_REF_COUNT_IMMORTAL) return;
        atomic_fetch_add_explicit(&obj->ref_count, 1, memory_order_relaxed);
    }
}

void xt_release(XTValue val) {
    if (XT_IS_INT(val)) return;
    if (xt_is_real_ptr(val)) {
        xt_check_obj((void*)val);
        XTObject* obj = (XTObject*)val;
        if (atomic_load_explicit(&obj->ref_count, memory_order_relaxed) >= XT_REF_COUNT_IMMORTAL) return;

        // seq_cst: 若触发析构，保证所有先前内存操作全局可见
        uint32_t old_ref = atomic_fetch_sub(&obj->ref_count, 1);
        if (old_ref == 1) {
            xt_free_obj(obj);
        }
    }
}

void xt_retain_forever(XTValue val) {
    if (!xt_is_real_ptr(val)) return;
    XTObject* obj = (XTObject*)val;
    atomic_store(&obj->ref_count, XT_REF_COUNT_IMMORTAL);
}

// --- 类型转换核心逻辑 ---

/**
 * @brief 提取 C 风格 64 位有符号整数
 */
int64_t xt_to_int(XTValue val) {
    if (XT_IS_INT(val)) return XT_TO_INT(val);
    if (val == XT_TRUE) return 1;
    if (val == XT_FALSE) return 0;
    if (val == XT_NULL) return 0;
    if (XT_IS_REAL_PTR(val)) {
        XTObject* obj = (XTObject*)val;
        if (obj->type_id == XT_TYPE_INT) return ((XTInt*)val)->value;
        if (obj->type_id == XT_TYPE_FLOAT) return (int64_t)((struct { XTObject h; double v; }*)val)->v;
        if (obj->type_id == XT_TYPE_STRING) return atoll(((XTString*)val)->data); // 字符串自动转整数
    }
    return 0;
}

XTValue xt_convert_to_int(XTValue val) {
    return XT_FROM_INT(xt_to_int(val));
}

/**
 * @brief 转换为 C 风格 double
 */
XTValue xt_convert_to_float(XTValue val) {
    double d = 0.0;
    if (XT_IS_INT(val)) d = (double)XT_TO_INT(val);
    else if (val == XT_TRUE) d = 1.0;
    else if (XT_IS_REAL_PTR(val)) {
        XTObject* obj = (XTObject*)val;
        if (obj->type_id == XT_TYPE_FLOAT) d = ((struct { XTObject h; double v; }*)val)->v;
        else if (obj->type_id == XT_TYPE_INT) d = (double)((XTInt*)val)->value;
        else if (obj->type_id == XT_TYPE_STRING) d = atof(((XTString*)val)->data);
    }
    return (XTValue)xt_float_new(d);
}

XTValue xt_convert_to_string(XTValue val) {
    return (XTValue)xt_obj_to_string(val);
}

// --- 动态数组 (Array) 实现 ---

/**
 * @brief 创建新数组，预分配空间
 */
XTValue xt_array_new(size_t capacity) {
    XTArray* arr = (XTArray*)xt_malloc(sizeof(XTArray), XT_TYPE_ARRAY);
    arr->length = 0;
    arr->capacity = capacity > 0 ? capacity : 4; 
    
    if (g_current_arena) {
        arr->elements = (void**)xt_arena_alloc_raw(sizeof(void*) * arr->capacity);
        arr->elements_in_arena = 1;
    } else {
        arr->elements = (void**)malloc(sizeof(void*) * arr->capacity);
        arr->elements_in_arena = 0;
    }
    return (XTValue)arr;
}

/**
 * @brief 数组追加元素，支持 2 倍扩容
 */
void xt_array_append(XTValue arr_val, XTValue element) {
    if (!XT_IS_REAL_PTR(arr_val)) return;
    XTArray* arr = (XTArray*)arr_val;
    
    if (arr->length >= arr->capacity) {
        size_t new_capacity = arr->capacity == 0 ? 4 : arr->capacity * 2;
        void** new_elements;
        if (g_current_arena) {
            new_elements = (void**)xt_arena_alloc_raw(sizeof(void*) * new_capacity);
            if (arr->elements) memcpy(new_elements, arr->elements, sizeof(void*) * arr->length);
            // 旧 elements 若是 malloc 的则泄漏，但 arena 模式通常贯穿程序生命周期
        } else {
            if (arr->elements && !arr->elements_in_arena) {
                new_elements = (void**)realloc(arr->elements, sizeof(void*) * new_capacity);
            } else {
                // elements 是 arena 分配的或为空，不能用 realloc
                new_elements = (void**)malloc(sizeof(void*) * new_capacity);
                if (arr->elements) memcpy(new_elements, arr->elements, sizeof(void*) * arr->length);
            }
            arr->elements_in_arena = 0;
        }
        if (!new_elements) return;
        arr->elements = new_elements;
        arr->capacity = new_capacity;
    }
    xt_retain(element); // 持有新元素
    arr->elements[arr->length++] = (void*)element;
}

/**
 * @brief 数组索引访问
 */
XTValue xt_array_get(XTValue arr_val, XTValue index_val) {
    if (!XT_IS_REAL_PTR(arr_val)) return XT_NULL;
    XTArray* arr = (XTArray*)arr_val;
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index >= arr->length) return XT_NULL;
    return (XTValue)arr->elements[index];
}

/**
 * @brief 弹出最后一个元素
 */
XTValue xt_array_pop(XTArray* arr) {
    if (!arr || arr->header.type_id != XT_TYPE_ARRAY || arr->length == 0) return XT_NULL;
    arr->length--;
    XTValue val = (XTValue)arr->elements[arr->length];
    arr->elements[arr->length] = NULL; // 清除槽位，防止未来追加时覆盖导致泄漏
    return val;
}

/**
 * @brief 修改指定位置元素
 */
void xt_array_set(XTValue arr_val, XTValue index_val, XTValue value) {
    if (!XT_IS_REAL_PTR(arr_val)) return;
    XTArray* arr = (XTArray*)arr_val;
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index >= arr->length) return;
    
    xt_release((XTValue)arr->elements[index]); // 释放旧引用
    arr->elements[index] = (void*)value;
    xt_retain(value); // 持有新引用
}

/**
 * @brief 删除指定索引处的元素并前移后续元素
 */
void xt_array_remove(XTValue arr_val, XTValue index_val) {
    if (!XT_IS_REAL_PTR(arr_val)) return;
    XTArray* arr = (XTArray*)arr_val;
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index >= arr->length) return;
    xt_release((XTValue)arr->elements[index]);
    for (size_t i = (size_t)index; i < arr->length - 1; i++) {
        arr->elements[i] = arr->elements[i+1];
    }
    arr->length--;
}

/**
 * @brief 插入元素到指定位置
 */
void xt_array_insert(XTValue arr_val, XTValue index_val, XTValue value) {
    if (!XT_IS_REAL_PTR(arr_val)) return;
    XTArray* arr = (XTArray*)arr_val;
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index > arr->length) return;
    
    xt_array_append(arr_val, value);
    for (size_t i = arr->length - 1; i > (size_t)index; i--) {
        void* temp = arr->elements[i];
        arr->elements[i] = arr->elements[i-1];
        arr->elements[i-1] = temp;
    }
}

/**
 * @brief 检查数组是否包含某个元素 (通过 xt_compare 比较内容)
 */
XTValue xt_array_contains(XTValue arr_val, XTValue element) {
    if (!XT_IS_REAL_PTR(arr_val)) return XT_FALSE;
    XTArray* arr = (XTArray*)arr_val;
    for (size_t i = 0; i < arr->length; i++) {
        if (xt_compare((XTValue)arr->elements[i], element) == 0) return XT_TRUE;
    }
    return XT_FALSE;
}

/**
 * @brief 查找元素索引，未找到返回 -1
 */
XTValue xt_array_find(XTValue arr_val, XTValue element) {
    if (!XT_IS_REAL_PTR(arr_val)) return XT_FROM_INT(-1);
    XTArray* arr = (XTArray*)arr_val;
    for (size_t i = 0; i < arr->length; i++) {
        if (xt_compare((XTValue)arr->elements[i], element) == 0) return XT_FROM_INT(i);
    }
    return XT_FROM_INT(-1);
}

/**
 * @brief 获取数组子切片
 */
XTValue xt_array_slice(XTValue arr_val, XTValue start_val) {
    if (!XT_IS_REAL_PTR(arr_val)) return xt_array_new(0);
    XTArray* arr = (XTArray*)arr_val;
    int64_t start = xt_to_int(start_val);
    if (start < 0) start = 0;
    if ((size_t)start >= arr->length) return xt_array_new(0);
    
    size_t new_len = arr->length - (size_t)start;
    XTValue new_arr_val = xt_array_new(new_len);
    for (size_t i = 0; i < new_len; i++) {
        xt_array_append(new_arr_val, (XTValue)arr->elements[start + i]);
    }
    return new_arr_val;
}

/**
 * @brief 生成范围整数数组 [start, end)
 */
XTValue xt_array_range(XTValue start_val, XTValue end_val) {
    int64_t start = xt_to_int(start_val);
    int64_t end = xt_to_int(end_val);
    if (start >= end) return xt_array_new(0);
    
    size_t len = (size_t)(end - start);
    XTValue new_arr_val = xt_array_new(len);
    for (int64_t i = start; i < end; i++) {
        xt_array_append(new_arr_val, XT_FROM_INT(i));
    }
    return new_arr_val;
}

// --- 实例与系统容器实现 ---

/**
 * @brief 创建玄铁类实例
 */
XTInstance* xt_instance_new(void* class_ptr, size_t field_count) {
    XTInstance* inst = (XTInstance*)xt_malloc(sizeof(XTInstance), XT_TYPE_INSTANCE);
    inst->class_ptr = class_ptr;
    
    // 初始化为一个小型的字典，以支持动态属性
    inst->capacity = 8;
    inst->size = 0;
    inst->buckets = (XTDictEntry**)malloc(sizeof(XTDictEntry*) * inst->capacity);
    memset(inst->buckets, 0, sizeof(XTDictEntry*) * inst->capacity);
    
    return inst;
}

/**
 * @brief 创建带有状态的结果对象 (Result)
 */
void* xt_result_new(int is_success, void* value, void* error) {
    XTResult* res = (XTResult*)xt_malloc(sizeof(XTResult), XT_TYPE_RESULT);
    res->is_success = is_success;
    res->value = value;
    res->error = error;
    if (value) xt_retain((XTValue)value);
    if (error) xt_retain((XTValue)error);
    return (void*)res;
}

/**
 * @brief 创建玄铁函数对象 (用于 Lambda 和闭包)
 */
XTValue xt_func_new(void* func_ptr) {
    XTFunction* obj = (XTFunction*)xt_malloc(sizeof(XTFunction), XT_TYPE_FUNCTION);
    obj->func_ptr = func_ptr;
    return (XTValue)obj;
}

// --- Socket 方法实现 (v0.2) ---

// 流.读() → 单参数版本（编译器无参调用只传 self）
static XTValue xt_socket_read_method(XTValue self) {
    if (!xt_is_real_ptr(self)) return XT_NULL;
    XTSocket* s = (XTSocket*)self;
    if (s->is_closed) return XT_NULL;
    char* data = (char*)xt_net_read(s, 4096);
    if (!data) return XT_NULL;
    XTString* str = xt_string_new(data);
    free(data);
    return (XTValue)str;
}

// 流.写(消息) / 流.发(消息) — 双参数版本
static XTValue xt_socket_write_method(XTValue self, XTValue msg) {
    if (!xt_is_real_ptr(self)) return XT_NULL;
    const char* text = "";
    if (xt_is_real_ptr(msg)) {
        XTObject* o = (XTObject*)msg;
        if (o->type_id == XT_TYPE_STRING) text = ((XTString*)msg)->data;
    }
    XTSocket* s = (XTSocket*)self;
    int rc = xt_net_write(s, text, (int)strlen(text));
    return XT_FROM_BOOL(rc > 0);
}

// 流.关() — 单参数版本
static XTValue xt_socket_close_method(XTValue self) {
    if (!xt_is_real_ptr(self)) return XT_NULL;
    xt_net_close_obj((XTSocket*)self);
    return XT_TRUE;
}

// 流.转字() — 单参数版本
static XTValue xt_socket_tostring_method(XTValue self) {
    return (XTValue)xt_string_new("Socket连接");
}

// 在 socket 对象上注册方法
void xt_socket_register_methods(XTSocket* s) {
    // socket 对象本身没有 dict——方法通过编译器硬编码路径分发
    // 此函数为空：方法在当前架构中通过 xt_dict_get 查找
    // socket 的方法在对象创建后通过编译器/字典注册
    (void)s;
}

// --- Result 方法实现 ---

// 结果.接着(成功回调)
static XTValue xt_result_then_method(XTValue self, XTValue callback) {
    XTResult* r = (XTResult*)self;
    if (r->is_success) {
        // 调用回调：callback(value)
        typedef XTValue (*xt_cb)(XTValue);
        xt_cb cb = (xt_cb)((XTFunction*)callback)->func_ptr;
        return cb((XTValue)r->value);
    }
    return self; // 返回自己以支持链式 .否则()
}

// 结果.否则(失败回调)
static XTValue xt_result_else_method(XTValue self, XTValue callback) {
    XTResult* r = (XTResult*)self;
    if (!r->is_success) {
        typedef XTValue (*xt_cb)(XTValue);
        xt_cb cb = (xt_cb)((XTFunction*)callback)->func_ptr;
        return cb((XTValue)r->error);
    }
    return self;
}

// 辅助：用 C 函数指针填装对象字典
static void dict_set_method(XTValue obj, const char* name, void* func_ptr) {
    XTValue key = (XTValue)xt_string_new(name);
    XTValue fn  = xt_func_new(func_ptr);
    xt_dict_set(obj, key, fn);
    xt_release(key);
    xt_release(fn);
}

// --- 字符串高级操作实现 ---

/**
 * @brief 获取 UTF-8 子字符串
 */
XTString* xt_string_substring(XTString* s, int64_t start, int64_t end) {
    if (!s) return xt_string_new("");
    
    const char* p = s->data;
    int64_t current = 0;
    const char* start_p = NULL;
    const char* end_p = NULL;
    
    while (*p) {
        if (current == start) start_p = p;
        if (current == end) { end_p = p; break; }
        
        unsigned char c = (unsigned char)*p;
        if (c < 0x80) p += 1;
        else if ((c & 0xE0) == 0xC0) p += 2;
        else if ((c & 0xF0) == 0xE0) p += 3;
        else if ((c & 0xF8) == 0xF0) p += 4;
        else p += 1;
        current++;
    }
    
    if (start_p && !end_p) end_p = p;
    if (!start_p) return xt_string_new("");
    
    size_t len = end_p - start_p;
    char* buf = (char*)malloc(len + 1);
    memcpy(buf, start_p, len);
    buf[len] = '\0';
    XTString* res = xt_string_new(buf);
    free(buf);
    return res;
}

/**
 * @brief 将数组元素用分隔符连接成字符串
 */
XTString* xt_array_join(XTValue arr_val, XTString* sep) {
    if (!XT_IS_REAL_PTR(arr_val)) return xt_string_new("");
    XTArray* arr = (XTArray*)arr_val;
    if (arr->length == 0) return xt_string_new("");
    
    size_t total_len = 0;
    size_t sep_len = sep ? sep->length : 0;
    
    // 第一遍：计算总缓冲区大小
    for (size_t i = 0; i < arr->length; i++) {
        XTString* s = xt_obj_to_string((XTValue)arr->elements[i]);
        total_len += s->length;
        if (i < arr->length - 1) total_len += sep_len;
        xt_release((XTValue)s);
    }
    
    // 第二遍：实际拼接
    char* buf = (char*)malloc(total_len + 1);
    char* p = buf;
    for (size_t i = 0; i < arr->length; i++) {
        XTString* s = xt_obj_to_string((XTValue)arr->elements[i]);
        memcpy(p, s->data, s->length);
        p += s->length;
        if (i < arr->length - 1 && sep) {
            memcpy(p, sep->data, sep->length);
            p += sep->length;
        }
        xt_release((XTValue)s);
    }
    *p = '\0';
    
    XTString* res = xt_string_new(buf);
    free(buf);
    return res;
}

int xt_string_contains(XTString* s, XTString* sub) {
    if (!s || !sub) return 0;
    return strstr(s->data, sub->data) != NULL;
}

/**
 * @brief 字符串拼接核心逻辑
 */
XTString* xt_string_concat(XTString* s1, XTString* s2) {
    size_t len1 = s1 ? s1->length : 0;
    size_t len2 = s2 ? s2->length : 0;
    size_t total_len = len1 + len2;
    
    char* data = (char*)malloc(total_len + 1);
    if (len1 > 0) memcpy(data, s1->data, len1);
    if (len2 > 0) memcpy(data + len1, s2->data, len2);
    data[total_len] = '\0';
    
    XTString* res = xt_string_new_len(data, total_len);
    free(data);
    return res;
}

/**
 * @brief 通用显示接口 (由编译器 示() 语句调用)
 */
void xt_print_value(XTValue val) {
    XTString* s = xt_obj_to_string(val);
    if (s) {
        printf("%s\n", s->data);
        fflush(stdout); // 解决 MinGW 环境下的输出延迟
        xt_release((XTValue)s);
    }
}

XTString* xt_int_to_string(int64_t val) {
    char buf[32];
    sprintf(buf, "%lld", val);
    return xt_string_new(buf);
}

XTString* xt_float_to_string(double val) {
    char buf[64];
    sprintf(buf, "%g", val);
    return xt_string_new(buf);
}

/**
 * @brief 核心对象反射转字符串接口
 */
XTString* xt_obj_to_string(XTValue val) {
    if (XT_IS_INT(val)) return xt_int_to_string(XT_TO_INT(val));
    if (val == XT_TRUE) return xt_string_new("真");
    if (val == XT_FALSE) return xt_string_new("假");
    if (val == XT_NULL) return xt_string_new("空");

    if (!xt_is_real_ptr(val)) return xt_string_new("非法地址");

    XTObject* header = (XTObject*)val;
    switch (header->type_id) {
        case XT_TYPE_INT: 
            return xt_int_to_string(((XTInt*)val)->value);
        case XT_TYPE_STRING:
            xt_retain(val);
            return (XTString*)val;
        case XT_TYPE_FLOAT:
            return xt_float_to_string(((struct { XTObject h; double v; }*)val)->v);
        case XT_TYPE_BOOL:
            return xt_string_new(((XTInt*)val)->value ? "真" : "假");
        case XT_TYPE_INSTANCE:
            return xt_string_new("实例对象");
        case XT_TYPE_RESULT: {
            XTResult* r = (XTResult*)val;
            XTString* prefix = r->is_success ? xt_string_new("成功(") : xt_string_new("失败(");
            XTString* inner = xt_obj_to_string((XTValue)(r->is_success ? r->value : r->error));
            XTString* suffix = xt_string_new(")");
            XTString* res1 = xt_string_concat(prefix, inner);
            XTString* res2 = xt_string_concat(res1, suffix);
            xt_release((XTValue)prefix); xt_release((XTValue)inner);
            xt_release((XTValue)suffix); xt_release((XTValue)res1);
            return res2;
        }
        case XT_TYPE_DICT: return xt_string_new("字典对象");
        case XT_TYPE_ARRAY: return xt_string_new("数组对象");
        case XT_TYPE_SOCKET: return xt_string_new("Socket连接");
        case XT_TYPE_CHANNEL: return xt_string_new("通道对象");
        default: return xt_string_new("未知对象");
    }
}

// --- 字典 (Hash Map) 实现 ---

/**
 * @brief DJB2 哈希算法实现
 */
static uint64_t xt_hash_value(XTValue val) {
    if (XT_IS_INT(val)) return (uint64_t)XT_TO_INT(val);
    if (val == XT_TRUE) return 4;
    if (val == XT_FALSE) return 2;
    if (val == XT_NULL) return 0;
    if (!xt_is_real_ptr(val)) return (uint64_t)val;

    XTObject* obj = (XTObject*)val;
    if (obj->type_id == XT_TYPE_STRING) {
        XTString* s = (XTString*)val;
        uint64_t hash = 5381;
        for (size_t i = 0; i < s->length; i++) {
            hash = ((hash << 5) + hash) + (unsigned char)s->data[i];
        }
        return hash;
    }
    return (uint64_t)val; 
}

/**
 * @brief 通用全等比较
 */
int xt_compare(XTValue a, XTValue b) {
    if (a == b) return 0;
    if (XT_IS_INT(a) && XT_IS_INT(b)) {
        int64_t ia = XT_TO_INT(a); int64_t ib = XT_TO_INT(b);
        return (ia < ib) ? -1 : 1;
    }
    if (XT_IS_REAL_PTR(a) && XT_IS_REAL_PTR(b)) {
        XTObject* oa = (XTObject*)a; XTObject* ob = (XTObject*)b;
        if (oa->type_id == XT_TYPE_STRING && ob->type_id == XT_TYPE_STRING) {
            return strcmp(((XTString*)a)->data, ((XTString*)b)->data);
        }
    }
    return (a < b) ? -1 : 1;
}

/**
 * @brief 创建字典
 */
XTValue xt_dict_new(size_t capacity) {
    if (capacity < 8) capacity = 8;
    XTDict* dict = (XTDict*)xt_malloc(sizeof(XTDict), XT_TYPE_DICT);
    dict->capacity = capacity;
    dict->size = 0;
    dict->buckets = (XTDictEntry**)calloc(capacity, sizeof(XTDictEntry*));
    return (XTValue)dict;
}

/**
 * @brief 字典插入/更新
 */
void xt_dict_set(XTValue dict_val, XTValue key, XTValue value) {
    if (!XT_IS_REAL_PTR(dict_val)) return;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT && obj->type_id != XT_TYPE_INSTANCE) return;
    XTDict* dict = (XTDict*)dict_val;
    
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq(entry->key, key)) {
            xt_release(entry->value);
            entry->value = value;
            xt_retain(value);
            return;
        }
        entry = entry->next;
    }

    XTDictEntry* new_entry = (XTDictEntry*)malloc(sizeof(XTDictEntry));
    new_entry->key = key; new_entry->value = value;
    new_entry->next = dict->buckets[idx];
    dict->buckets[idx] = new_entry;
    dict->size++;
    xt_retain(key); xt_retain(value);
}

/**
 * @brief 字典获取
 */
XTValue xt_dict_get(XTValue dict_val, XTValue key) {
    if (!XT_IS_REAL_PTR(dict_val)) return XT_NULL;
    XTObject* obj = (XTObject*)dict_val;

    // Socket/Result 方法表分发（自举编译器通过 xt_dict_get 做成员调用）
    if (obj->type_id == XT_TYPE_SOCKET) {
        if (!xt_is_real_ptr(key)) return XT_NULL;
        const char* m = ((XTString*)key)->data;
        if (strcmp(m, "读") == 0 || strcmp(m, "read") == 0) return xt_func_new((void*)xt_socket_read_method);
        if (strcmp(m, "写") == 0 || strcmp(m, "发") == 0 || strcmp(m, "write") == 0 || strcmp(m, "send") == 0) return xt_func_new((void*)xt_socket_write_method);
        if (strcmp(m, "关") == 0 || strcmp(m, "close") == 0) return xt_func_new((void*)xt_socket_close_method);
        if (strcmp(m, "转字") == 0 || strcmp(m, "toString") == 0) return xt_func_new((void*)xt_socket_tostring_method);
        return XT_NULL;
    }
    if (obj->type_id == XT_TYPE_RESULT) {
        if (!xt_is_real_ptr(key)) return XT_NULL;
        const char* m = ((XTString*)key)->data;
        if (strcmp(m, "接着") == 0 || strcmp(m, "then") == 0) return xt_func_new((void*)xt_result_then_method);
        if (strcmp(m, "否则") == 0 || strcmp(m, "else") == 0) return xt_func_new((void*)xt_result_else_method);
        return XT_NULL;
    }

    if (obj->type_id != XT_TYPE_DICT && obj->type_id != XT_TYPE_INSTANCE) return XT_NULL;
    XTDict* dict = (XTDict*)dict_val;
    if (dict->capacity == 0) return XT_NULL;
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq(entry->key, key)) return entry->value;
        entry = entry->next;
    }
    return XT_NULL;
}

size_t xt_dict_size(XTValue dict_val) {
    if (!XT_IS_REAL_PTR(dict_val)) return 0;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT && obj->type_id != XT_TYPE_INSTANCE) return 0;
    return ((XTDict*)dict_val)->size;
}

size_t xt_array_length(XTValue arr_val) {
    if (!XT_IS_REAL_PTR(arr_val)) return 0;
    XTObject* obj = (XTObject*)arr_val;
    if (obj->type_id != XT_TYPE_ARRAY) return 0;
    return ((XTArray*)arr_val)->length;
}

int xt_dict_contains(XTValue dict_val, XTValue key) {
    return xt_dict_get(dict_val, key) != XT_NULL;
}

/**
 * @brief 统一成员获取接口
 */
XTValue xt_get_member(XTValue obj_val, XTValue key_val) {
    if (!XT_IS_REAL_PTR(obj_val)) return XT_NULL;
    XTObject* obj = (XTObject*)obj_val;

    // 字典/实例类型——标准字典查找
    if (obj->type_id == XT_TYPE_DICT || obj->type_id == XT_TYPE_INSTANCE) {
        return xt_dict_get(obj_val, key_val);
    }

    // Socket 方法分发
    if (obj->type_id == XT_TYPE_SOCKET) {
        if (!xt_is_real_ptr(key_val)) return XT_NULL;
        const char* method = ((XTString*)key_val)->data;
        if (strcmp(method, "读") == 0 || strcmp(method, "read") == 0)
            return xt_func_new((void*)xt_socket_read_method);
        if (strcmp(method, "写") == 0 || strcmp(method, "发") == 0 || strcmp(method, "write") == 0 || strcmp(method, "send") == 0)
            return xt_func_new((void*)xt_socket_write_method);
        if (strcmp(method, "关") == 0 || strcmp(method, "close") == 0)
            return xt_func_new((void*)xt_socket_close_method);
        return XT_NULL;
    }

    // Result 方法分发
    if (obj->type_id == XT_TYPE_RESULT) {
        if (!xt_is_real_ptr(key_val)) return XT_NULL;
        const char* method = ((XTString*)key_val)->data;
        if (strcmp(method, "接着") == 0 || strcmp(method, "then") == 0)
            return xt_func_new((void*)xt_result_then_method);
        if (strcmp(method, "否则") == 0 || strcmp(method, "else") == 0)
            return xt_func_new((void*)xt_result_else_method);
        return XT_NULL;
    }

    return XT_NULL;
}

XTValue xt_dict_keys(XTValue dict_val) {
    if (!XT_IS_REAL_PTR(dict_val)) return XT_NULL;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT && obj->type_id != XT_TYPE_INSTANCE) return XT_NULL;
    XTDict* dict = (XTDict*)dict_val;
    XTValue arr = xt_array_new(dict->size);
    for (size_t i = 0; i < dict->capacity; i++) {
        XTDictEntry* entry = dict->buckets[i];
        while (entry) { xt_array_append(arr, entry->key); entry = entry->next; }
    }
    return arr;
}

XTValue xt_dict_values(XTValue dict_val) {
    if (!XT_IS_REAL_PTR(dict_val)) return XT_NULL;
    XTDict* dict = (XTDict*)dict_val;
    XTValue arr = xt_array_new(dict->size);
    for (size_t i = 0; i < dict->capacity; i++) {
        XTDictEntry* entry = dict->buckets[i];
        while (entry) { xt_array_append(arr, entry->value); entry = entry->next; }
    }
    return arr;
}

void xt_dict_remove(XTValue dict_val, XTValue key) {
    if (!XT_IS_REAL_PTR(dict_val)) return;
    XTDict* dict = (XTDict*)dict_val;
    uint64_t hash = xt_hash_value(key) % dict->capacity;
    XTDictEntry* entry = dict->buckets[hash];
    XTDictEntry* prev = NULL;
    while (entry) {
        if (xt_compare(entry->key, key) == 0) {
            if (prev) prev->next = entry->next; else dict->buckets[hash] = entry->next;
            xt_release(entry->key); xt_release(entry->value);
            free(entry); dict->size--; return;
        }
        prev = entry; entry = entry->next;
    }
}

int xt_eq(XTValue a, XTValue b) {
    return xt_compare(a, b) == 0;
}

// --- 文件 I/O 系统原语 ---

#ifdef _WIN32
static wchar_t* xt_utf8_to_utf16(const char* utf8_str) {
    if (!utf8_str) return NULL;
    int len = MultiByteToWideChar(CP_UTF8, 0, utf8_str, -1, NULL, 0);
    if (len <= 0) return NULL;
    wchar_t* wstr = (wchar_t*)malloc(len * sizeof(wchar_t));
    if (wstr) {
        MultiByteToWideChar(CP_UTF8, 0, utf8_str, -1, wstr, len);
    }
    return wstr;
}

static char* xt_utf16_to_utf8(const wchar_t* wstr) {
    if (!wstr) return NULL;
    int len = WideCharToMultiByte(CP_UTF8, 0, wstr, -1, NULL, 0, NULL, NULL);
    if (len <= 0) return NULL;
    char* utf8_str = (char*)malloc(len);
    if (utf8_str) {
        WideCharToMultiByte(CP_UTF8, 0, wstr, -1, utf8_str, len, NULL, NULL);
    }
    return utf8_str;
}
#endif

/**
 * @brief 文件读取
 */
XTValue xt_file_read(XTValue path_val) {
    if (!XT_IS_REAL_PTR(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTObject* obj = (XTObject*)path_val;
    if (obj->type_id != XT_TYPE_STRING) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    FILE* f = NULL;
#ifdef _WIN32
    wchar_t* wpath = xt_utf8_to_utf16(path->data);
    if (wpath) {
        f = _wfopen(wpath, L"rb");
        free(wpath);
    }
#else
    f = fopen(path->data, "rb");
#endif
    if (!f) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法打开文件"));

    if (fseek(f, 0, SEEK_END) != 0) {
        fclose(f);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法获取文件大小"));
    }
    long size = ftell(f);
    if (size < 0) {
        fclose(f);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法获取文件大小"));
    }
    rewind(f);

    char* buf = (char*)malloc(size + 1);
    if (!buf) {
        fclose(f);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("内存不足"));
    }
    size_t read = fread(buf, 1, size, f);
    fclose(f);
    buf[read] = '\0';

    XTString* content = xt_string_new_len(buf, read);
    free(buf);
    return (XTValue)xt_result_new(1, (void*)content, NULL);
}

/**
 * @brief 文件写入
 */
XTValue xt_file_write(XTValue path_val, XTValue content_val) {
    if (!xt_is_real_ptr(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTObject* obj = (XTObject*)path_val;
    if (obj->type_id != XT_TYPE_STRING) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    if (!path->data) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径数据为空"));

    XTString* content = xt_obj_to_string(content_val);
    if (!content || !content->data) {
        if (content) xt_release((XTValue)content);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("内容转换失败"));
    }

    FILE* f = NULL;
#ifdef _WIN32
    wchar_t* wpath = xt_utf8_to_utf16(path->data);
    if (wpath) {
        f = _wfopen(wpath, L"wb");
        free(wpath);
    }
#else
    f = fopen(path->data, "wb");
#endif
    if (!f) { 
        xt_release((XTValue)content); 
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法写入文件 (打开失败)")); 
    }
    fwrite(content->data, 1, content->length, f);
    fclose(f);
    xt_release((XTValue)content);
    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}

XTValue xt_file_exists(XTValue path_val) {
    if (!xt_is_real_ptr(path_val)) return XT_FALSE;
    XTObject* obj = (XTObject*)path_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_FALSE;
    XTString* path = (XTString*)path_val;
    if (!path->data) return XT_FALSE;

#ifdef _WIN32
    wchar_t* wpath = xt_utf8_to_utf16(path->data);
    if (wpath) {
        struct _stat64 st;
        int res = _wstat64(wpath, &st);
        free(wpath);
        return res == 0 ? XT_TRUE : XT_FALSE;
    }
#else
    struct stat st;
    return stat(path->data, &st) == 0 ? XT_TRUE : XT_FALSE;
#endif
    return XT_FALSE;
}

// --- 字节流 (Bytes) 实现 ---

XTValue xt_bytes_new(size_t capacity) {
    XTBytes* b = (XTBytes*)xt_malloc(sizeof(XTBytes), XT_TYPE_BYTES);
    b->data = g_current_arena ? (uint8_t*)xt_arena_alloc_raw(capacity) : (uint8_t*)malloc(capacity);
    b->length = 0; b->capacity = capacity;
    return (XTValue)b;
}

void xt_bytes_append(XTValue bytes_val, uint8_t b_val) {
    if (XT_IS_INT(bytes_val)) return;
    XTBytes* b = (XTBytes*)bytes_val;
    if (b->length >= b->capacity) {
        size_t new_capacity = b->capacity * 2;
        if (atomic_load(&b->header.ref_count) >= XT_REF_COUNT_IMMORTAL) {
            uint8_t* new_data = (uint8_t*)xt_arena_alloc_raw(new_capacity);
            memcpy(new_data, b->data, b->length); b->data = new_data;
        } else {
            b->data = realloc(b->data, new_capacity);
        }
        b->capacity = new_capacity;
    }
    b->data[b->length++] = b_val;
}

// --- 任务与通道 (v0.2: 已加互斥锁保护，对接线程池) ---

XTValue xt_task_new(XTValue result) {
    XTTask* t = (XTTask*)xt_malloc(sizeof(XTTask), XT_TYPE_TASK);
    t->result = result;
    if (result != XT_NULL) xt_retain(result);
    t->status = 1;
    t->pool_id = -1;
    return (XTValue)t;
}

XTValue xt_wait(XTValue task_val) {
    if (!xt_is_real_ptr(task_val)) return XT_NULL;
    XTTask* t = (XTTask*)task_val;
    return xt_async_wait(t);
}

// 线程池任务包装：调用 func_ptr(arg) 并返回结果
typedef struct {
    void* func_ptr;
    XTValue arg;
} async_ctx;

static void* async_runner(void* p) {
    async_ctx* ctx = (async_ctx*)p;
    typedef XTValue (*xt_func)(XTValue);
    xt_func f = (xt_func)ctx->func_ptr;
    XTValue result = f(ctx->arg);
    free(ctx);
    return (void*)result;
}

XTTask* xt_async_spawn(void* func_ptr, XTValue arg) {
    XTTask* t = (XTTask*)xt_malloc(sizeof(XTTask), XT_TYPE_TASK);
    t->result = XT_NULL;
    t->status = 0;  // 运行中
    async_ctx* ctx = (async_ctx*)malloc(sizeof(async_ctx));
    ctx->func_ptr = func_ptr;
    ctx->arg = arg;
    t->pool_id = xt_threadpool_submit(async_runner, ctx);
    return t;
}

XTValue xt_async_wait(XTTask* task) {
    if (!task || task->pool_id < 0) return task ? task->result : XT_NULL;
    void* raw = xt_threadpool_wait(task->pool_id);
    task->result = (XTValue)raw;
    task->status = 1;
    return task->result;
}

XTValue xt_channel_new(size_t capacity) {
    XTChannel* c = (XTChannel*)xt_malloc(sizeof(XTChannel), XT_TYPE_CHANNEL);
    c->buffer = (XTValue*)calloc(capacity, sizeof(XTValue));
    c->size = 0; c->capacity = capacity; c->head = 0; c->tail = 0;
    XT_CHAN_MUTEX_INIT(&c->mu);
    return (XTValue)c;
}

void xt_channel_send(XTValue chan_val, XTValue val) {
    if (XT_IS_INT(chan_val)) return;
    XTChannel* c = (XTChannel*)chan_val;
    XT_CHAN_MUTEX_LOCK(&c->mu);
    if (c->size >= c->capacity) { XT_CHAN_MUTEX_UNLOCK(&c->mu); return; }
    if (c->buffer[c->tail] != XT_NULL) {
        xt_release(c->buffer[c->tail]);
    }
    c->buffer[c->tail] = val;
    xt_retain(val);
    c->tail = (c->tail + 1) % c->capacity; c->size++;
    XT_CHAN_MUTEX_UNLOCK(&c->mu);
}

XTValue xt_channel_receive(XTValue chan_val) {
    if (XT_IS_INT(chan_val)) return XT_NULL;
    XTChannel* c = (XTChannel*)chan_val;
    XT_CHAN_MUTEX_LOCK(&c->mu);
    if (c->size == 0) { XT_CHAN_MUTEX_UNLOCK(&c->mu); return XT_NULL; }
    XTValue val = c->buffer[c->head];
    c->buffer[c->head] = XT_NULL;
    c->head = (c->head + 1) % c->capacity; c->size--;
    XT_CHAN_MUTEX_UNLOCK(&c->mu);
    return val;
}

// --- 系统原语与网络模拟 ---

XTValue xt_http_request(XTValue url_val) {
    if (!xt_is_real_ptr(url_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("URL无效"));
    XTString* url = (XTString*)url_val;
    void* result = xt_net_http_get(url->data);
    // xt_net_http_get 返回 char*：成功时是响应体，失败时是错误信息
    // 用简单启发式判断：以 "不支持的" 或 "无法" 或 "HTTP" 开头的是错误
    const char* resp = (const char*)result;
    if (!resp) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("请求失败"));
    if (strncmp(resp, "不支持", 9) == 0 || strncmp(resp, "无法", 6) == 0 || strncmp(resp, "HTTP", 4) == 0 || strncmp(resp, "发送", 6) == 0) {
        XTString* err = xt_string_new(resp);
        free(result);
        return (XTValue)xt_result_new(0, NULL, (void*)err);
    }
    XTString* body = xt_string_new(resp);
    free(result);
    return (XTValue)xt_result_new(1, (void*)body, NULL);
}

XTValue xt_listen(XTValue port_val, XTValue callback_val) {
    int64_t port = xt_to_int(port_val);
    // 从 XTFunction 中提取函数指针
    if (!xt_is_real_ptr(callback_val)) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("回调函数无效"));
    }
    typedef XTValue (*xt_cb)(XTValue);
    xt_cb cb = (xt_cb)((XTFunction*)callback_val)->func_ptr;
    int rc = xt_net_listen((int)port, (void (*)(void*))cb);
    if (rc < 0) {
        char err[64];
        snprintf(err, sizeof(err), "监听端口 %d 失败", (int)port);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err));
    }
    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}

XTValue xt_connect(XTValue addr_val) {
    if (!xt_is_real_ptr(addr_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("地址无效"));
    XTString* addr = (XTString*)addr_val;

    // 解析 host:port
    char host[256] = {0};
    int port = 80;
    const char* colon = strchr(addr->data, ':');
    if (colon) {
        size_t hlen = (size_t)(colon - addr->data);
        if (hlen >= sizeof(host)) hlen = sizeof(host) - 1;
        memcpy(host, addr->data, hlen);
        port = atoi(colon + 1);
    } else {
        size_t len = strlen(addr->data);
        if (len >= sizeof(host)) len = sizeof(host) - 1;
        memcpy(host, addr->data, len);
    }
    if (port <= 0) port = 80;

    void* sock = xt_net_connect(host, port);
    if (!sock) {
        char err[256];
        snprintf(err, sizeof(err), "无法连接到 %s", addr->data);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err));
    }
    return (XTValue)xt_result_new(1, sock, NULL);
}

XTValue xt_get_temp_path() {
#ifdef _WIN32
    wchar_t wpath[MAX_PATH];
    if (GetTempPathW(MAX_PATH, wpath) > 0) {
        char* path = xt_utf16_to_utf8(wpath);
        if (path) {
            // 移除末尾的反斜杠，保持与玄铁风格一致
            size_t len = strlen(path);
            if (len > 0 && (path[len-1] == '\\' || path[len-1] == '/')) {
                path[len-1] = '\0';
            }
            XTString* s = xt_string_new(path);
            free(path);
            return (XTValue)s;
        }
    }
    return (XTValue)xt_string_new("C:\\temp");
#else
    const char* tmp = getenv("TMPDIR");
    if (!tmp) tmp = "/tmp";
    return (XTValue)xt_string_new(tmp);
#endif
}

/**
 * @brief 系统指令执行 (利用 .bat 脚本解决 Windows 引号剥离问题)
 */
XTValue xt_execute(XTValue cmd_val) {
    if (!XT_IS_REAL_PTR(cmd_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("指令无效"));
    XTObject* obj = (XTObject*)cmd_val;
    if (obj->type_id != XT_TYPE_STRING) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("指令无效"));
    XTString* cmd = (XTString*)cmd_val;

#ifdef _WIN32
    // Windows 下 _wpopen 存在严重的引号剥离 (Quote Stripping) 问题
    // 解决方案：将指令写入临时 .bat 文件执行
    char temp_path[MAX_PATH];
    char bat_path[MAX_PATH];
    DWORD dwRet = GetTempPathA(MAX_PATH, temp_path);
    if (dwRet == 0 || dwRet > MAX_PATH) {
        char err_msg[128];
        snprintf(err_msg, sizeof(err_msg), "获取临时路径失败, Error: %lu", GetLastError());
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err_msg));
    }
    
    // 创建 XuanTie 临时目录
    if (strlen(temp_path) + 10 >= MAX_PATH) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("临时路径过长"));
    }
    strcat(temp_path, "XuanTie");
    if (!CreateDirectoryA(temp_path, NULL) && GetLastError() != ERROR_ALREADY_EXISTS) {
        char err_msg[256];
        snprintf(err_msg, sizeof(err_msg), "创建临时目录失败, Path: %s, Error: %lu", temp_path, GetLastError());
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err_msg));
    }

    // P2: 使用 PID + TickCount 消除命名碰撞
    if (snprintf(bat_path, MAX_PATH, "%s\\xt_exec_%lu_%llu.bat", 
            temp_path, 
            GetCurrentProcessId(), 
            (unsigned long long)GetTickCount64()) >= MAX_PATH) {
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("临时批处理路径过长"));
    }
    
    FILE* fbat = NULL;
#ifdef _WIN32
    wchar_t* wbat_path_init = xt_utf8_to_utf16(bat_path);
    if (wbat_path_init) {
        fbat = _wfopen(wbat_path_init, L"w");
        free(wbat_path_init);
    }
#else
    fbat = fopen(bat_path, "w");
#endif

    if (!fbat) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("创建临时批处理失败"));
    
    // 写入指令并确保获取正确的退出码，同时将 stderr 重定向到 stdout 以便捕获错误信息
    fprintf(fbat, "@echo off\n%s 2>&1\nexit /b %%ERRORLEVEL%%\n", cmd->data);
    fclose(fbat);

    // P0: 扩充缓冲区并增加长度校验报错
    wchar_t wcmd[1024]; 
    wchar_t* wbat = xt_utf8_to_utf16(bat_path);
    if (!wbat) {
        remove(bat_path);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径转换失败"));
    }

    int required = _snwprintf(wcmd, 1024, L"\"\"%ls\"\"", wbat);
    free(wbat);

    if (required < 0 || required >= 1024) {
        remove(bat_path);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("执行指令路径过长，超出了运行时缓冲区限制"));
    }

    FILE* pipe = _wpopen(wcmd, L"r");
    if (!pipe) {
        remove(bat_path);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("执行管道打开失败"));
    }

    char buffer[1024]; // 增大缓冲区
    XTString* res = xt_string_new("");
    while (fgets(buffer, sizeof(buffer), pipe) != NULL) {
        XTString* temp = res;
        XTString* buf_str = xt_string_new(buffer);
        res = xt_string_concat(res, buf_str);
        xt_release((XTValue)temp);
        xt_release((XTValue)buf_str);
    }

    int status = _pclose(pipe);
    
    // 如果执行失败，尝试通过 remove 清理临时文件，若 remove 也失败则可能是文件锁导致挂起
    if (remove(bat_path) != 0) {
        // 记录日志或忽略
    }

    if (status != 0 && status != -1) {
        char err_msg[1024];
        snprintf(err_msg, sizeof(err_msg), "执行失败 (退出码: %d). 输出: %s", status, res->data);
        xt_release((XTValue)res);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err_msg));
    }
    return (XTValue)xt_result_new(1, (void*)res, NULL);

#else
    // Linux/Unix 下 popen 表现相对稳定，同样重定向 stderr
    char cmd_with_stderr[2048];
    snprintf(cmd_with_stderr, sizeof(cmd_with_stderr), "%s 2>&1", cmd->data);
    FILE* pipe = popen(cmd_with_stderr, "r");
    if (!pipe) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("执行失败"));
    
    char buffer[1024];
    XTString* res = xt_string_new("");
    while (fgets(buffer, sizeof(buffer), pipe) != NULL) {
        XTString* temp = res;
        XTString* buf_str = xt_string_new(buffer);
        res = xt_string_concat(res, buf_str);
        xt_release((XTValue)temp);
        xt_release((XTValue)buf_str);
    }
    int status = pclose(pipe);
    if (status != 0) {
        xt_release((XTValue)res);
        char err_msg[128];
        sprintf(err_msg, "执行失败，状态码: %d", status);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new(err_msg));
    }
    return (XTValue)xt_result_new(1, (void*)res, NULL);
#endif
}

/**
 * @brief 标准输入读取
 */
XTValue xt_input(XTValue prompt_val) {
    if (XT_IS_REAL_PTR(prompt_val)) {
        XTString* prompt = (XTString*)prompt_val;
        printf("%s", prompt->data);
    }
    char buf[1024];
    if (fgets(buf, sizeof(buf), stdin)) {
        size_t len = strlen(buf);
        if (len > 0 && buf[len-1] == '\n') buf[len-1] = '\0';
        return (XTValue)xt_string_new(buf);
    }
    return (XTValue)xt_string_new("");
}

static double xt_to_double(XTValue val);

XTValue xt_math_random(XTValue max_val) {
    int64_t max = xt_to_int(max_val);
    if (max <= 0) max = 100;
    return XT_FROM_INT(rand() % max);
}

XTValue xt_math_abs(XTValue n_val) {
    if (XT_IS_INT(n_val)) {
        int64_t v = XT_TO_INT(n_val);
        // INT64_MIN 的绝对值无法用 int64_t 表示，钳位到 INT64_MAX
        if (v == INT64_MIN) return XT_FROM_INT(INT64_MAX);
        return XT_FROM_INT(v < 0 ? -v : v);
    }
    double d = xt_to_double(n_val);
    return (XTValue)xt_float_new(fabs(d));
}

XTValue xt_math_sin(XTValue n_val) {
    return (XTValue)xt_float_new(sin(xt_to_double(n_val)));
}

XTValue xt_math_cos(XTValue n_val) {
    return (XTValue)xt_float_new(cos(xt_to_double(n_val)));
}

XTValue xt_math_sqrt(XTValue n_val) {
    return (XTValue)xt_float_new(sqrt(xt_to_double(n_val)));
}

XTValue xt_math_floor(XTValue n_val) {
    return XT_FROM_INT((int64_t)floor(xt_to_double(n_val)));
}

XTValue xt_math_ceil(XTValue n_val) {
    return XT_FROM_INT((int64_t)ceil(xt_to_double(n_val)));
}

XTValue xt_math_round(XTValue n_val) {
    return XT_FROM_INT((int64_t)round(xt_to_double(n_val)));
}

XTValue xt_math_pow(XTValue base_val, XTValue exp_val) {
    return (XTValue)xt_float_new(pow(xt_to_double(base_val), xt_to_double(exp_val)));
}

XTValue xt_math_srand(XTValue seed_val) {
    srand((unsigned int)xt_to_int(seed_val));
    return XT_NULL;
}

XTValue xt_math_max(XTValue arr_val) {
    if (!XT_IS_REAL_PTR(arr_val) || ((XTObject*)arr_val)->type_id != XT_TYPE_ARRAY) return XT_FROM_INT(0);
    XTArray* arr = (XTArray*)arr_val;
    if (arr->length == 0) return XT_FROM_INT(0);
    
    XTValue max_val = (XTValue)arr->elements[0];
    double max_d = xt_to_double(max_val);
    
    for (size_t i = 1; i < arr->length; i++) {
        XTValue cur = (XTValue)arr->elements[i];
        double cur_d = xt_to_double(cur);
        if (cur_d > max_d) {
            max_d = cur_d;
            max_val = cur;
        }
    }
    xt_retain(max_val);
    return max_val;
}

XTValue xt_math_min(XTValue arr_val) {
    if (!XT_IS_REAL_PTR(arr_val) || ((XTObject*)arr_val)->type_id != XT_TYPE_ARRAY) return XT_FROM_INT(0);
    XTArray* arr = (XTArray*)arr_val;
    if (arr->length == 0) return XT_FROM_INT(0);
    
    XTValue min_val = (XTValue)arr->elements[0];
    double min_d = xt_to_double(min_val);
    
    for (size_t i = 1; i < arr->length; i++) {
        XTValue cur = (XTValue)arr->elements[i];
        double cur_d = xt_to_double(cur);
        if (cur_d < min_d) {
            min_d = cur_d;
            min_val = cur;
        }
    }
    xt_retain(min_val);
    return min_val;
}

XTValue xt_math_pi() {
    return (XTValue)xt_float_new(3.14159265358979323846);
}

XTValue xt_math_e() {
    return (XTValue)xt_float_new(2.71828182845904523536);
}

static double xt_to_double(XTValue val) {
    if (XT_IS_INT(val)) return (double)XT_TO_INT(val);
    if (val == XT_TRUE) return 1.0;
    if (val == XT_FALSE) return 0.0;
    if (XT_IS_REAL_PTR(val)) {
        XTObject* obj = (XTObject*)val;
        if (obj->type_id == XT_TYPE_FLOAT) {
            return ((struct { XTObject h; double v; }*)val)->v;
        }
        if (obj->type_id == XT_TYPE_INT) {
            return (double)((XTInt*)val)->value;
        }
    }
    return 0.0;
}

XTValue xt_time_now() {
    return XT_FROM_INT((int64_t)time(NULL));
}

/**
 * @brief 高精度毫秒计时
 */
XTValue xt_time_ms() {
#ifdef _WIN32
    static int initialized = 0;
    static LARGE_INTEGER frequency;
    if (!initialized) { QueryPerformanceFrequency(&frequency); initialized = 1; }
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    return XT_FROM_INT((int64_t)(counter.QuadPart * 1000 / frequency.QuadPart));
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return XT_FROM_INT((int64_t)(ts.tv_sec * 1000 + ts.tv_nsec / 1000000));
#endif
}

/**
 * @brief 高精度微秒计时 (亚微秒级显示)
 */
XTValue xt_time_micro() {
#ifdef _WIN32
    static int initialized = 0;
    static LARGE_INTEGER frequency;
    if (!initialized) { QueryPerformanceFrequency(&frequency); initialized = 1; }
    LARGE_INTEGER counter;
    QueryPerformanceCounter(&counter);
    // 使用微秒计算，并防止溢出
    return XT_FROM_INT((int64_t)(counter.QuadPart * 1000000 / frequency.QuadPart));
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return XT_FROM_INT((int64_t)(ts.tv_sec * 1000000 + ts.tv_nsec / 1000));
#endif
}

XTValue xt_time_sleep(XTValue ms_val) {
    int64_t ms = xt_to_int(ms_val);
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    usleep(ms * 1000);
#endif
    return XT_NULL;
}

/**
 * @brief 字符串分割 (利用 strtok_s 实现)
 */
XTValue xt_string_split(XTValue str_val, XTValue sep_val) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_NULL;
    XTString* s = (XTString*)str_val; 
    XTString* sep = (XTString*)sep_val;
    XTValue arr = xt_array_new(4);
    
    if (sep && sep->length == 0) {
        // 如果分隔符为空字符串，则按逻辑字符拆分
        int64_t char_count = XT_TO_INT(xt_string_char_count(str_val));
        for (int64_t i = 0; i < char_count; i++) {
            XTValue c = xt_string_get_char(str_val, i);
            xt_array_append(arr, c);
            xt_release(c);
        }
        return arr;
    }

    char* data = xt_strdup(s->data);
    char* token; char* rest = data;
    while ((token = strtok_s(rest, sep ? sep->data : "", &rest))) {
        XTValue s_new = (XTValue)xt_string_new(token);
        xt_array_append(arr, s_new);
        xt_release(s_new);
    }
    free(data); return arr;
}

/**
 * @brief 字符串简单替换 (目前仅支持首个匹配项)
 */
XTValue xt_string_replace(XTValue str_val, XTValue old_val, XTValue new_val) {
    if (!XT_IS_REAL_PTR(str_val)) return XT_NULL;
    XTString* s = (XTString*)str_val; XTString* old_s = (XTString*)old_val; XTString* new_s = (XTString*)new_val;
    char* pos = strstr(s->data, old_s->data);
    if (!pos) { xt_retain(str_val); return str_val; }
    size_t prefix_len = pos - s->data;
    size_t suffix_len = s->length - prefix_len - old_s->length;
    size_t total_len = prefix_len + new_s->length + suffix_len;
    char* buf = (char*)malloc(total_len + 1);
    memcpy(buf, s->data, prefix_len);
    memcpy(buf + prefix_len, new_s->data, new_s->length);
    memcpy(buf + prefix_len + new_s->length, pos + old_s->length, suffix_len);
    buf[total_len] = '\0';
    XTString* res = xt_string_new(buf);
    free(buf); return (XTValue)res;
}

/**
 * @brief JSON 序列化 (递归实现)
 */
XTString* xt_json_serialize(XTValue val) {
    if (XT_IS_INT(val)) return xt_int_to_string(XT_TO_INT(val));
    if (val == XT_TRUE) return xt_string_new("true");
    if (val == XT_FALSE) return xt_string_new("false");
    if (val == XT_NULL) return xt_string_new("null");
    if (!XT_IS_REAL_PTR(val)) return xt_string_new("\"illegal\"");

    XTObject* header = (XTObject*)val;
    switch (header->type_id) {
        case XT_TYPE_STRING: {
            XTString* s = (XTString*)val;
            // 计算转义后大小：最坏情况每个字符都需要转义为 \uXXXX (6 bytes)
            size_t esc_max = s->length * 6 + 3;
            char* buf = malloc(esc_max);
            if (!buf) return xt_string_new("\"\"");
            size_t w = 0;
            buf[w++] = '"';
            for (size_t i = 0; i < s->length; i++) {
                char c = s->data[i];
                switch (c) {
                    case '"':  buf[w++] = '\\'; buf[w++] = '"'; break;
                    case '\\': buf[w++] = '\\'; buf[w++] = '\\'; break;
                    case '\n': buf[w++] = '\\'; buf[w++] = 'n'; break;
                    case '\r': buf[w++] = '\\'; buf[w++] = 'r'; break;
                    case '\t': buf[w++] = '\\'; buf[w++] = 't'; break;
                    case '\b': buf[w++] = '\\'; buf[w++] = 'b'; break;
                    case '\f': buf[w++] = '\\'; buf[w++] = 'f'; break;
                    default:
                        if ((unsigned char)c < 0x20) {
                            w += sprintf(buf + w, "\\u%04x", (unsigned char)c);
                        } else {
                            buf[w++] = c;
                        }
                        break;
                }
            }
            buf[w++] = '"';
            buf[w] = '\0';
            XTString* res = xt_string_new_len(buf, w);
            free(buf); return res;
        }
        case XT_TYPE_ARRAY: {
            XTArray* arr = (XTArray*)val;
            XTString* res = xt_string_new("[");
            for (size_t i = 0; i < arr->length; i++) {
                XTString* item = xt_json_serialize((XTValue)arr->elements[i]);
                XTString* temp = xt_string_concat(res, item);
                xt_release((XTValue)res); xt_release((XTValue)item); res = temp;
                if (i < arr->length - 1) {
                    temp = xt_string_concat(res, xt_string_new(", "));
                    xt_release((XTValue)res); res = temp;
                }
            }
            XTString* suffix = xt_string_new("]");
            XTString* final_res = xt_string_concat(res, suffix);
            xt_release((XTValue)res); xt_release((XTValue)suffix); return final_res;
        }
        case XT_TYPE_DICT: {
            XTDict* dict = (XTDict*)val;
            XTString* res = xt_string_new("{");
            int first = 1;
            for (size_t i = 0; i < dict->capacity; i++) {
                XTDictEntry* entry = dict->buckets[i];
                while (entry) {
                    if (!first) {
                        XTString* comma = xt_string_new(", ");
                        XTString* temp = xt_string_concat(res, comma);
                        xt_release((XTValue)res); xt_release((XTValue)comma); res = temp;
                    }
                    XTString* key = xt_json_serialize(entry->key);
                    XTString* colon = xt_string_new(": ");
                    XTString* val_str = xt_json_serialize(entry->value);
                    XTString* temp1 = xt_string_concat(res, key);
                    XTString* temp2 = xt_string_concat(temp1, colon);
                    XTString* temp3 = xt_string_concat(temp2, val_str);
                    xt_release((XTValue)res); xt_release((XTValue)key); xt_release((XTValue)colon);
                    xt_release((XTValue)val_str); xt_release((XTValue)temp1); xt_release((XTValue)temp2);
                    res = temp3; first = 0; entry = entry->next;
                }
            }
            XTString* suffix = xt_string_new("}");
            XTString* final_res = xt_string_concat(res, suffix);
            xt_release((XTValue)res); xt_release((XTValue)suffix); return final_res;
        }
        default: return xt_string_new("\"object\"");
    }
}

/**
 * @brief 简化版 JSON 反序列化 (演示用)
 */
XTValue xt_json_deserialize(XTString* json_str) {
    if (!json_str || json_str->length == 0) return XT_NULL;
    char* data = json_str->data;
    if (strcmp(data, "true") == 0) return XT_TRUE;
    if (strcmp(data, "false") == 0) return XT_FALSE;
    if (strcmp(data, "null") == 0) return XT_NULL;
    if (data[0] >= '0' && data[0] <= '9') return XT_FROM_INT(atoll(data));
    if (data[0] == '"') {
        size_t len = strlen(data);
        if (len < 2 || data[len - 1] != '"') {
            return (XTValue)xt_string_new(data); // 未闭合的字符串，原样返回
        }
        char* inner = xt_strdup(data + 1);
        inner[len - 2] = '\0'; // 安全：len>=2 保证 len-2>=0
        XTValue res = (XTValue)xt_string_new(inner);
        free(inner); return res;
    }
    return XT_NULL;
}

// --- 通用算术与位运算 Fallback ---

XTValue xt_add(XTValue a, XTValue b) {
    if (XT_IS_INT(a) && XT_IS_INT(b)) return XT_FROM_INT(XT_TO_INT(a) + XT_TO_INT(b));
    return XT_FROM_INT(xt_to_int(a) + xt_to_int(b));
}

XTValue xt_sub(XTValue a, XTValue b) {
    if (XT_IS_INT(a) && XT_IS_INT(b)) return XT_FROM_INT(XT_TO_INT(a) - XT_TO_INT(b));
    return XT_FROM_INT(xt_to_int(a) - xt_to_int(b));
}

XTValue xt_mul(XTValue a, XTValue b) {
    if (XT_IS_INT(a) && XT_IS_INT(b)) return XT_FROM_INT(XT_TO_INT(a) * XT_TO_INT(b));
    return XT_FROM_INT(xt_to_int(a) * xt_to_int(b));
}

XTValue xt_div(XTValue a, XTValue b) {
    int64_t vb = xt_to_int(b);
    if (vb == 0) return XT_FROM_INT(0);
    return XT_FROM_INT(xt_to_int(a) / vb);
}

XTValue xt_mod(XTValue a, XTValue b) {
    int64_t vb = xt_to_int(b);
    if (vb == 0) return XT_FROM_INT(0);
    return XT_FROM_INT(xt_to_int(a) % vb);
}

XTValue xt_bit_and(XTValue a, XTValue b) {
    return XT_FROM_INT(xt_to_int(a) & xt_to_int(b));
}

XTValue xt_bit_or(XTValue a, XTValue b) {
    return XT_FROM_INT(xt_to_int(a) | xt_to_int(b));
}

XTValue xt_bit_xor(XTValue a, XTValue b) {
    return XT_FROM_INT(xt_to_int(a) ^ xt_to_int(b));
}

XTValue xt_bit_shl(XTValue a, XTValue b) {
    return XT_FROM_INT(xt_to_int(a) << xt_to_int(b));
}

XTValue xt_bit_shr(XTValue a, XTValue b) {
    return XT_FROM_INT(xt_to_int(a) >> xt_to_int(b));
}