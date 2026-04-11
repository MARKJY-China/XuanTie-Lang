#include "xt_runtime.h"

void xt_init() {
#ifdef _WIN32
    SetConsoleOutputCP(65001); // 设置为 UTF-8
#endif
}

void xt_print_int(int64_t val) {
    printf("%lld\n", val);
}

XTInt* xt_int_new(int64_t val) {
    XTInt* obj = (XTInt*)xt_malloc(sizeof(XTInt), XT_TYPE_INT);
    obj->value = val;
    return obj;
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
    XTObject* obj = (XTObject*)malloc(size);
    if (!obj) return NULL;
    obj->ref_count = 1;
    obj->type_id = type_id;
    return (void*)obj;
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
        } else if (obj->type_id == XT_TYPE_ARRAY) {
            XTArray* arr = (XTArray*)ptr;
            for (size_t i = 0; i < arr->length; i++) {
                xt_release(arr->elements[i]);
            }
            free(arr->elements);
        } else if (obj->type_id == XT_TYPE_INSTANCE) {
            XTInstance* inst = (XTInstance*)ptr;
            free(inst->fields);
        }
        free(obj);
    }
}

int64_t xt_to_int(void* obj) {
    if (!obj) return 0;
    XTObject* header = (XTObject*)obj;
    if (header->type_id == XT_TYPE_INT) {
        return ((XTInt*)obj)->value;
    }
    return 0;
}

XTArray* xt_array_new(size_t capacity) {
    XTArray* arr = (XTArray*)xt_malloc(sizeof(XTArray), XT_TYPE_ARRAY);
    arr->length = 0;
    arr->capacity = capacity;
    arr->elements = (void**)malloc(sizeof(void*) * capacity);
    return arr;
}

void xt_array_append(XTArray* arr, void* element) {
    if (arr->length >= arr->capacity) {
        arr->capacity *= 2;
        if (arr->capacity == 0) arr->capacity = 4;
        arr->elements = (void**)realloc(arr->elements, sizeof(void*) * arr->capacity);
    }
    arr->elements[arr->length++] = element;
    xt_retain(element);
}

XTInstance* xt_instance_new(void* class_ptr, size_t field_count) {
    XTInstance* inst = (XTInstance*)xt_malloc(sizeof(XTInstance), XT_TYPE_INSTANCE);
    inst->class_ptr = class_ptr;
    inst->fields = (void**)malloc(sizeof(void*) * field_count);
    memset(inst->fields, 0, sizeof(void*) * field_count);
    return inst;
}

XTString* xt_string_concat(XTString* s1, XTString* s2) {
    if (!s1 && !s2) return xt_string_new("");
    if (!s1) return s2;
    if (!s2) return s1;
    
    size_t new_len = s1->length + s2->length;
    char* new_data = (char*)malloc(new_len + 1);
    strcpy(new_data, s1->data);
    strcat(new_data, s2->data);
    
    XTString* res = xt_string_new(new_data);
    free(new_data);
    return res;
}

XTString* xt_int_to_string(int64_t val) {
    char buf[32];
    sprintf(buf, "%lld", val);
    return xt_string_new(buf);
}
