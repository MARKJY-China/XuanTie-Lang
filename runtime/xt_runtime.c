#include "xt_runtime.h"

void xt_init() {
#ifdef _WIN32
    SetConsoleOutputCP(65001); // 设置为 UTF-8
#endif
}

void xt_print_int(int64_t val) {
    printf("%lld\n", val);
}

XTString* xt_string_new(const char* data) {
    XTString* str = (XTString*)malloc(sizeof(XTString));
    str->header.ref_count = 1;
    str->header.type_id = XT_TYPE_STRING;
    str->length = strlen(data);
    str->data = strdup(data);
    return str;
}

void xt_print_string(XTString* str) {
    if (!str) {
        printf("空\n");
        return;
    }
    printf("%s\n", str->data);
}

void xt_print_bool(int val) {
    printf("%s\n", val ? "真" : "假");
}

void xt_print_float(double val) {
    printf("%g\n", val);
}

void* xt_malloc(size_t size, uint32_t type_id) {
    XTObject* obj = (XTObject*)malloc(sizeof(XTObject) + size);
    if (!obj) return NULL;
    obj->ref_count = 1;
    obj->type_id = type_id;
    return (void*)(obj + 1); // 返回头部之后的内存
}

void xt_retain(void* ptr) {
    if (!ptr) return;
    XTObject* obj = (XTObject*)ptr;
    obj->ref_count++;
}

void xt_release(void* ptr) {
    if (!ptr) return;
    XTObject* obj = (XTObject*)ptr;
    obj->ref_count--;
    if (obj->ref_count == 0) {
        if (obj->type_id == XT_TYPE_STRING) {
            XTString* s = (XTString*)ptr;
            free(s->data);
        }
        free(obj);
    }
}
