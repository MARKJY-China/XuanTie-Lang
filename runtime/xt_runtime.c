#include "xt_runtime.h"

/**
 * @file xt_runtime.c
 * @brief 玄铁编程语言 (XuanTie) 运行时环境实现
 * 
 * 实现了对象的创建、销毁、类型转换、集合操作（数组与字典）、
 * 字符串处理以及基础的文件 I/O 功能。
 */

// 前置声明
static void print_pool_stats();

// Arena 区域分配器实现
typedef struct XTArena {
    char* buffer;
    size_t size;
    size_t offset;
    struct XTArena* next;
} XTArena;

static XTArena* g_current_arena = NULL;
XTArena* xt_arena_new(size_t size);
void* xt_arena_alloc_raw(size_t size);
void* xt_arena_alloc(size_t size, uint32_t type_id);

/**
 * @brief 初始化运行时
 * 
 * 在 Windows 平台下设置控制台输出编码为 UTF-8 以支持中文字符显示。
 */
void xt_init() {
#ifdef _WIN32
    SetConsoleOutputCP(65001); // 设置为 UTF-8
#endif
    // atexit(print_pool_stats); // 如果需要调试内存池，可以解开注释
}

static void print_pool_stats() {
    // printf("[XT Memory Pool Stats] Alloc from pool: %d, Free to pool: %d, Fallback malloc: %d\n", 
    //        pool_alloc_count, pool_free_count, malloc_fallback_count);
}

/**
 * @brief 打印内存池统计信息 (目前仅作为占位符)
 */
void xt_print_pool_stats() {
    printf("--- Memory Pool Stats ---\n");
    // printf("Pool Allocations: %d\n", pool_alloc_count);
    // printf("Pool Frees:       %d\n", pool_free_count);
    // printf("Malloc Fallbacks: %d\n", malloc_fallback_count);
    printf("-------------------------\n");
}

// 调试开关
#define XT_DEBUG_MODE 0
#if XT_DEBUG_MODE
#define XT_DEBUG_PRINT(...) do { printf("DEBUG: " __VA_ARGS__); fflush(stdout); } while(0)
#else
#define XT_DEBUG_PRINT(...)
#endif

/**
 * @brief 打印 64 位整数
 */
void xt_print_int(int64_t val) {
    printf("%lld\n", val);
}

/**
 * @brief 创建整数 XTValue
 * 
 * 利用标记指针技术，直接在指针值中存储 63 位整数。
 */
XTValue xt_int_new(int64_t val) {
    return XT_FROM_INT(val);
}

/**
 * @brief 创建浮点数对象
 * 
 * 浮点数需要堆分配。
 */
void* xt_float_new(double val) {
    typedef struct { XTObject header; double value; } XTFloat;
    XTFloat* obj = (XTFloat*)xt_malloc(sizeof(XTFloat), XT_TYPE_FLOAT);
    obj->value = val;
    return (void*)obj;
}

/**
 * @brief 创建布尔值 XTValue
 * 
 * 返回预定义的布尔常量。
 */
XTValue xt_bool_new(int val) {
    return XT_FROM_BOOL(val);
}

/**
 * @brief 创建指定长度的字符串对象
 * 
 * @param data 原始字节数据
 * @param len 字节长度
 * @return XTString* 新分配的字符串对象
 */
XTString* xt_string_new_len(const char* data, size_t len) {
    XTString* s = (XTString*)xt_malloc(sizeof(XTString), XT_TYPE_STRING);
    s->length = len;
    
    if (g_current_arena) {
        // 在 Arena 中分配数据空间，避免大量小 malloc 导致碎片化或 OOM
        s->data = (char*)xt_arena_alloc_raw(len + 1);
    } else {
        s->data = (char*)malloc(len + 1);
    }
    
    if (s->data) {
        memcpy(s->data, data, len);
        s->data[len] = '\0';
    }
    return s;
}

/**
 * @brief 从 C 字符串创建 XTString
 */
XTString* xt_string_new(const char* data) {
    if (!data) data = "";
    return xt_string_new_len(data, strlen(data));
}

/**
 * @brief 从单个字节字符创建 XTString
 */
XTString* xt_string_from_char(char c) {
    char buf[2] = {c, '\0'};
    return xt_string_new(buf);
}

/**
 * @brief 获取 UTF-8 字符串中指定位置的字符
 * 
 * 考虑到 UTF-8 是变长编码，本函数通过遍历字节流来定位第 index 个字符。
 * @param str_val 目标字符串
 * @param index 字符索引 (从 0 开始)
 * @return XTValue 返回包含该字符的新字符串，若索引越界返回 XT_NULL
 */
XTValue xt_string_get_char(XTValue str_val, int64_t index) {
    if (!XT_IS_PTR(str_val) || str_val == XT_NULL) return XT_NULL;
    XTObject* obj = (XTObject*)str_val;
    if (obj->type_id != XT_TYPE_STRING) return XT_NULL;
    
    XTString* s = (XTString*)str_val;
    if (index < 0) return XT_NULL;
    
    const char* p = s->data;
    int64_t current = 0;
    // 遍历 UTF-8 序列
    while (*p && current < index) {
        unsigned char c = (unsigned char)*p;
        if (c < 0x80) p += 1;
        else if ((c & 0xE0) == 0xC0) p += 2;
        else if ((c & 0xF0) == 0xE0) p += 3;
        else if ((c & 0xF8) == 0xF0) p += 4;
        else p += 1; // 容错处理非法序列
        current++;
    }
    
    if (!*p) return XT_NULL;
    
    // 提取当前字符的字节长度
    int len = 0;
    unsigned char c = (unsigned char)*p;
    if (c < 0x80) len = 1;
    else if ((c & 0xE0) == 0xC0) len = 2;
    else if ((c & 0xF0) == 0xE0) len = 3;
    else if ((c & 0xF8) == 0xF0) len = 4;
    else len = 1;
    
    char buf[5] = {0};
    for (int i = 0; i < len && p[i]; i++) {
        buf[i] = p[i];
    }
    
    return (XTValue)xt_string_new(buf);
}

/**
 * @brief 用于遍历的下一个字符获取函数
 * 
 * @param s 字符串对象
 * @param offset 字节偏移量指针，调用后会自动更新
 * @return XTString* 下一个 UTF-8 字符组成的字符串
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
 * @brief 打印字符串对象
 */
void xt_print_string(XTString* str) {
    if (!str) {
        printf("空\n");
        return;
    }
    printf("%s\n", str->data);
}

/**
 * @brief 打印布尔值
 */
void xt_print_bool(int val) {
    printf("%s\n", val ? "真" : "假");
}

/**
 * @brief 打印浮点数
 */
void xt_print_float(double val) {
    printf("%g\n", val);
}

// --- 内存管理与内存池相关 ---

/**
 * @brief 初始化一个新的 Arena
 */
XTArena* xt_arena_new(size_t size) {
    XTArena* arena = (XTArena*)malloc(sizeof(XTArena));
    if (!arena) return NULL;
    arena->buffer = (char*)calloc(1, size);
    if (!arena->buffer) { free(arena); return NULL; }
    arena->size = size;
    arena->offset = 0;
    arena->next = NULL;
    return arena;
}

/**
 * @brief 在 Arena 中分配原始内存 (不带对象头)
 */
void* xt_arena_alloc_raw(size_t size) {
    if (!g_current_arena) return malloc(size);
    
    // 对齐到 8 字节
    size = (size + 7) & ~7;
    
    if (g_current_arena->offset + size > g_current_arena->size) {
        size_t next_size = (size > 1024 * 1024) ? size : 1024 * 1024;
        XTArena* next = xt_arena_new(next_size);
        if (!next) { fprintf(stderr, "Fatal error: out of memory (Arena raw expand)\n"); exit(1); }
        next->next = g_current_arena;
        g_current_arena = next;
    }
    
    void* ptr = g_current_arena->buffer + g_current_arena->offset;
    g_current_arena->offset += size;
    return ptr;
}

/**
 * @brief 在 Arena 中分配对象内存 (带对象头)
 */
void* xt_arena_alloc(size_t size, uint32_t type_id) {
    void* ptr = xt_arena_alloc_raw(size);
    
    // 初始化对象头
    XTObject* obj = (XTObject*)ptr;
    atomic_init(&obj->ref_count, 1000000); 
    obj->type_id = type_id;
    
    return ptr;
}

/**
 * @brief 切换当前全局 Arena
 */
XTValue xt_arena_use(XTArena* arena) {
    g_current_arena = arena;
    return XT_NULL;
}

/**
 * @brief 销毁 Arena 链表并释放所有内存
 */
XTValue xt_arena_destroy(XTArena* arena) {
    XTArena* curr = arena;
    while (curr) {
        XTArena* next = curr->next;
        free(curr->buffer);
        free(curr);
        curr = next;
    }
    if (g_current_arena == arena) g_current_arena = NULL;
    return XT_NULL;
}

// 简单的空闲链表内存池配置 (目前主要作为扩展预留)
#define POOL_MAX_SIZE 128
#define POOL_SLOT_COUNT 8

typedef struct XTPoolNode {
    struct XTPoolNode* next;
} XTPoolNode;

// static XTPoolNode* xt_memory_pools[POOL_SLOT_COUNT] = {NULL};

/**
 * @brief 统一内存分配接口
 * 
 * 为所有玄铁对象分配堆空间，并初始化对象头 (引用计数设为 1)。
 */
void* xt_malloc(size_t size, uint32_t type_id) {
    if (g_current_arena) {
        return xt_arena_alloc(size, type_id);
    }
    XTObject* obj = (XTObject*)malloc(size);
    if (!obj) {
        fprintf(stderr, "Fatal error: out of memory (xt_malloc)\n");
        exit(1);
    }
    atomic_init(&obj->ref_count, 1);
    obj->type_id = type_id;
    return (void*)obj;
}

/**
 * @brief 释放对象占用的内存
 * 
 * 根据对象类型递归释放其持有的子对象引用。
 */
static void xt_free_obj(XTObject* obj) {
    if (!obj) return;
    
    switch (obj->type_id) {
        case XT_TYPE_STRING: {
            XTString* s = (XTString*)obj;
            if (s->data) free(s->data);
            break;
        }
        case XT_TYPE_ARRAY: {
            XTArray* arr = (XTArray*)obj;
            for (size_t i = 0; i < arr->length; i++) {
                xt_release((XTValue)arr->elements[i]);
            }
            if (arr->elements) free(arr->elements);
            break;
        }
        case XT_TYPE_DICT: {
            XTDict* dict = (XTDict*)obj;
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
            for (size_t i = 0; i < inst->field_count; i++) {
                xt_release(inst->fields[i]);
            }
            if (inst->fields) free(inst->fields);
            break;
        }
        case XT_TYPE_RESULT: {
            XTResult* res = (XTResult*)obj;
            if (res->value) xt_release((XTValue)res->value);
            if (res->error) xt_release((XTValue)res->error);
            break;
        }
        case XT_TYPE_FUNCTION:
            // 函数对象目前没有额外的堆成员需要释放
            break;
        default:
            // 未知类型或基础类型
            break;
    }
    
    free(obj);
}

/**
 * @brief 判断一个 XTValue 是否为真实的内存指针
 * 
 * 除了检查最低位标记外，还排除了空值、布尔常量以及过小的非法地址（防止未对齐或误用的整数）。
 */
static int xt_is_real_ptr(XTValue val) {
    // 排除标记整数 (LSB=1)
    if (XT_IS_INT(val)) return 0;
    // 排除特殊常量 (0, 2, 4) 以及过小的地址范围 (通常为非法地址)
    // 真实的堆地址在现代操作系统上通常远大于 0x1000
    if (val <= 4096) return 0;
    return 1;
}

/**
 * @brief 增加对象引用计数 (临时禁用)
 * 
 * 开启 ARC 后在处理大规模自举编译器逻辑时可能触发堆损坏 (Status Heap Corruption)，
 * 疑为 Go 编译器生成的 ARC 指令序列与 C 运行时递归释放逻辑在处理复杂循环引用时存在冲突。
 * 目前维持空实现以确保自举编译器功能正常。
 */
void xt_retain(XTValue val) {
    /*
    if (xt_is_real_ptr(val)) {
        XTObject* obj = (XTObject*)val;
        atomic_fetch_add_explicit(&obj->ref_count, 1, memory_order_relaxed);
    }
    */
}

/**
 * @brief 减少对象引用计数并在必要时释放 (临时禁用)
 */
void xt_release(XTValue val) {
    /*
    if (xt_is_real_ptr(val)) {
        XTObject* obj = (XTObject*)val;
        uint32_t old_ref = atomic_fetch_sub(&obj->ref_count, 1);
        if (old_ref == 1) {
            xt_free_obj(obj); 
        } else if (old_ref == 0) {
            atomic_store(&obj->ref_count, 0);
        }
    }
    */
}

/**
 * @brief 将任意值转换为 C 整数
 * 
 * 如果是标记整数直接提取；如果是布尔值返回 1/0；如果是装箱整数对象提取其值。
 */
int64_t xt_to_int(XTValue val) {
    if (XT_IS_INT(val)) return XT_TO_INT(val);
    if (val == XT_TRUE) return 1;
    if (val == XT_FALSE) return 0;
    if (XT_IS_PTR(val) && val != XT_NULL) {
        XTObject* header = (XTObject*)val;
        if (header->type_id == XT_TYPE_INT) {
            return ((XTInt*)val)->value;
        }
    }
    return 0;
}

// --- 数组 (Array) 实现 ---

/**
 * @brief 创建空数组
 */
XTValue xt_array_new(size_t capacity) {
    XTArray* arr = (XTArray*)xt_malloc(sizeof(XTArray), XT_TYPE_ARRAY);
    arr->length = 0;
    arr->capacity = capacity > 0 ? capacity : 4; // 至少分配 4 个空间
    
    if (g_current_arena) {
        arr->elements = (void**)xt_arena_alloc_raw(sizeof(void*) * arr->capacity);
    } else {
        arr->elements = (void**)malloc(sizeof(void*) * arr->capacity);
    }
    return (XTValue)arr;
}

/**
 * @brief 向数组追加元素，支持动态扩容
 */
void xt_array_append(XTValue arr_val, XTValue element) {
    if (!XT_IS_PTR(arr_val) || arr_val == XT_NULL) {
        XT_DEBUG_PRINT("xt_array_append failed: not a pointer or NULL\n");
        return;
    }
    XTObject* header = (XTObject*)arr_val;
    if (header->type_id != XT_TYPE_ARRAY) {
        XT_DEBUG_PRINT("xt_array_append failed: not an array (type %u)\n", header->type_id);
        return;
    }
    XTArray* arr = (XTArray*)arr_val;
    
    // 检查扩容
    if (arr->length >= arr->capacity) {
        size_t new_capacity = arr->capacity == 0 ? 4 : arr->capacity * 2;
        void** new_elements;
        if (g_current_arena) {
            new_elements = (void**)xt_arena_alloc_raw(sizeof(void*) * new_capacity);
            if (arr->elements) {
                memcpy(new_elements, arr->elements, sizeof(void*) * arr->length);
            }
        } else {
            new_elements = (void**)realloc(arr->elements, sizeof(void*) * new_capacity);
        }
        if (!new_elements) return;
        arr->elements = new_elements;
        arr->capacity = new_capacity;
    }
    xt_retain(element);
    arr->elements[arr->length++] = (void*)element;
    XT_DEBUG_PRINT("xt_array_append success, new length: %zu\n", arr->length);
}

/**
 * @brief 获取数组元素
 */
XTValue xt_array_get(XTValue arr_val, XTValue index_val) {
    if (!XT_IS_PTR(arr_val) || arr_val == XT_NULL) return XT_NULL;
    XTArray* arr = (XTArray*)arr_val;
    if (arr->header.type_id != XT_TYPE_ARRAY) return XT_NULL;
    
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index >= arr->length) return XT_NULL;
    
    return (XTValue)arr->elements[index];
}

/**
 * @brief 弹出并返回数组最后一个元素
 */
XTValue xt_array_pop(XTArray* arr) {
    if (!arr || arr->header.type_id != XT_TYPE_ARRAY || arr->length == 0) return XT_NULL;
    XTValue val = (XTValue)arr->elements[--arr->length];
    return val;
}

/**
 * @brief 修改数组指定索引处的元素
 */
void xt_array_set(XTValue arr_val, XTValue index_val, XTValue value) {
    if (!XT_IS_PTR(arr_val) || arr_val == XT_NULL) return;
    XTArray* arr = (XTArray*)arr_val;
    if (arr->header.type_id != XT_TYPE_ARRAY) return;
    
    int64_t index = xt_to_int(index_val);
    if (index < 0 || (size_t)index >= arr->length) return;
    
    xt_release((XTValue)arr->elements[index]);
    arr->elements[index] = (void*)value;
    xt_retain(value);
}

// --- 实例与函数 ---

/**
 * @brief 创建类实例对象
 */
XTInstance* xt_instance_new(void* class_ptr, size_t field_count) {
    XTInstance* inst = (XTInstance*)xt_malloc(sizeof(XTInstance), XT_TYPE_INSTANCE);
    inst->class_ptr = class_ptr;
    inst->field_count = field_count;
    inst->fields = (XTValue*)malloc(sizeof(XTValue) * field_count);
    memset(inst->fields, 0, sizeof(XTValue) * field_count);
    return inst;
}

/**
 * @brief 创建结果容器对象
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
 * @brief 创建函数对象
 */
XTValue xt_func_new(void* func_ptr) {
    XTFunction* obj = (XTFunction*)xt_malloc(sizeof(XTFunction), XT_TYPE_FUNCTION);
    obj->func_ptr = func_ptr;
    return (XTValue)obj;
}

// --- 字符串高级操作 ---

/**
 * @brief 截取子字符串
 */
XTString* xt_string_substring(XTString* s, int64_t start, int64_t end) {
    if (!s) return xt_string_new("");
    
    const char* p = s->data;
    int64_t current = 0;
    const char* start_p = NULL;
    const char* end_p = NULL;
    
    // 定位 UTF-8 起始和结束位置
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
 * @brief 将数组元素连接为字符串
 */
XTString* xt_array_join(XTArray* arr, XTString* sep) {
    if (!arr) return xt_string_new("");
    if (arr->length == 0) return xt_string_new("");
    
    // 1. 计算总长度
    size_t total_len = 0;
    size_t sep_len = sep ? sep->length : 0;
    
    for (size_t i = 0; i < arr->length; i++) {
        XTString* s = xt_obj_to_string((XTValue)arr->elements[i]);
        total_len += s->length;
        if (i < arr->length - 1) total_len += sep_len;
        xt_release((XTValue)s);
    }
    
    // 2. 拼接
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

/**
 * @brief 检查字符串是否包含子串
 */
int xt_string_contains(XTString* s, XTString* sub) {
    if (!s || !sub) return 0;
    return strstr(s->data, sub->data) != NULL;
}

/**
 * @brief 连接两个字符串
 */
XTString* xt_string_concat(XTString* s1, XTString* s2) {
    if (!s1 && !s2) return xt_string_new("");
    if (!s1) { xt_retain((XTValue)s2); return s2; }
    if (!s2) { xt_retain((XTValue)s1); return s1; }
    size_t len = s1->length + s2->length;
    char* data = (char*)malloc(len + 1);
    memcpy(data, s1->data, s1->length);
    memcpy(data + s1->length, s2->data, s2->length);
    data[len] = '\0';
    XTString* res = xt_string_new_len(data, len);
    free(data);
    return res;
}

/**
 * @brief 通用打印函数
 * 
 * 根据值的类型标识自动选择打印格式。
 */
void xt_print_value(XTValue val) {
    if (XT_IS_INT(val)) {
        printf("%lld\n", XT_TO_INT(val));
    } else if (val == XT_TRUE) {
        printf("真\n");
    } else if (val == XT_FALSE) {
        printf("假\n");
    } else if (val == XT_NULL) {
        printf("空\n");
    } else if (xt_is_real_ptr(val)) {
        XTObject* obj = (XTObject*)val;
        switch (obj->type_id) {
            case XT_TYPE_STRING:
                xt_print_string((XTString*)val);
                break;
            case XT_TYPE_FLOAT:
                xt_print_float(((struct { XTObject h; double v; }*)val)->v);
                break;
            case XT_TYPE_ARRAY:
                printf("数组(%zu)\n", ((XTArray*)val)->length);
                break;
            case XT_TYPE_DICT:
                printf("字典(%zu)\n", ((XTDict*)val)->size);
                break;
            case XT_TYPE_RESULT: {
                XTString* s = xt_obj_to_string(val);
                printf("%s\n", s->data);
                xt_release((XTValue)s);
                break;
            }
            default:
                printf("实例对象\n");
        }
    }
}

/**
 * @brief 整数转字符串
 */
XTString* xt_int_to_string(int64_t val) {
    char buf[32];
    sprintf(buf, "%lld", val);
    return xt_string_new(buf);
}

/**
 * @brief 浮点数转字符串
 */
XTString* xt_float_to_string(double val) {
    char buf[64];
    sprintf(buf, "%g", val);
    return xt_string_new(buf);
}

/**
 * @brief 通用值转字符串接口 (用于插值等场景)
 */
XTString* xt_obj_to_string(XTValue val) {
    if (XT_IS_INT(val)) {
        return xt_int_to_string(XT_TO_INT(val));
    }
    if (val == XT_TRUE) return xt_string_new("真");
    if (val == XT_FALSE) return xt_string_new("假");
    if (val == XT_NULL) return xt_string_new("空");

    if (!xt_is_real_ptr(val)) return xt_string_new("非法");

    XTObject* header = (XTObject*)val;
    switch (header->type_id) {
        case XT_TYPE_INT: // 兼容旧的装箱整数对象
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
            xt_release((XTValue)prefix);
            xt_release((XTValue)inner);
            xt_release((XTValue)suffix);
            xt_release((XTValue)res1);
            return res2;
        }
        case XT_TYPE_DICT:
            return xt_string_new("字典对象");
        case XT_TYPE_ARRAY:
            return xt_string_new("数组对象");
        default:
            return xt_string_new("未知对象");
    }
}

// --- 字典 (Hash Map) 实现 ---

/**
 * @brief 为 XTValue 计算哈希值
 */
static uint64_t xt_hash_value(XTValue val) {
    if (XT_IS_INT(val)) return (uint64_t)XT_TO_INT(val);
    if (val == XT_TRUE) return 4;
    if (val == XT_FALSE) return 2;
    if (val == XT_NULL) return 0;

    if (!xt_is_real_ptr(val)) return (uint64_t)val;

    XTObject* obj = (XTObject*)val;
    if (obj->type_id == XT_TYPE_STRING) {
        // DJB2 哈希算法
        XTString* s = (XTString*)val;
        uint64_t hash = 5381;
        for (size_t i = 0; i < s->length; i++) {
            hash = ((hash << 5) + hash) + (unsigned char)s->data[i];
        }
        return hash;
    }
    return (uint64_t)val; // 默认使用内存地址作为哈希
}

/**
 * @brief 通用比较函数
 * 
 * 返回: 0(相等), -1(a < b), 1(a > b)
 */
int xt_compare(XTValue a, XTValue b) {
    if (a == b) return 0;
    if (XT_IS_INT(a) && XT_IS_INT(b)) {
        int64_t ia = XT_TO_INT(a);
        int64_t ib = XT_TO_INT(b);
        return (ia < ib) ? -1 : 1;
    }
    
    if (XT_IS_PTR(a) && XT_IS_PTR(b) && a != XT_NULL && b != XT_NULL) {
        XTObject* oa = (XTObject*)a;
        XTObject* ob = (XTObject*)b;
        if (oa->type_id == XT_TYPE_STRING && ob->type_id == XT_TYPE_STRING) {
            XTString* sa = (XTString*)a;
            XTString* sb = (XTString*)b;
            return strcmp(sa->data, sb->data);
        }
    }
    return (a < b) ? -1 : 1;
}

/**
 * @brief 创建空字典
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
 * @brief 设置字典键值对
 */
void xt_dict_set(XTValue dict_val, XTValue key, XTValue value) {
    if (!XT_IS_PTR(dict_val) || dict_val == XT_NULL) return;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT) return;
    XTDict* dict = (XTDict*)dict_val;
    
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    // 查找是否存在现有键
    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq((void*)entry->key, (void*)key)) {
            xt_release(entry->value);
            entry->value = value;
            xt_retain(value);
            return;
        }
        entry = entry->next;
    }

    // 插入新节点 (头插法)
    XTDictEntry* new_entry = (XTDictEntry*)malloc(sizeof(XTDictEntry));
    new_entry->key = key;
    new_entry->value = value;
    new_entry->next = dict->buckets[idx];
    dict->buckets[idx] = new_entry;
    dict->size++;
    xt_retain(key);
    xt_retain(value);
}

/**
 * @brief 获取字典中的值
 */
XTValue xt_dict_get(XTValue dict_val, XTValue key) {
    if (!XT_IS_PTR(dict_val) || dict_val == XT_NULL) return XT_NULL;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT) return XT_NULL;
    XTDict* dict = (XTDict*)dict_val;
    
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq((void*)entry->key, (void*)key)) {
            return entry->value;
        }
        entry = entry->next;
    }
    return XT_NULL;
}

/**
 * @brief 获取字典当前的键值对数量
 */
size_t xt_dict_size(XTValue dict_val) {
    if (!XT_IS_PTR(dict_val) || dict_val == XT_NULL) return 0;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT) return 0;
    XTDict* dict = (XTDict*)dict_val;
    return dict->size;
}

/**
 * @brief 检查字典是否包含某个键
 */
int xt_dict_contains(XTValue dict_val, XTValue key) {
    if (!XT_IS_PTR(dict_val) || dict_val == XT_NULL) return 0;
    XTObject* obj = (XTObject*)dict_val;
    if (obj->type_id != XT_TYPE_DICT) return 0;
    XTDict* dict = (XTDict*)dict_val;
    
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_eq((void*)entry->key, (void*)key)) {
            return 1;
        }
        entry = entry->next;
    }
    return 0;
}

/**
 * @brief 成员访问底层接口
 * 
 * 统一处理字典访问和类实例成员访问。
 */
XTValue xt_get_member(XTValue obj_val, XTValue key_val) {
    if (!XT_IS_PTR(obj_val) || obj_val == XT_NULL) return XT_NULL;
    XTObject* obj = (XTObject*)obj_val;
    if (obj->type_id == XT_TYPE_DICT) {
        return xt_dict_get(obj_val, key_val);
    }
    if (obj->type_id == XT_TYPE_INSTANCE) {
        // XTInstance* inst = (XTInstance*)obj_val;
        // 实例成员查找逻辑暂略，目前统一用字典模拟
        return XT_NULL;
    }
    return XT_NULL;
}

/**
 * @brief 获取字典所有键组成的数组
 */
XTArray* xt_dict_keys(XTDict* dict) {
    if (!dict || dict->header.type_id != XT_TYPE_DICT) return NULL;
    XTArray* arr = (XTArray*)xt_array_new(dict->size);
    for (size_t i = 0; i < dict->capacity; i++) {
        XTDictEntry* entry = dict->buckets[i];
        while (entry) {
            xt_array_append((XTValue)arr, entry->key);
            entry = entry->next;
        }
    }
    return arr;
}

/**
 * @brief 比较两个对象是否相等
 */
int xt_eq(void* a, void* b) {
    return xt_compare((XTValue)a, (XTValue)b) == 0;
}

// --- 文件 I/O 实现 ---

/**
 * @brief 读取文件全部内容
 * 
 * @param path_val 文件路径 (XTString)
 * @return XTValue 返回 Result 对象，包含读取到的字符串或错误信息
 */
XTValue xt_file_read(XTValue path_val) {
    if (XT_IS_INT(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    
    FILE* f;
#ifdef _WIN32
    fopen_s(&f, path->data, "rb");
#else
    f = fopen(path->data, "rb");
#endif
    if (!f) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法打开文件"));

    // 获取文件大小
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);

    char* buf = (char*)malloc(size + 1);
    fread(buf, 1, size, f);
    buf[size] = '\0';
    fclose(f);

    XTString* content = xt_string_new(buf);
    free(buf);
    return (XTValue)xt_result_new(1, (void*)content, NULL);
}

/**
 * @brief 写入内容到文件
 * 
 * @param path_val 文件路径 (XTString)
 * @param content_val 要写入的内容 (XTValue，会自动转字符串)
 * @return XTValue 返回 Result 对象，包含布尔真或错误信息
 */
XTValue xt_file_write(XTValue path_val, XTValue content_val) {
    if (XT_IS_INT(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    XTString* content = xt_obj_to_string(content_val);

    FILE* f;
#ifdef _WIN32
    fopen_s(&f, path->data, "wb");
#else
    f = fopen(path->data, "wb");
#endif
    if (!f) {
        xt_release((XTValue)content);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法写入文件"));
    }

    fwrite(content->data, 1, content->length, f);
    fclose(f);
    xt_release((XTValue)content);

    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}
