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
            } else if (obj->type_id == XT_TYPE_DICT) {
                XTDict* dict = (XTDict*)val;
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
                free(dict->buckets);
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
            xt_retain(val);
            return (XTString*)val;
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

static uint64_t xt_hash_value(XTValue val) {
    if (XT_IS_INT(val)) return (uint64_t)XT_TO_INT(val);
    if (val == XT_TRUE) return 4;
    if (val == XT_FALSE) return 2;
    if (val == XT_NULL) return 0;

    XTObject* obj = (XTObject*)val;
    if (obj->type_id == XT_TYPE_STRING) {
        XTString* s = (XTString*)val;
        uint64_t hash = 5381;
        for (size_t i = 0; i < s->length; i++) {
            hash = ((hash << 5) + hash) + s->data[i];
        }
        return hash;
    }
    return (uint64_t)val; // 默认地址哈希
}

static int xt_values_equal(XTValue a, XTValue b) {
    if (a == b) return 1;
    if (XT_IS_INT(a) && XT_IS_INT(b)) return XT_TO_INT(a) == XT_TO_INT(b);
    
    if (XT_IS_PTR(a) && XT_IS_PTR(b) && a != XT_NULL && b != XT_NULL) {
        XTObject* oa = (XTObject*)a;
        XTObject* ob = (XTObject*)b;
        if (oa->type_id == XT_TYPE_STRING && ob->type_id == XT_TYPE_STRING) {
            XTString* sa = (XTString*)a;
            XTString* sb = (XTString*)b;
            if (sa->length != sb->length) return 0;
            return memcmp(sa->data, sb->data, sa->length) == 0;
        }
    }
    return 0;
}

XTDict* xt_dict_new(size_t capacity) {
    if (capacity < 8) capacity = 8;
    XTDict* dict = (XTDict*)xt_malloc(sizeof(XTDict), XT_TYPE_DICT);
    dict->capacity = capacity;
    dict->size = 0;
    dict->buckets = (XTDictEntry**)calloc(capacity, sizeof(XTDictEntry*));
    return dict;
}

void xt_dict_set(XTDict* dict, XTValue key, XTValue value) {
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_values_equal(entry->key, key)) {
            xt_release(entry->value);
            entry->value = value;
            xt_retain(value);
            return;
        }
        entry = entry->next;
    }

    // 新增条目
    entry = (XTDictEntry*)malloc(sizeof(XTDictEntry));
    entry->key = key;
    entry->value = value;
    entry->next = dict->buckets[idx];
    dict->buckets[idx] = entry;
    dict->size++;
    xt_retain(key);
    xt_retain(value);
}

XTValue xt_dict_get(XTDict* dict, XTValue key) {
    if (!dict) return XT_NULL;
    uint64_t hash = xt_hash_value(key);
    size_t idx = hash % dict->capacity;

    XTDictEntry* entry = dict->buckets[idx];
    while (entry) {
        if (xt_values_equal(entry->key, key)) {
            return entry->value;
        }
        entry = entry->next;
    }
    return XT_NULL;
}

// --- 文件 I/O 实现 ---

XTValue xt_file_read(XTValue path_val) {
    if (XT_IS_INT(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    
    FILE* f = fopen(path->data, "rb");
    if (!f) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法打开文件"));

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

XTValue xt_file_write(XTValue path_val, XTValue content_val) {
    if (XT_IS_INT(path_val)) return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    XTString* content = xt_obj_to_string(content_val);

    FILE* f = fopen(path->data, "wb");
    if (!f) {
        xt_release((XTValue)content);
        return (XTValue)xt_result_new(0, NULL, (void*)xt_string_new("无法写入文件"));
    }

    fwrite(content->data, 1, content->length, f);
    fclose(f);
    xt_release((XTValue)content);

    return (XTValue)xt_result_new(1, (void*)XT_TRUE, NULL);
}
