#ifndef XT_RUNTIME_H
#define XT_RUNTIME_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <windows.h>
#endif

// 玄铁基础对象头
typedef struct {
    uint32_t ref_count;
    uint32_t type_id;
} XTObject;

// 类型 ID 定义
#define XT_TYPE_INT    1
#define XT_TYPE_FLOAT  2
#define XT_TYPE_STRING 3
#define XT_TYPE_BOOL   4
#define XT_TYPE_ARRAY  5
#define XT_TYPE_DICT   6
#define XT_TYPE_INSTANCE 7

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

typedef struct {
    XTObject header;
    void* class_ptr;
    void** fields;
} XTInstance;

// 运行时接口
void xt_init();
void xt_print_int(int64_t val);
void xt_print_string(XTString* str);
void xt_print_bool(int val);
void xt_print_float(double val);
XTInt* xt_int_new(int64_t val);
XTString* xt_string_new(const char* data);
void* xt_malloc(size_t size, uint32_t type_id);
void xt_retain(void* obj);
void xt_release(void* obj);
int64_t xt_to_int(void* obj);
XTString* xt_string_concat(XTString* s1, XTString* s2);
XTString* xt_int_to_string(int64_t val);

#endif
