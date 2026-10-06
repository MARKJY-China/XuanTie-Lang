// SQLite桥.c — 玄铁 SQLite 库 C 桥接层 v1.0
// 将玄铁的 i64 标记指针/对象与 sqlite3 C API 互转。
// 编译时与 xt_runtime.o + sqlite3.o 一起链接(经 tiepm.toml [原生] 对象机制)。
//
// 对象惯例(与 渲染桥.c 同款精简模型):
//   整数: tagged = (raw << 1) | 1
//   布尔: true = 0x4, false = 0x2
//   字符串: XTString 对象指针
//   浮点: XTFloat 对象指针
//   字节集: XTBytes 对象指针
//   句柄: XTHandle 对象(payload=sqlite3*,dtor=关闭钩子),ARC 回收自动关闭连接

#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include "sqlite3.h"

#define XT_TAG_INT     0x1ULL
#define XT_FROM_INT(i) (((uintptr_t)(i) << 1) | XT_TAG_INT)
#define XT_TO_INT(v)   ((int64_t)((intptr_t)(v) >> 1))
#define XT_TRUE        ((uintptr_t)0x4ULL)
#define XT_FALSE       ((uintptr_t)0x2ULL)
#define XT_NULLV       ((uintptr_t)0)

#define XT_TYPE_FLOAT   2
#define XT_TYPE_STRING  3
#define XT_TYPE_ARRAY   5
#define XT_TYPE_DICT    6
#define XT_TYPE_BYTES   10
#define XT_TYPE_HANDLE  16

typedef struct {
    uint32_t magic;
    uint32_t ref_count;
    uint32_t type_id;
} XTObject;

typedef struct {
    uint32_t magic;
    uint32_t ref_count;
    uint32_t type_id;
    char*    data;
    size_t   length;
    size_t   capacity;
    uint8_t  data_in_arena;
} XTString;

typedef struct {
    uint32_t magic;
    uint32_t ref_count;
    uint32_t type_id;
    void* payload;
    void (*dtor)(void*);
} XTHandle;

// === 玄铁 runtime 导出(xt_runtime.o 链接提供) ===
extern void* xt_string_new(const char*);
extern void* xt_string_new_len(const char*, size_t);
extern void* xt_dict_new(size_t);
extern void  xt_dict_set(void*, void*, void*);
extern void* xt_array_new(size_t);
extern void  xt_array_append(void*, void*);
extern void* xt_result_new(int, void*, void*);
extern void* xt_float_new(double);
extern void* xt_bytes_new(size_t);
extern void  xt_bytes_append(void*, uint8_t);
extern void* xt_handle_new(void*, void (*)(void*));
extern void  xt_release(uintptr_t);

// === 句柄工具 ===
static void _sqldb_dtor(void* p) {
    if (p) sqlite3_close_v2((sqlite3*)p);
}

static sqlite3* _db_of(uintptr_t v) {
    if (v == 0 || (v & XT_TAG_INT)) return NULL;
    XTObject* o = (XTObject*)v;
    if (o->type_id != XT_TYPE_HANDLE) return NULL;
    XTHandle* h = (XTHandle*)v;
    if (!h->payload) return NULL;
    return (sqlite3*)h->payload;
}

static uintptr_t _err(sqlite3* db, const char* fallback) {
    const char* msg = db ? sqlite3_errmsg(db) : fallback;
    if (!msg) msg = fallback;
    return (uintptr_t)xt_result_new(0, NULL, xt_string_new(msg));
}

// 打开数据库:路径( ":memory:" 为内存库) → 结果<句柄>
uintptr_t xt_sqlite_open(uintptr_t path_val) {
    if (path_val == 0 || (path_val & XT_TAG_INT)) return (uintptr_t)xt_result_new(0, NULL, xt_string_new("路径无效"));
    XTObject* o = (XTObject*)path_val;
    if (o->type_id != XT_TYPE_STRING) return (uintptr_t)xt_result_new(0, NULL, xt_string_new("路径无效"));
    XTString* path = (XTString*)path_val;
    sqlite3* db = NULL;
    int rc = sqlite3_open(path->data, &db);
    if (rc != SQLITE_OK) {
        const char* msg = db ? sqlite3_errmsg(db) : "无法打开数据库";
        uintptr_t r = (uintptr_t)xt_result_new(0, NULL, xt_string_new(msg));
        if (db) sqlite3_close(db);
        return r;
    }
    sqlite3_busy_timeout(db, 5000);
    return (uintptr_t)xt_result_new(1, xt_handle_new(db, _sqldb_dtor), NULL);
}

// 关闭(幂等;句柄被 ARC 回收时也会自动关闭)
uintptr_t xt_sqlite_close(uintptr_t db_val) {
    if (db_val == 0 || (db_val & XT_TAG_INT)) return (uintptr_t)xt_result_new(0, NULL, xt_string_new("不是数据库句柄"));
    XTObject* o = (XTObject*)db_val;
    if (o->type_id != XT_TYPE_HANDLE) return (uintptr_t)xt_result_new(0, NULL, xt_string_new("不是数据库句柄"));
    XTHandle* h = (XTHandle*)db_val;
    if (h->payload) {
        sqlite3_close((sqlite3*)h->payload);
        h->payload = NULL;
    }
    return (uintptr_t)xt_result_new(1, (void*)XT_TRUE, NULL);
}

// 取错误消息 → 字
uintptr_t xt_sqlite_errmsg(uintptr_t db_val) {
    sqlite3* db = _db_of(db_val);
    if (!db) return (uintptr_t)xt_string_new("句柄无效或已关闭");
    const char* msg = sqlite3_errmsg(db);
    return (uintptr_t)xt_string_new(msg ? msg : "");
}

// 执行(非查询:CREATE/INSERT/UPDATE/DELETE/事务语句) → 结果<整:影响行数>
uintptr_t xt_sqlite_exec(uintptr_t db_val, uintptr_t sql_val) {
    sqlite3* db = _db_of(db_val);
    if (!db) return _err(NULL, "句柄无效或已关闭");
    if (sql_val == 0 || (sql_val & XT_TAG_INT)) return _err(db, "SQL 必须是字符串");
    XTObject* so = (XTObject*)sql_val;
    if (so->type_id != XT_TYPE_STRING) return _err(db, "SQL 必须是字符串");
    XTString* sql = (XTString*)sql_val;
    char* err = NULL;
    int rc = sqlite3_exec(db, sql->data, NULL, NULL, &err);
    if (rc != SQLITE_OK) {
        uintptr_t r = (uintptr_t)xt_result_new(0, NULL, xt_string_new(err ? err : sqlite3_errmsg(db)));
        if (err) sqlite3_free(err);
        return r;
    }
    return (uintptr_t)xt_result_new(1, (void*)XT_FROM_INT((int64_t)sqlite3_changes(db)), NULL);
}

// 参数绑定(共用):把玄铁数组元素逐个绑到语句 ? 占位符
static int _bind_params(sqlite3* db, sqlite3_stmt* st, uintptr_t params_val, const char** out_err) {
    if (params_val == 0) return 1;   // 空 = 无参
    if (params_val & XT_TAG_INT) { *out_err = "参数必须是数组"; return 0; }
    XTObject* o = (XTObject*)params_val;
    if (o->type_id != XT_TYPE_ARRAY) { *out_err = "参数必须是数组"; return 0; }
    // 数组布局(与 xt_runtime.h 的 XTArray 对齐): { XTObject + elements + length + capacity + in_arena }
    typedef struct { XTObject header; uintptr_t* elements; size_t length; size_t capacity; uint8_t elements_in_arena; } XTArray;
    XTArray* arr = (XTArray*)params_val;
    for (size_t i = 0; i < arr->length; i++) {
        uintptr_t v = arr->elements[i];
        int idx = (int)i + 1;
        int rc = SQLITE_OK;
        if (v == XT_NULLV) {
            rc = sqlite3_bind_null(st, idx);
        } else if (v & XT_TAG_INT) {
            rc = sqlite3_bind_int64(st, idx, (sqlite3_int64)XT_TO_INT(v));
        } else if (v == XT_TRUE) {
            rc = sqlite3_bind_int(st, idx, 1);
        } else if (v == XT_FALSE) {
            rc = sqlite3_bind_int(st, idx, 0);
        } else {
            XTObject* vo = (XTObject*)v;
            if (vo->type_id == XT_TYPE_FLOAT) {
                typedef struct { XTObject header; double value; } XTFloat;
                rc = sqlite3_bind_double(st, idx, ((XTFloat*)v)->value);
            } else if (vo->type_id == XT_TYPE_STRING) {
                XTString* s = (XTString*)v;
                rc = sqlite3_bind_text(st, idx, s->data, (int)s->length, SQLITE_TRANSIENT);
            } else if (vo->type_id == XT_TYPE_BYTES) {
                typedef struct { XTObject header; uint8_t* data; size_t length; size_t capacity; } XTBytes;
                XTBytes* b = (XTBytes*)v;
                rc = sqlite3_bind_blob(st, idx, b->data, (int)b->length, SQLITE_TRANSIENT);
            } else {
                *out_err = "不支持的参数类型(仅 整/小数/字/字节/布尔/空)";
                return 0;
            }
        }
        if (rc != SQLITE_OK) { *out_err = sqlite3_errmsg(db); return 0; }
    }
    return 1;
}

// 列值 → 玄铁值(INTEGER/FLOAT/TEXT/BLOB/NULL)
static uintptr_t _column_value(sqlite3_stmt* st, int i) {
    int t = sqlite3_column_type(st, i);
    switch (t) {
        case SQLITE_INTEGER:
            return XT_FROM_INT((int64_t)sqlite3_column_int64(st, i));
        case SQLITE_FLOAT:
            return (uintptr_t)xt_float_new(sqlite3_column_double(st, i));
        case SQLITE_TEXT: {
            const char* s = (const char*)sqlite3_column_text(st, i);
            int n = sqlite3_column_bytes(st, i);
            return (uintptr_t)xt_string_new_len(s ? s : "", (size_t)n);
        }
        case SQLITE_BLOB: {
            const void* data = sqlite3_column_blob(st, i);
            int n = sqlite3_column_bytes(st, i);
            void* bytes = xt_bytes_new((size_t)(n > 0 ? n : 1));
            for (int j = 0; j < n; j++) xt_bytes_append(bytes, ((const uint8_t*)data)[j]);
            return (uintptr_t)bytes;
        }
        default:
            return XT_NULLV;
    }
}

// 查询 → 结果<数组<字典>>(每行一个字典:列名 → 值)
static uintptr_t _query_common(sqlite3* db, const char* sql, uintptr_t params_val) {
    sqlite3_stmt* st = NULL;
    int rc = sqlite3_prepare_v2(db, sql, -1, &st, NULL);
    if (rc != SQLITE_OK) return _err(db, "SQL 预编译失败");
    if (params_val != 0) {
        const char* berr = NULL;
        if (!_bind_params(db, st, params_val, &berr)) {
            uintptr_t r = _err(db, berr ? berr : "参数绑定失败");
            sqlite3_finalize(st);
            return r;
        }
    }
    uintptr_t rows = (uintptr_t)xt_array_new(0);
    int ncol = sqlite3_column_count(st);
    while ((rc = sqlite3_step(st)) == SQLITE_ROW) {
        uintptr_t row = (uintptr_t)xt_dict_new(0);
        for (int i = 0; i < ncol; i++) {
            const char* name = sqlite3_column_name(st, i);
            void* k = xt_string_new(name ? name : "");
            uintptr_t v = _column_value(st, i);
            xt_dict_set((void*)row, k, (void*)v);
            // dict_set 已 retain 键值;释放构造侧份额(对标记整数/0 是空操作)
            xt_release((uintptr_t)k);
            xt_release(v);
        }
        xt_array_append((void*)rows, (void*)row);
        xt_release(row);
    }
    if (rc != SQLITE_DONE) {
        sqlite3_finalize(st);
        xt_release(rows);
        return _err(db, "查询执行失败");
    }
    sqlite3_finalize(st);
    return (uintptr_t)xt_result_new(1, (void*)rows, NULL);
}

uintptr_t xt_sqlite_query(uintptr_t db_val, uintptr_t sql_val) {
    sqlite3* db = _db_of(db_val);
    if (!db) return _err(NULL, "句柄无效或已关闭");
    if (sql_val == 0 || (sql_val & XT_TAG_INT)) return _err(db, "SQL 必须是字符串");
    XTObject* so = (XTObject*)sql_val;
    if (so->type_id != XT_TYPE_STRING) return _err(db, "SQL 必须是字符串");
    return _query_common(db, ((XTString*)sql_val)->data, 0);
}

uintptr_t xt_sqlite_query_p(uintptr_t db_val, uintptr_t sql_val, uintptr_t params_val) {
    sqlite3* db = _db_of(db_val);
    if (!db) return _err(NULL, "句柄无效或已关闭");
    if (sql_val == 0 || (sql_val & XT_TAG_INT)) return _err(db, "SQL 必须是字符串");
    XTObject* so = (XTObject*)sql_val;
    if (so->type_id != XT_TYPE_STRING) return _err(db, "SQL 必须是字符串");
    return _query_common(db, ((XTString*)sql_val)->data, params_val);
}

// 带参执行 → 结果<整:影响行数>
uintptr_t xt_sqlite_exec_p(uintptr_t db_val, uintptr_t sql_val, uintptr_t params_val) {
    sqlite3* db = _db_of(db_val);
    if (!db) return _err(NULL, "句柄无效或已关闭");
    if (sql_val == 0 || (sql_val & XT_TAG_INT)) return _err(db, "SQL 必须是字符串");
    XTObject* so = (XTObject*)sql_val;
    if (so->type_id != XT_TYPE_STRING) return _err(db, "SQL 必须是字符串");
    sqlite3_stmt* st = NULL;
    int rc = sqlite3_prepare_v2(db, ((XTString*)sql_val)->data, -1, &st, NULL);
    if (rc != SQLITE_OK) return _err(db, "SQL 预编译失败");
    const char* berr = NULL;
    if (!_bind_params(db, st, params_val, &berr)) {
        uintptr_t r = _err(db, berr ? berr : "参数绑定失败");
        sqlite3_finalize(st);
        return r;
    }
    rc = sqlite3_step(st);
    if (rc != SQLITE_DONE && rc != SQLITE_ROW) {
        sqlite3_finalize(st);
        return _err(db, "执行失败");
    }
    sqlite3_finalize(st);
    return (uintptr_t)xt_result_new(1, (void*)XT_FROM_INT((int64_t)sqlite3_changes(db)), NULL);
}
