#include "xt_runtime.h"

void xt_init() {
#ifdef _WIN32
    SetConsoleOutputCP(65001); // 设置为 UTF-8
#endif
}

void xt_print_int(int64_t val) {
    printf("%lld\n", val);
}

XTValue xt_int_new(int64_t val) {
    return XT_FROM_INT(val);
}

void* xt_float_new(double val) {
    typedef struct { XTObject header; double value; } XTFloat;
    XTFloat* obj = (XTFloat*)xt_malloc(sizeof(XTFloat), XT_TYPE_FLOAT);
    obj->value = val;
    return (void*)obj;
}

XTValue xt_bool_new(int val) {
    return XT_FROM_BOOL(val);
}

XTString* xt_string_new(const char* data) {
    XTString* str = (XTString*)malloc(sizeof(XTString));
    atomic_init(&str->header.ref_count, 1);
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
    atomic_init(&obj->ref_count, 1);
    obj->type_id = type_id;
    return (void*)obj;
}

void xt_retain(XTValue val) {
    if (XT_IS_PTR(val) && val != XT_NULL && val != XT_TRUE && val != XT_FALSE) {
        XTObject* obj = (XTObject*)val;
        atomic_fetch_add_explicit(&obj->ref_count, 1, memory_order_relaxed);
    }
}

void xt_release(XTValue val) {
    if (XT_IS_PTR(val) && val != XT_NULL && val != XT_TRUE && val != XT_FALSE) {
        XTObject* obj = (XTObject*)val;
        if (atomic_fetch_sub_explicit(&obj->ref_count, 1, memory_order_release) == 1) {
            atomic_thread_fence(memory_order_acquire);
            if (obj->type_id == XT_TYPE_STRING) {
                XTString* s = (XTString*)val;
                free(s->data);
            } else if (obj->type_id == XT_TYPE_ARRAY) {
                XTArray* arr = (XTArray*)val;
                for (size_t i = 0; i < arr->length; i++) {
                    xt_release((XTValue)arr->elements[i]);
                }
                free(arr->elements);
            } else if (obj->type_id == XT_TYPE_INSTANCE) {
                XTInstance* inst = (XTInstance*)val;
                free(inst->fields);
            } else if (obj->type_id == XT_TYPE_RESULT) {
                XTResult* res = (XTResult*)val;
                if (res->value) xt_release((XTValue)res->value);
                if (res->error) xt_release((XTValue)res->error);
            }
            free(obj);
        }
    }
}

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

XTArray* xt_array_new(size_t capacity) {
    XTArray* arr = (XTArray*)xt_malloc(sizeof(XTArray), XT_TYPE_ARRAY);
    arr->length = 0;
    arr->capacity = capacity;
    arr->elements = (void**)malloc(sizeof(void*) * capacity);
    return arr;
}

void xt_array_append(XTArray* arr, XTValue element) {
    if (arr->length >= arr->capacity) {
        arr->capacity *= 2;
        if (arr->capacity == 0) arr->capacity = 4;
        arr->elements = (void**)realloc(arr->elements, sizeof(void*) * arr->capacity);
    }
    arr->elements[arr->length++] = (void*)element;
    xt_retain(element);
}

XTInstance* xt_instance_new(void* class_ptr, size_t field_count) {
    XTInstance* inst = (XTInstance*)xt_malloc(sizeof(XTInstance), XT_TYPE_INSTANCE);
    inst->class_ptr = class_ptr;
    inst->fields = (void**)malloc(sizeof(void*) * field_count);
    memset(inst->fields, 0, sizeof(void*) * field_count);
    return inst;
}

void* xt_result_new(int is_success, void* value, void* error) {
    XTResult* res = (XTResult*)xt_malloc(sizeof(XTResult), XT_TYPE_RESULT);
    res->is_success = is_success;
    res->value = value;
    res->error = error;
    if (value) xt_retain((XTValue)value);
    if (error) xt_retain((XTValue)error);
    return (void*)res;
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

void xt_print_value(XTValue val) {
    if (XT_IS_INT(val)) {
        printf("%lld\n", XT_TO_INT(val));
    } else if (val == XT_TRUE) {
        printf("真\n");
    } else if (val == XT_FALSE) {
        printf("假\n");
    } else if (val == XT_NULL) {
        printf("空\n");
    } else {
        XTObject* obj = (XTObject*)val;
        switch (obj->type_id) {
            case XT_TYPE_STRING:
                xt_print_string((XTString*)val);
                break;
            case XT_TYPE_FLOAT:
                xt_print_float(((struct { XTObject h; double v; }*)val)->v);
                break;
            default:
                printf("实例对象\n");
        }
    }
}

XTString* xt_int_to_string(int64_t val) {
    char buf[32];
    sprintf(buf, "%lld", val);
    return xt_string_new(buf);
}

XTString* xt_obj_to_string(XTValue val) {
    if (XT_IS_INT(val)) {
        return xt_int_to_string(XT_TO_INT(val));
    }
    if (val == XT_TRUE) return xt_string_new("真");
    if (val == XT_FALSE) return xt_string_new("假");
    if (val == XT_NULL) return xt_string_new("空");

    XTObject* header = (XTObject*)val;
    switch (header->type_id) {
        case XT_TYPE_INT: // 兼容旧的装箱整数
            return xt_int_to_string(((XTInt*)val)->value);
        case XT_TYPE_STRING:
            return (XTString*)val;
        case XT_TYPE_BOOL:
            return xt_string_new(((XTInt*)val)->value ? "真" : "假");
        case XT_TYPE_INSTANCE:
            return xt_string_new("实例对象");
        case XT_TYPE_RESULT: {
            XTResult* r = (XTResult*)val;
            if (r->is_success) {
                return xt_string_concat(xt_string_new("成功("), xt_string_concat(xt_obj_to_string((XTValue)r->value), xt_string_new(")")));
            } else {
                return xt_string_concat(xt_string_new("失败("), xt_string_concat(xt_obj_to_string((XTValue)r->error), xt_string_new(")")));
            }
        }
        default:
            return xt_string_new("未知对象");
    }
}
