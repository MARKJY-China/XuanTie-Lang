#!/usr/bin/env python3
"""Apply all fixes for self-hosting to e05541b baseline."""
import sys

# Fix 编译.xt
with open('xuantie_compiler/编译.xt', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

# 1. Delete debug print
old = '                示("[弱赋值查] 型名=" & 型名 & " 表含型=" & 此.弱引用字段表.含?(型名))\n'
if old in content:
    content = content.replace(old, '')
    changes += 1
    print("+ Deleted debug print")

# 2. Fix 终→止
old2 = '设 始 = 0 ; 设 终 = 0'
new2 = '设 始 = 0 ; 设 止 = 0'
if old2 in content:
    content = content.replace(old2, new2)
    changes += 1
    print("+ Fixed 终→止 (decl)")
old2b = '{ 终 = kk2 ; 断 } ; kk2 = kk2 - 1 }'
new2b = '{ 止 = kk2 ; 断 } ; kk2 = kk2 - 1 }'
if old2b in content:
    content = content.replace(old2b, new2b)
    print("+ Fixed 终→止 (assign)")
old2c = '且 终 > 始 { 返 清理.截取(始+1, 终) }'
new2c = '且 止 > 始 { 返 清理.截取(始+1, 止) }'
if old2c in content:
    content = content.replace(old2c, new2c)
    print("+ Fixed 终→止 (use)")

# 3. Add 入口alloca fields
# Field declaration
old3 = '    设 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n\n    函 造() {'
new3 = '    设 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n    设 入口alloca列表 // 函数入口处延迟写入的 alloca 行，确保 LLVM 支配性\n\n    函 造() {'
if old3 in content:
    content = content.replace(old3, new3)
    changes += 1
    print("+ Added 入口alloca field")

# Constructor init
old4 = '        此.全局声明列表 = []\n\n        // 初始化内置全局符号映射'
new4 = '        此.全局声明列表 = []\n        此.入口alloca列表 = []\n\n        // 初始化内置全局符号映射'
if old4 in content:
    content = content.replace(old4, new4)
    changes += 1
    print("+ Added 入口alloca init")

# 4. Modify 编译遍历循环 - alloca to entry
old5 = '        // 0. 预先分配迭代变量和索引变量的栈空间 (确保 alloca 唯一)\n        设 变量名 = 此.符(节点.迭代变量名)\n        若 非 此.符号表.含?(变量名) {\n            设 varAddr = "%\\"" & 变量名 & "\\""\n            此.写出("  " & varAddr & " = alloca i64")\n            此.追踪对象(varAddr)\n            此.符号表[变量名] = varAddr\n        }\n        \n        若 节点.迭代索引名 != "" {\n            设 索名 = 此.符(节点.迭代索引名)\n            若 非 此.符号表.含?(索名) {\n                设 idxAddr = "%\\"" & 索名 & "\\""\n                此.写出("  " & idxAddr & " = alloca i64")\n                此.追踪对象(idxAddr)\n                此.符号表[索名] = idxAddr\n            }\n        }'
new5 = '        // 0. 将迭代变量和索引变量 alloca 提升到函数入口块\n        设 变量名 = 此.符(节点.迭代变量名)\n        若 非 此.符号表.含?(变量名) {\n            设 varAddr = "%\\"" & 变量名 & "\\""\n            此.入口alloca列表.追加("  " & varAddr & " = alloca i64\\n")\n            此.追踪对象(varAddr)\n            此.符号表[变量名] = varAddr\n        }\n\n        若 节点.迭代索引名 != "" {\n            设 索名 = 此.符(节点.迭代索引名)\n            若 非 此.符号表.含?(索名) {\n                设 idxAddr = "%\\"" & 索名 & "\\""\n                此.入口alloca列表.追加("  " & idxAddr & " = alloca i64\\n")\n                此.追踪对象(idxAddr)\n                此.符号表[索名] = idxAddr\n            }\n        }'
if old5 in content:
    content = content.replace(old5, new5)
    changes += 1
    print("+ Fixed 编译遍历循环 allocas")

# 5. Remove 进作用域/出作用域 from loop
old6 = '        此.写出(循环体标签 & ":")\n        此.进作用域()\n        \n        // 获取元素并存入迭代变量'
new6 = '        此.写出(循环体标签 & ":")\n\n        // 获取元素并存入迭代变量'
if old6 in content:
    content = content.replace(old6, new6)
    changes += 1
    print("+ Removed 进作用域 from loop")

old7 = '        此.编译语句(节点.循环块)\n        此.出作用域(假)\n        此.写出("  br label %" & 步进标签)'
new7 = '        此.编译语句(节点.循环块)\n        此.写出("  br label %" & 步进标签)'
if old7 in content:
    content = content.replace(old7, new7)
    changes += 1
    print("+ Removed 出作用域 from loop")

# 6. 注册局部变量 - use entry alloca
old8 = '                设 局部名 = "%\\"" & 变量名 & "\\""\n                此.写出("  " & 局部名 & " = alloca i64")\n                此.写出("  store i64 " & 此.符(xt_val) & ", i64* " & 局部名)'
new8 = '                设 局部名 = "%\\"" & 变量名 & "\\""\n                此.入口alloca列表.追加("  " & 局部名 & " = alloca i64\\n")\n                此.写出("  store i64 " & 此.符(xt_val) & ", i64* " & 局部名)'
if old8 in content:
    content = content.replace(old8, new8)
    changes += 1
    print("+ Fixed 注册局部变量 alloca")

# 7. 编译函数定义 - entry alloca init
old9 = '        此.写出("entry:")\n        此.进作用域()\n        \n        设 k = 0'
new9 = '        此.写出("entry:")\n        此.进作用域()\n        此.入口alloca列表 = []\n\n        设 k = 0'
if old9 in content:
    content = content.replace(old9, new9)
    changes += 1
    print("+ Added entry alloca init in function def")

# 8. Save entry output after params
old10 = '            k = k + 1\n        }\n\n        // 注册返回类型注解，供调用处按需自动脱壳'
new10 = '            k = k + 1\n        }\n\n        // 保存入口输出（entry 标签 + 参数 alloca），供后续入口 alloca 拼接\n        设 入口输出列表 = []\n        遍历 _e 于 此.结果输出列表 { 入口输出列表.追加(_e) }\n        此.结果输出列表 = []\n\n        // 注册返回类型注解，供调用处按需自动脱壳'
if old10 in content:
    content = content.replace(old10, new10)
    changes += 1
    print("+ Added entry output save")

# 9. Function body assembly with entry alloca
old11 = '        // 拼接函数体\n        设 函数体 = 此.结果输出列表.连接("")\n        此.函数输出列表.追加(函数体)'
new11 = '        // 拼接函数体（入口 alloca 插入到 entry 块，保证 LLVM 支配性）\n        设 _alloca文本 = 此.入口alloca列表.连接("")\n        设 _主体文本 = 此.结果输出列表.连接("")\n        设 函数体 = 入口输出列表.连接("") & _alloca文本 & _主体文本\n        此.函数输出列表.追加(函数体)'
if old11 in content:
    content = content.replace(old11, new11)
    changes += 1
    print("+ Fixed function body assembly")

# 10. Main program entry alloca
old12 = '        // 拼接主体\n        设 主体 = 此.结果输出列表.连接("")\n        \n        // 现在拼装完整的 IR'
new12 = '        // 拼接主体（入口 alloca 提前）\n        设 _主alloca文本 = 此.入口alloca列表.连接("")\n        设 主体 = _主alloca文本 & 此.结果输出列表.连接("")\n        此.入口alloca列表 = []\n\n        // 现在拼装完整的 IR'
if old12 in content:
    content = content.replace(old12, new12)
    changes += 1
    print("+ Fixed main program entry alloca")

with open('xuantie_compiler/编译.xt', 'w', encoding='utf-8') as f:
    f.write(content)

print(f"\n编译.xt: {changes} changes applied")

# Fix 语法分析.xt
with open('xuantie_compiler/语法分析.xt', 'r', encoding='utf-8') as f:
    p = f.read()
old_p = '            变量名 = 此.当前标记.标记字面量'
new_p = '            设 变量名 = 此.当前标记.标记字面量'
if old_p in p and new_p not in p:
    p = p.replace(old_p, new_p)
    with open('xuantie_compiler/语法分析.xt', 'w', encoding='utf-8') as f:
        f.write(p)
    print("+ Fixed 语法分析.xt")

# Fix 玄铁.xt
with open('xuantie_compiler/玄铁.xt', 'r', encoding='utf-8') as f:
    x = f.read()
changes_x = 0
old_x1 = '    // 纯 ARC 模式\n    设 池 = 0'
new_x1 = '    // 初始化 Arena 用于自举编译器\n    设 池 = xt_arena_new(1073741824)\n    xt_arena_use(池)'
if old_x1 in x:
    x = x.replace(old_x1, new_x1)
    changes_x += 1
    print("+ Fixed 玄铁 Arena")
old_x2 = '    设 编译 = 造 编译器()\n    xt_retain_forever(编译)  // 编译器实例永生——方法内 此 的释放均为空操作\n    编译.严格度 = 严格度'
new_x2 = '    设 编译 = 造 编译器()\n    编译.严格度 = 严格度'
if old_x2 in x:
    x = x.replace(old_x2, new_x2)
    changes_x += 1
    print("+ Removed xt_retain_forever(编译)")
# Add stack flag to gcc commands
old_x3 = 'gcc -g -static \\"'
new_x3 = 'gcc -g -static -Wl,--stack,16777216 \\"'
if old_x3 in x and '-Wl,--stack' not in x:
    x = x.replace(old_x3, new_x3)
    changes_x += 1
    print("+ Added stack flag (static)")
old_x4 = 'gcc -g \\"'
new_x4 = 'gcc -g -Wl,--stack,16777216 \\"'
if old_x4 in x and '-Wl,--stack' not in x.split('gcc -g \\"')[1].split('\\"')[0]:
    x = x.replace(old_x4, new_x4, 1)  # Only replace the non-static one (which comes after)
    changes_x += 1
    print("+ Added stack flag (dynamic)")

with open('xuantie_compiler/玄铁.xt', 'w', encoding='utf-8') as f:
    f.write(x)

print(f"\n玄铁.xt: {changes_x} changes applied")
print("All fixes applied!")
