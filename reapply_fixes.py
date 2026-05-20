#!/usr/bin/env python3
"""Re-apply all fixes to 编译.xt"""
with open('xuantie_compiler/编译.xt', 'r', encoding='utf-8') as f:
    content = f.read()

changes = 0

# 1. Delete debug print
old = '                示("[弱赋值查] 型名=" & 型名 & " 表含型=" & 此.弱引用字段表.含?(型名))\n'
if old in content:
    content = content.replace(old, '')
    changes += 1
    print('+ Deleted debug print')

# 2. Fix 終→止
old2 = '设 始 = 0 ; 设 终 = 0'
if old2 in content:
    content = content.replace(old2, '设 始 = 0 ; 设 止 = 0')
    content = content.replace('{ 終 = kk2 ', '{ 止 = kk2 ')
    content = content.replace('且 終 > 始 { 返 清理.截取(始+1, 終)', '且 止 > 始 { 返 清理.截取(始+1, 止)')
    changes += 1
    print('+ Fixed 終→止')

# 3. Remove xt_retain_forever(此) from constructor
old3 = '    函 造() {\n        xt_retain_forever(此)\n        此.結果输出列表 = []'
new3 = '    函 造() {\n        此.結果输出列表 = []'
if old3 in content:
    content = content.replace(old3, new3)
    changes += 1
    print('+ Removed xt_retain_forever(此)')
else:
    # Try alternate encoding
    old3b = '    函 造() {\n        xt_retain_forever(此)\n        此.结果输出列表 = []'
    new3b = '    函 造() {\n        此.结果输出列表 = []'
    if old3b in content:
        content = content.replace(old3b, new3b)
        changes += 1
        print('+ Removed xt_retain_forever(此) [alt]')

# 4. Add entry alloca field
old4 = '    設 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n\n    函 造() {'
new4 = '    設 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n    設 入口alloca列表 // 函数入口处延迟写入的 alloca 行，确保 LLVM 支配性\n\n    函 造() {'
if old4 in content:
    content = content.replace(old4, new4)
    changes += 1
    print('+ Added 入口alloca field')
else:
    # Try with 设 instead
    old4b = '    设 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n\n    函 造() {'
    new4b = '    设 全局声明列表 // 闭包捕获等场景需要的额外全局变量声明\n    设 入口alloca列表 // 函数入口处延迟写入的 alloca 行，确保 LLVM 支配性\n\n    函 造() {'
    if old4b in content:
        content = content.replace(old4b, new4b)
        changes += 1
        print('+ Added 入口alloca field [simplified]')

# 5. Add entry alloca init
old5 = '        此.全局声明列表 = []\n\n        // 初始化内置全局符号映射'
new5 = '        此.全局声明列表 = []\n        此.入口alloca列表 = []\n\n        // 初始化内置全局符号映射'
if old5 in content:
    content = content.replace(old5, new5)
    changes += 1
    print('+ Added 入口alloca init')

# 6. Fix == / != operator overloading skip (MOST IMPORTANT)
old14 = '''            // 标量快速路径：已知不是堆对象，直接走原生指令
            若 此.是标量类型(左类型) 且 此.是标量类型(右类型) {
                返 此.编译内建中缀(节点, 左寄存器, 左类型, 右寄存器, 右类型)
            }
            設 鍵Xt = 此.获取字符串对象(魔术方法)'''
new14 = '''            // 标量快速路径：已知不是堆对象，直接走原生指令
            若 此.是标量类型(左类型) 且 此.是标量类型(右类型) {
                返 此.编译内建中缀(节点, 左寄存器, 左类型, 右寄存器, 右类型)
            }
            // == 和 != 对非标量类型直接走内建路径（xt_eq），
            // 避免运算符重载产生的内联 alloca 在 3+ 若/抑 条件下导致运行时堆损坏
            若 节点.中缀运算符 == "==" 或 节点.中缀运算符 == "!=" {
                返 此.编译内建中缀(节点, 左寄存器, 左类型, 右寄存器, 右类型)
            }
            設 鍵Xt = 此.获取字符串对象(魔术方法)'''
if old14 in content:
    content = content.replace(old14, new14)
    changes += 1
    print('+ Added ==/!= operator overloading skip')
else:
    # Try with 设 variant
    old14b = '''            // 标量快速路径：已知不是堆对象，直接走原生指令
            若 此.是标量类型(左类型) 且 此.是标量类型(右类型) {
                返 此.编译内建中缀(节点, 左寄存器, 左类型, 右寄存器, 右类型)
            }
            设 键Xt = 此.获取字符串对象(魔术方法)'''
    if old14b in content:
        content = content.replace(old14b, new14)
        changes += 1
        print('+ Added ==/!= operator overloading skip [alt]')

with open('xuantie_compiler/编译.xt', 'w', encoding='utf-8') as f:
    f.write(content)

print(f'\nTotal: {changes} changes applied (out of 6 attempted)')
