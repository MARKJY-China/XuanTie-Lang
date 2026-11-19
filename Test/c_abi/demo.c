#include "libxtmath.h"
#include <stdio.h>
#include <string.h>

int main(void) {
    xt_lib_init();
    int64_t sum = xt_add(2, 3);
    int32_t pos = xt_is_positive(7);
    int32_t neg = xt_is_positive(-1);
    char* s = xt_greet("玄铁");
    int ok = (sum == 5 && pos == 1 && neg == 0 && s && strcmp(s, "你好，玄铁") == 0);
    xt_cabi_string_free(s);
    printf("sum=%lld pos=%d neg=%d %s\n", (long long)sum, pos, neg, ok ? "C_ABI_PASS" : "C_ABI_FAIL");
    return ok ? 0 : 1;
}
