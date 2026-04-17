#include "xt_runtime.h"
// 运行时接口
static void print_pool_stats(); // 前置声明

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

void xt_print_pool_stats() {
    printf("--- Memory Pool Stats ---\n");
    // printf("Pool Allocations: %d\n", pool_alloc_count);
    // printf("Pool Frees:       %d\n", pool_free_count);
    // printf("Malloc Fallbacks: %d\n", malloc_fallback_count);
    printf("-------------------------\n");
}

#ifdef XT_DEBUG
#define XT_DEBUG_PRINT(...) do { printf("DEBUG: " __VA_ARGS__); fflush(stdout); } while(0)
#else
#define XT_DEBUG_PRINT(...)
#endif

#define CRASH_DEBUG(...) // do { printf("DEBUG: " __VA_ARGS__); fflush(stdout); } while(0)

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
    if (!data) data = "";
    XTString* s = (XTString*)xt_malloc(sizeof(XTString), XT_TYPE_STRING);
    s->length = strlen(data);
    s->data = (char*)malloc(s->length + 1);
#ifdef _WIN32
    strcpy_s(s->data, s->length + 1, data);
#else
    strcpy(s->data, data);
#endif
    XT_DEBUG_PRINT("xt_string_new [%s] at %p\n", data, (void*)s);
    return s;
}

XTString* xt_string_from_char(char c) {
    char buf[2] = {c, '\0'};
    return xt_string_new(buf);
}

XTString* xt_string_next_char(XTString* s, int64_t* offset) {
    if (!s || *offset >= s->length) return xt_string_new("");
    unsigned char* d = (unsigned char*)s->data + *offset;
    int len = 1;
    if (*d >= 0xf0) len = 4;
    else if (*d >= 0xe0) len = 3;
    else if (*d >= 0xc0) len = 2;
    
    if (*offset + len > s->length) len = (int)(s->length - *offset);
    
    char buf[5] = {0};
    memcpy(buf, d, len);
    *offset += len;
    return xt_string_new(buf);
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

// 简单的空闲链表内存池 (仅针对常见的定长结构体)
#define POOL_MAX_SIZE 128
#define POOL_SLOT_COUNT 8

// 添加调试统计
// static int pool_alloc_count = 0;
// static int pool_free_count = 0;
// static int malloc_fallback_count = 0;

typedef struct XTPoolNode {
    struct XTPoolNode* next;
} XTPoolNode;

static XTPoolNode* xt_memory_pools[POOL_SLOT_COUNT] = {NULL};

static inline int get_pool_index(size_t size) {
    if (size <= 16) return 0;
    if (size <= 32) return 1;
    if (size <= 48) return 2;
    if (size <= 64) return 3;
    if (size <= 80) return 4;
    if (size <= 96) return 5;
    if (size <= 112) return 6;
    if (size <= 128) return 7;
    return -1;
}

static inline size_t get_pool_size(int index) {
    return (index + 1) * 16;
}

void* xt_malloc(size_t size, uint32_t type_id) {
    XTObject* obj = NULL;
    int pool_idx = get_pool_index(size);
    
    if (pool_idx >= 0) {
        XTPoolNode* node = xt_memory_pools[pool_idx];
        if (node) {
            // 从池中取出一个
            xt_memory_pools[pool_idx] = node->next;
            obj = (XTObject*)node;
            // pool_alloc_count++;
        }
    }
    
    if (!obj) {
        // 池中没有，或者大于池的最大尺寸，则 fallback 到 malloc
        size_t alloc_size = pool_idx >= 0 ? get_pool_size(pool_idx) : size;
        obj = (XTObject*)malloc(alloc_size);
        if (!obj) {
            fprintf(stderr, "Fatal error: out of memory (xt_malloc)\n");
            exit(1);
        }
        if (pool_idx >= 0) {
            // malloc_fallback_count++;
        }
    } else {
        // 如果是从池中重用的对象，清理内存，防止上一次遗留的脏数据导致后续流程判断出错
        memset((char*)obj + sizeof(XTObject), 0, get_pool_size(pool_idx) - sizeof(XTObject));
    }

    atomic_init(&obj->ref_count, 1);
    obj->type_id = type_id;
    XT_DEBUG_PRINT("xt_malloc %p, type %u, size %zu\n", (void*)obj, type_id, size);
    return (void*)obj;
}

static void xt_free_obj(XTObject* obj, size_t size) {
    if (!obj) return;
    int pool_idx = get_pool_index(size);
    if (pool_idx >= 0) {
        // 放回池中 (简单防重释放，暂时信任引用计数)
        // 注意：为避免 ABA 或破坏内部指针，放回时需谨慎
        XTPoolNode* node = (XTPoolNode*)obj;
        node->next = xt_memory_pools[pool_idx];
        xt_memory_pools[pool_idx] = node;
        // pool_free_count++;
    } else {
        free(obj);
    }
}

static int xt_is_real_ptr(XTValue val) {
    return XT_IS_PTR(val) && val != XT_NULL && val != XT_TRUE && val != XT_FALSE;
}

void xt_retain(XTValue val) {
    if (xt_is_real_ptr(val)) {
        XTObject* obj = (XTObject*)val;
        atomic_fetch_add_explicit(&obj->ref_count, 1, memory_order_relaxed);
    }
}

void xt_release(XTValue val) {
    if (xt_is_real_ptr(val)) {
        XTObject* obj = (XTObject*)val;
        CRASH_DEBUG("xt_release: %p, type=%d, ref=%d\n", obj, obj->type_id, obj->ref_count);
        if (atomic_fetch_sub_explicit(&obj->ref_count, 1, memory_order_release) == 1) {
            atomic_thread_fence(memory_order_acquire);
            CRASH_DEBUG("xt_release: FREEING %p (type=%d)\n", obj, obj->type_id);
            size_t obj_size = 0;
            switch (obj->type_id) {
                case XT_TYPE_INT:
                case XT_TYPE_FLOAT:
                case XT_TYPE_BOOL:
                    obj_size = sizeof(XTInt); // XTInt 和 XTFloat 等共享同等大小结构体
                    break;
                case XT_TYPE_STRING: {
                    obj_size = sizeof(XTString);
                    XTString* s = (XTString*)val;
                    if (s->data) free(s->data);
                    s->data = NULL;
                    break;
                }
                case XT_TYPE_ARRAY: {
                    obj_size = sizeof(XTArray);
                    XTArray* arr = (XTArray*)val;
                    if (arr->elements) {
                        for (size_t i = 0; i < arr->length; i++) {
                            xt_release((XTValue)arr->elements[i]);
                        }
                        free(arr->elements);
                        arr->elements = NULL;
                    }
                    break;
                }
                case XT_TYPE_INSTANCE: {
                    obj_size = sizeof(XTInstance);
                    XTInstance* inst = (XTInstance*)val;
                    if (inst->fields) {
                        for (size_t i = 0; i < inst->field_count; i++) {
                            if (inst->fields[i]) {
                                xt_release((XTValue)inst->fields[i]);
                            }
                        }
                        free(inst->fields);
                        inst->fields = NULL;
                    }
                    break;
                }
                case XT_TYPE_RESULT: {
                    obj_size = sizeof(XTResult);
                    XTResult* res = (XTResult*)val;
                    if (res->value) xt_release((XTValue)res->value);
                    if (res->error) xt_release((XTValue)res->error);
                    res->value = NULL;
                    res->error = NULL;
                    break;
                }
                case XT_TYPE_DICT: {
                    obj_size = sizeof(XTDict);
                    XTDict* dict = (XTDict*)val;
                    if (dict->buckets) {
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
                        dict->buckets = NULL;
                    }
                    break;
                }
            }
            xt_free_obj(obj, obj_size);
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
    if (!arr) return;
    if (XT_IS_PTR(element)) {
        XTObject* obj = (XTObject*)element;
        if (obj && obj->type_id == XT_TYPE_STRING) {
            XT_DEBUG_PRINT("xt_array_append string=[%s]\n", ((XTString*)element)->data);
        }
    }
    if (arr->length >= arr->capacity) {
        size_t new_capacity = arr->capacity == 0 ? 4 : arr->capacity * 2;
        void** new_elements = (void**)realloc(arr->elements, sizeof(void*) * new_capacity);
        if (!new_elements) return;
        arr->elements = new_elements;
        arr->capacity = new_capacity;
    }
    xt_retain(element);
    arr->elements[arr->length++] = (void*)element;
}

XTInstance* xt_instance_new(void* class_ptr, size_t field_count) {
    XTInstance* inst = (XTInstance*)xt_malloc(sizeof(XTInstance), XT_TYPE_INSTANCE);
    inst->class_ptr = class_ptr;
    inst->field_count = field_count;
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
    if (!s1) { xt_retain((XTValue)s2); return s2; }
    if (!s2) { xt_retain((XTValue)s1); return s1; }
    
    XT_DEBUG_PRINT("concat [%s] and [%s]\n", s1->data, s2->data);
    size_t new_len = s1->length + s2->length;
    char* new_data = (char*)malloc(new_len + 1);
#ifdef _WIN32
    strcpy_s(new_data, new_len + 1, s1->data);
    strcat_s(new_data, new_len + 1, s2->data);
#else
    strcpy(new_data, s1->data);
    strcat(new_data, s2->data);
#endif
    
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

    if (!xt_is_real_ptr(val)) return xt_string_new("非法");

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

    if (!xt_is_real_ptr(val)) return (uint64_t)val;

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
    
    if (xt_is_real_ptr(a) && xt_is_real_ptr(b)) {
        XTObject* oa = (XTObject*)a;
        XTObject* ob = (XTObject*)b;
        // printf("DEBUG: xt_values_equal %p (type %d) and %p (type %d)\n", (void*)oa, oa->type_id, (void*)ob, ob->type_id);
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
            XT_DEBUG_PRINT("xt_dict_get found key, returning %p\n", (void*)entry->value);
            return entry->value;
        }
        entry = entry->next;
    }
    XT_DEBUG_PRINT("xt_dict_get NOT found key\n");
    return XT_NULL;
}

XTArray* xt_dict_keys(XTDict* dict) {
    if (!dict || dict->header.type_id != XT_TYPE_DICT) return NULL;
    XTArray* arr = (XTArray*)xt_array_new(dict->size);
    for (size_t i = 0; i < dict->capacity; i++) {
        XTDictEntry* entry = dict->buckets[i];
        while (entry) {
            xt_array_append(arr, entry->key);
            entry = entry->next;
        }
    }
    return arr;
}

// --- 文件 I/O 实现 ---

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

int xt_eq(void* a, void* b) {
    XTValue va = (XTValue)a;
    XTValue vb = (XTValue)b;
    if (va == vb) return 1;
    if (XT_IS_INT(va) || XT_IS_INT(vb)) return 0;
    if (va == XT_NULL || vb == XT_NULL) return 0;
    
    XTObject* oa = (XTObject*)va;
    XTObject* ob = (XTObject*)vb;
    if (oa->type_id == XT_TYPE_STRING && ob->type_id == XT_TYPE_STRING) {
        return strcmp(((XTString*)va)->data, ((XTString*)vb)->data) == 0;
    }
    return 0;
}

int xt_compare(void* a, void* b) {
    XTValue va = (XTValue)a;
    XTValue vb = (XTValue)b;
    if (va == vb) return 0;
    if (XT_IS_INT(va) && XT_IS_INT(vb)) {
        int64_t ia = XT_TO_INT(va);
        int64_t ib = XT_TO_INT(vb);
        return (ia < ib) ? -1 : (ia > ib ? 1 : 0);
    }
    if (XT_IS_PTR(va) && XT_IS_PTR(vb) && va != XT_NULL && vb != XT_NULL) {
        XTObject* sa_obj = (XTObject*)va;
        XTObject* sb_obj = (XTObject*)vb;
        if (sa_obj->type_id == XT_TYPE_STRING && sb_obj->type_id == XT_TYPE_STRING) {
            XTString* sa = (XTString*)va;
            XTString* sb = (XTString*)vb;
            int res = strcmp(sa->data, sb->data);
            XT_DEBUG_PRINT("compare string [%s] vs [%s] = %d\n", sa->data, sb->data, res);
            return res;
        }
    }
    return (va < vb) ? -1 : (va > vb ? 1 : 0);
}
