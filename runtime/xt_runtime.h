#ifndef XT_RUNTIME_H
#define XT_RUNTIME_H

#ifdef _WIN32
#define _WIN32_WINNT 0x0600
#endif

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

#ifdef _WIN32
#include <windows.h>
#endif

/**
 * @file xt_runtime.h
 * @brief 玄铁编程语言 (XuanTie) 运行时环境头文件
 * 
 * 本文件定义了玄铁语言在 C 语言层面的运行时基础结构、值表示方法以及核心 API。
 * 运行时采用标记指针 (Tagged Pointer) 技术来高效表示不同类型的值。
 */

/**
 * @brief 玄铁基础对象头
 * 
 * 所有堆分配的对象 (如字符串、数组、字典等) 必须以该结构体作为起始成员。
 * 包含引用计数用于内存管理，以及类型 ID 用于运行时类型识别。
 */
typedef struct {
    uint32_t magic;             ///< 魔数，用于检测堆损坏 (0x58544F42 'XTOB')
    _Atomic uint32_t ref_count; ///< 引用计数 (原子操作)
    uint32_t type_id;           ///< 类型标识符 (XT_TYPE_*)
} XTObject;

#define XT_MAGIC 0x58544F42

/**
 * @brief 统一值类型 (标记指针)
 * 
 * XTValue 是玄铁语言中所有变量的底层表示类型。
 * 
 * 标记规则:
 * - 最低位 (LSB) 为 1: 表示 63 位带符号整数。
 * - 最低位 (LSB) 为 0: 表示真实内存指针或特殊的常量 (如空值、布尔值)。
 */
typedef uintptr_t XTValue;

// 标记位与掩码定义
#define XT_TAG_INT      0x1ULL
#define XT_TAG_MASK     0x1ULL

// 宏定义：类型识别与转换
#define XT_IS_INT(v)    (((v) & XT_TAG_MASK) == XT_TAG_INT)
#define XT_IS_PTR(v)    (!XT_IS_INT(v))

// 真实堆指针检测——排除 XT_FALSE(0x2)、XT_TRUE(0x4)、XT_NULL(0x0) 等小常量
// 这些小值 LSB=0 被 XT_IS_PTR 误判为指针，解引用会造成段错误
// 现代 OS 上合法堆地址始终 > 4096 (0x1000)
#define XT_IS_REAL_PTR(v)  (!XT_IS_INT(v) && (v) > 4096)

/// 将 C 整数转换为标记后的 XTValue
#define XT_FROM_INT(i)  (((XTValue)(i) << 1) | XT_TAG_INT)
/// 从标记后的 XTValue 提取原始整数
#define XT_TO_INT(v)    ((int64_t)((intptr_t)(v) >> 1))

/**
 * @brief 特殊常量定义 (均为偶数地址，LSB=0)
 * 
 * 通过高位特定位模式与普通指针区分 (目前简单使用固定小数值)。
 */
#define XT_NULL         ((XTValue)0x0ULL) ///< 空值 (null)
#define XT_FALSE        ((XTValue)0x2ULL) ///< 布尔假 (false)
#define XT_TRUE         ((XTValue)0x4ULL) ///< 布尔真 (true)

#define XT_IS_BOOL(v)   ((v) == XT_TRUE || (v) == XT_FALSE)
#define XT_TO_BOOL(v)   ((v) == XT_TRUE)
#define XT_FROM_BOOL(b) ((b) ? XT_TRUE : XT_FALSE)

/**
 * @brief 类型 ID 常量
 */
#define XT_TYPE_INT       1 ///< 整数 (装箱形式，通常使用标记指针代替)
#define XT_TYPE_FLOAT     2 ///< 浮点数
#define XT_TYPE_STRING    3 ///< 字符串
#define XT_TYPE_BOOL      4 ///< 布尔值
#define XT_TYPE_ARRAY     5 ///< 数组 (列表)
#define XT_TYPE_DICT      6 ///< 字典 (映射)
#define XT_TYPE_INSTANCE  7 ///< 类实例
#define XT_TYPE_RESULT    8 ///< 结果容器 (Result)
#define XT_TYPE_FUNCTION  9 ///< 函数对象
#define XT_TYPE_BYTES     10 ///< 字节流 (Bytes)
#define XT_TYPE_TASK      11 ///< 异步任务 (Task)
#define XT_TYPE_CHANNEL   12 ///< 并发通道 (Channel)
#define XT_TYPE_ARENA     13 ///< 区域分配器 (Arena)
#define XT_TYPE_SOCKET    14 ///< 网络 socket

// 内存管理常量
#define XT_REF_COUNT_IMMORTAL 0x7FFFFFFF ///< Arena 对象的引用计数，防止被释放

// --- 弱引用支持 ---
typedef struct XTWeakSlot {
    void* obj;                  ///< 被弱引用的对象 (XTObject*)
    XTValue* slot_addr;         ///< alloca 槽位（局部变量方式，可为 NULL）
    XTValue dict_val;           ///< 字典/实例值（字典方式，可为 XT_NULL）
    XTValue dict_key;           ///< 字典键（字典方式）
    struct XTWeakSlot* next;    ///< 链表指针
} XTWeakSlot;

/// 注册弱引用槽位：当 obj 被释放时 *slot_addr 将被置为 XT_NULL(0)
void xt_weak_init(XTValue* slot_addr, XTValue obj_val);
/// 字典弱引用赋值：不 retain 值，不 release 旧值（弱引用语义）
void xt_dict_set_weak(XTValue dict_val, XTValue key, XTValue value);
/// 注册字典弱引用槽位：当 obj 被释放时 dict[key] 将被置为 XT_NULL
void xt_dict_weak_init(XTValue dict_val, XTValue key, XTValue obj_val);

/**
 * @brief 函数对象结构
 */
typedef struct {
    XTObject header;
    void* func_ptr; ///< 底层 C 函数指针
    void* env;      ///< 闭包捕获环境
} XTFunction;

/**
 * @brief 字节流结构
 */
typedef struct {
    XTObject header;
    uint8_t* data;
    size_t length;
    size_t capacity;
} XTBytes;

/**
 * @brief 异步任务结构
 */
typedef struct {
    XTObject header;
    XTValue result;
    int status;   // 0: 运行中, 1: 已完成, 2: 失败
    int pool_id;  // 线程池任务 ID，-1 表示未提交
} XTTask;

// 异步任务 API (v0.2: 对接线程池)
XTTask* xt_async_spawn(void* func_ptr, XTValue arg);
XTValue xt_async_wait(XTTask* task);

/**
 * @brief 通道结构 (简单环形队列，v0.2 已加锁)
 */
#if defined(_WIN32)
#include <windows.h>
typedef CRITICAL_SECTION xt_chan_mutex_t;
#define XT_CHAN_MUTEX_INIT(m)   InitializeCriticalSection(m)
#define XT_CHAN_MUTEX_DESTROY(m) DeleteCriticalSection(m)
#define XT_CHAN_MUTEX_LOCK(m)    EnterCriticalSection(m)
#define XT_CHAN_MUTEX_UNLOCK(m)  LeaveCriticalSection(m)
#else
#include <pthread.h>
typedef pthread_mutex_t xt_chan_mutex_t;
#define XT_CHAN_MUTEX_INIT(m)   pthread_mutex_init(m, NULL)
#define XT_CHAN_MUTEX_DESTROY(m) pthread_mutex_destroy(m)
#define XT_CHAN_MUTEX_LOCK(m)    pthread_mutex_lock(m)
#define XT_CHAN_MUTEX_UNLOCK(m)  pthread_mutex_unlock(m)
#endif

typedef struct {
    XTObject header;
    XTValue* buffer;
    size_t size;
    size_t capacity;
    size_t head;
    size_t tail;
    xt_chan_mutex_t mu;   // 线程安全：保护所有字段
} XTChannel;

/**
 * @brief 网络 Socket 对象 (v0.2)
 */
typedef struct XTSocket {
    XTObject header;
    void* sock;       // 平台 socket 句柄 (SOCKET/int)
    int is_closed;    // 是否已关闭
    int is_listener;  // 是否为监听 socket
} XTSocket;

/**
 * @brief 装箱整数结构 (较少直接使用，优先使用标记指针)
 */
typedef struct {
    XTObject header;
    int64_t value;
} XTInt;

/**
 * @brief 字符串结构
 */
typedef struct {
    XTObject header;
    char* data;           ///< 字符数组 (UTF-8)
    size_t length;        ///< 字符串字节长度
    uint8_t data_in_arena; ///< 标志位：data 是否由 Arena 分配 (不可 free)
} XTString;

/**
 * @brief 动态数组结构
 */
typedef struct {
    XTObject header;
    void** elements;          ///< 元素数组 (存储 XTValue)
    size_t length;            ///< 当前元素个数
    size_t capacity;          ///< 数组容量
    uint8_t elements_in_arena; ///< 标志位：elements 是否由 Arena 分配 (不可 free/realloc)
} XTArray;

/**
 * @brief 字典条目结构 (哈希链表节点)
 */
typedef struct XTDictEntry {
    XTValue key;
    XTValue value;
    struct XTDictEntry* next;
} XTDictEntry;

/**
 * @brief 字典结构 (基于哈希表)
 */
typedef struct {
    XTObject header;
    XTDictEntry** buckets; ///< 哈希桶数组
    size_t size;           ///< 键值对总数
    size_t capacity;       ///< 桶的数量
} XTDict;

/**
 * @brief 类实例结构 (与 XTDict 内存兼容以便支持动态属性)
 */
typedef struct {
    XTObject header;
    XTDictEntry** buckets; ///< 哈希桶 (兼容 XTDict)
    size_t size;           ///< 属性数量 (兼容 XTDict)
    size_t capacity;       ///< 桶容量 (兼容 XTDict)
    void* class_ptr;       ///< 指向类元数据的指针
} XTInstance;

/**
 * @brief 结果容器结构 (用于错误处理)
 */
typedef struct {
    XTObject header;
    int32_t is_success; ///< 是否成功 (1-成功, 0-失败)
    int32_t padding;    ///< 64位对齐填充
    void* value;        ///< 成功时的返回值
    void* error;        ///< 失败时的错误信息
} XTResult;

// --- 运行时核心接口 ---

/// 初始化运行时环境 (如设置控制台编码)
void xt_init();

/// 初始化并获取命令行参数
void xt_init_args(int argc, char** argv);
XTValue xt_get_args();

/// 打印各种类型的值到标准输出
void xt_print_int(int64_t val);
void xt_print_string(XTString* str);
void xt_print_bool(int val);
void xt_print_float(double val);
void xt_print_value(XTValue val); 

// --- 对象创建与管理 ---

/// 创建一个新的整数 (标记指针)
XTValue xt_int_new(int64_t val);
/// 创建一个新的浮点数对象
void* xt_float_new(double val);
/// 创建一个新的布尔值 (常量)
XTValue xt_bool_new(int val);
/// 创建一个函数对象
XTValue xt_func_new(void* func_ptr);

/// 从 C 字符串创建 XT 字符串
XTString* xt_string_new(const char* data);
/// 创建指定长度的字符串
XTString* xt_string_new_len(const char* data, size_t len);
/// 从单个字符创建 XT 字符串
XTString* xt_string_from_char(char c);
XTValue xt_string_get_char(XTValue str_val, int64_t index);
XTValue xt_string_get_byte(XTValue str_val, int64_t byte_index);
XTValue xt_string_byte_length(XTValue str_val);
XTValue xt_string_char_count(XTValue str_val);
XTValue xt_string_to_hex_string(XTValue str_val);
XTString* xt_string_next_char(XTString* s, int64_t* offset);

/// 创建指定容量的空数组
XTValue xt_array_new(size_t capacity);
/// 向数组末尾追加元素
void xt_array_append(XTValue arr_val, XTValue element);
void xt_array_set(XTValue arr_val, XTValue index_val, XTValue value);
void xt_array_remove(XTValue arr_val, XTValue index_val);
void xt_array_insert(XTValue arr_val, XTValue index_val, XTValue value);
XTValue xt_array_contains(XTValue arr_val, XTValue element);
XTValue xt_array_find(XTValue arr_val, XTValue element);
XTString* xt_array_join(XTValue arr_val, XTString* sep);
XTValue xt_array_slice(XTValue arr_val, XTValue start_val);
XTValue xt_array_range(XTValue start_val, XTValue end_val);

/// 创建指定容量的空字典
XTValue xt_dict_new(size_t capacity);
/// 设置字典中的键值对
void xt_dict_set(XTValue dict_val, XTValue key, XTValue value);
/// 获取字典中键对应的值
XTValue xt_dict_get(XTValue dict_val, XTValue key);
/// 检查字典是否包含特定键
int xt_dict_contains(XTValue dict_val, XTValue key);
void xt_dict_remove(XTValue dict_val, XTValue key);
XTValue xt_dict_keys(XTValue dict_val);
XTValue xt_dict_values(XTValue dict_val);
size_t xt_dict_size(XTValue dict_val);
size_t xt_array_length(XTValue arr_val);

/// 比较两个 XTValue 的大小/相等性
int xt_compare(XTValue a, XTValue b);

/// 创建新的 Result 对象
void* xt_result_new(int is_success, void* value, void* error);

/// 基础堆内存分配，带对象头初始化
void* xt_malloc(size_t size, uint32_t type_id);

// --- 内存管理 (引用计数) ---

/// 增加对象的引用计数
void xt_retain(XTValue val);
/// 减少对象的引用计数，若为 0 则释放
void xt_release(XTValue val);

// Arena 分配器
typedef struct XTArena XTArena;
XTArena* xt_arena_new(size_t size);
void* xt_arena_alloc(size_t size, uint32_t type_id);
XTValue xt_arena_use(XTArena* arena);
XTValue xt_arena_destroy(XTArena* arena);
XTArena* xt_arena_disable(void);
void xt_arena_restore(XTArena* arena);
void xt_retain_forever(XTValue val);

// --- 类型转换与操作 ---

/// 将任意 XTValue 转换为 64 位整数表示
int64_t xt_to_int(XTValue val);
/// 显式转换为整数对象或标记指针
XTValue xt_convert_to_int(XTValue val);
/// 显式转换为浮点数对象
XTValue xt_convert_to_float(XTValue val);
/// 显式转换为字符串对象
XTValue xt_convert_to_string(XTValue val);

/// 连接两个字符串，返回新字符串
XTString* xt_string_concat(XTString* s1, XTString* s2);
/// 截取子字符串
XTString* xt_string_substring(XTString* s, int64_t start, int64_t end);
/// 检查字符串是否包含子串
int xt_string_contains(XTString* s, XTString* sub);
XTValue xt_string_split(XTValue str_val, XTValue sep_val);
XTValue xt_string_replace(XTValue str_val, XTValue old_val, XTValue new_val);
/// 将整数转换为字符串
XTString* xt_int_to_string(int64_t val);
/// 将任意对象转换为其字符串表示 (用于打印/插值)
XTString* xt_obj_to_string(XTValue val);

// --- 字节流操作 ---
XTValue xt_bytes_new(size_t capacity);
void xt_bytes_append(XTValue bytes, uint8_t b);

// --- 异步任务 ---
XTValue xt_task_new(XTValue result);
XTValue xt_wait(XTValue task_val);

// --- 通道操作 ---
XTValue xt_channel_new(size_t capacity);
void xt_channel_send(XTValue chan_val, XTValue val);
XTValue xt_channel_receive(XTValue chan_val);

// --- Socket 操作（由 xt_net.c 实现）---
struct XTSocket;
void xt_net_close_obj(struct XTSocket* s);

// ---/// 核心网络与系统原语 (v0.16.4+) ---
XTValue xt_http_request(XTValue url_val);
XTValue xt_listen(XTValue port_val, XTValue callback_val);
XTValue xt_connect(XTValue addr_val);
XTValue xt_execute(XTValue cmd_val);
XTValue xt_input(XTValue prompt_val);
XTValue xt_get_temp_path();

// --- JSON 支持 ---

/// 将对象序列化为 JSON 字符串
XTString* xt_json_serialize(XTValue val);
/// 将 JSON 字符串反序列化为玄铁对象
XTValue xt_json_deserialize(XTString* json_str);

// --- 文件 I/O 接口 ---

/// 读取文件内容，返回 Result 包装的字符串
XTValue xt_file_read(XTValue path);
/// 写入内容到文件，返回 Result 包装的布尔值
XTValue xt_file_write(XTValue path, XTValue content);
XTValue xt_file_exists(XTValue path);

// --- 算术与位运算接口 (用于 Fallback/多态/重载支持) ---
XTValue xt_add(XTValue a, XTValue b);
XTValue xt_sub(XTValue a, XTValue b);
XTValue xt_mul(XTValue a, XTValue b);
XTValue xt_div(XTValue a, XTValue b);
XTValue xt_mod(XTValue a, XTValue b);
XTValue xt_bit_and(XTValue a, XTValue b);
XTValue xt_bit_or(XTValue a, XTValue b);
XTValue xt_bit_xor(XTValue a, XTValue b);
XTValue xt_bit_shl(XTValue a, XTValue b);
XTValue xt_bit_shr(XTValue a, XTValue b);

/// 检查两个对象是否相等
int xt_eq(XTValue a, XTValue b);

#endif
