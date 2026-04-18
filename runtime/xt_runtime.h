#ifndef XT_RUNTIME_H
#define XT_RUNTIME_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdatomic.h>

#ifdef _WIN32
#include <windows.h>
#endif

// 玄铁基础对象头
typedef struct {
    _Atomic uint32_t ref_count;
    uint32_t type_id;
} XTObject;

// 统一值类型 (标记指针)
// 奇数 (LSB=1) 表示 63位带符号整数
// 偶数 (LSB=0) 表示 真实指针或特殊常量
typedef uintptr_t XTValue;

#define XT_TAG_INT      0x1ULL
#define XT_TAG_MASK     0x1ULL

#define XT_IS_INT(v)    (((v) & XT_TAG_MASK) == XT_TAG_INT)
#define XT_IS_PTR(v)    (!XT_IS_INT(v))

#define XT_FROM_INT(i)  (((XTValue)(i) << 1) | XT_TAG_INT)
#define XT_TO_INT(v)    ((int64_t)((intptr_t)(v) >> 1))

// 特殊常量 (偶数，LSB=0，高位区分)
#define XT_NULL         ((XTValue)0x0ULL)
#define XT_FALSE        ((XTValue)0x2ULL)
#define XT_TRUE         ((XTValue)0x4ULL)

#define XT_IS_BOOL(v)   ((v) == XT_TRUE || (v) == XT_FALSE)
#define XT_TO_BOOL(v)   ((v) == XT_TRUE)
#define XT_FROM_BOOL(b) ((b) ? XT_TRUE : XT_FALSE)

// 类型 ID 定义
#define XT_TYPE_INT    1
#define XT_TYPE_FLOAT  2
#define XT_TYPE_STRING 3
#define XT_TYPE_BOOL   4
#define XT_TYPE_ARRAY  5
#define XT_TYPE_DICT   6
#define XT_TYPE_INSTANCE 7
#define XT_TYPE_RESULT   8
#define XT_TYPE_FUNCTION 9

typedef struct {
    XTObject header;
    void* func_ptr;
} XTFunction;

typedef struct {
    XTObject header;
    int64_t value;
} XTInt;

typedef struct {
    XTObject header;
    char* data;
    size_t length;
} XTString;

typedef struct {
    XTObject header;
    void** elements;
    size_t length;
    size_t capacity;
} XTArray;

typedef struct XTDictEntry {
    XTValue key;
    XTValue value;
    struct XTDictEntry* next;
} XTDictEntry;

typedef struct {
    XTObject header;
    XTDictEntry** buckets;
    size_t size;
    size_t capacity;
} XTDict;

typedef struct {
    XTObject header;
    void* class_ptr;
    XTValue* fields;
    size_t field_count;
} XTInstance;

typedef struct {
    XTObject header;
    int is_success;
    void* value;
    void* error;
} XTResult;

// 运行时接口
void xt_init();
void xt_print_int(int64_t val);
void xt_print_string(XTString* str);
void xt_print_bool(int val);
void xt_print_float(double val);
void xt_print_value(XTValue val); // 新增：通用打印

XTValue xt_int_new(int64_t val);    // 返回 XTValue
void* xt_float_new(double val);
XTValue xt_bool_new(int val);      // 返回 XTValue
XTValue xt_func_new(void* func_ptr);
XTString* xt_string_new(const char* data);
XTString* xt_string_from_char(char c);
XTValue xt_string_get_char(XTValue str_val, int64_t index);
XTArray* xt_array_new(size_t capacity);
void xt_array_append(XTArray* arr, XTValue element);
XTString* xt_array_join(XTArray* arr, XTString* sep);
XTDict* xt_dict_new(size_t capacity);
void xt_dict_set(XTDict* dict, XTValue key, XTValue value);
XTValue xt_dict_get(XTDict* dict, XTValue key);
void* xt_malloc(size_t size, uint32_t type_id);

void xt_retain(XTValue val);       // 参数改为 XTValue
void xt_release(XTValue val);      // 参数改为 XTValue

int64_t xt_to_int(XTValue val);    // 参数改为 XTValue
XTString* xt_string_concat(XTString* s1, XTString* s2);
XTString* xt_string_substring(XTString* s, int64_t start, int64_t end);
int xt_string_contains(XTString* s, XTString* sub);
XTString* xt_int_to_string(int64_t val);
XTString* xt_obj_to_string(XTValue val); // 参数改为 XTValue

// 文件 I/O
XTValue xt_file_read(XTValue path);
XTValue xt_file_write(XTValue path, XTValue content);

// 运算接口
void* xt_add(void* a, void* b);
void* xt_sub(void* a, void* b);
void* xt_mul(void* a, void* b);
void* xt_div(void* a, void* b);
int xt_eq(void* a, void* b);

#endif
